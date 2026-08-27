import type { VideoFormat } from '@shared';
import type { AppSocket } from './socket';
import { LiveMediaPlayer } from './liveMedia';
import { startLowLatencyMp4, lowLatencyMp4Supported, type LowLatencyMp4 } from './lowLatencyMp4';

/**
 * 先生のカメラ映像（顔・手元の実演）を教室モニターへ届けるための配信。
 *
 * 音声を別ストリームにすると口の動きと声が0.5〜1秒ずれてしまうため、
 * 映像と音声を1本のストリームにまとめて送る。文字起こし用の音声のみの配信は
 * これとは別に動き続けており、こちらは録音・保存もしない（ライブ限定）。
 */

/**
 * 送信に使う組み合わせ。形式ごとに、対応の広い順に並べる。
 *
 * どの形式を流すかは**受け手が決める**（サーバが `av_formats` で伝えてくる）。
 * 全員がWebMを再生できるならWebMだけ、Apple系（Safari＝iPad・Mac・Apple TV、
 * テレビ内蔵ブラウザ）だけならMP4だけ、**混ざっていれば両方を同時に流す**。
 *
 * 片方に決め打ちしない理由: ChromeのMediaRecorderはMP4だと**キーフレーム単位でしか
 * 断片を切らない**ため、timesliceに500msを指定しても実際には約4.1秒ごとにしか
 * データが出てこない。同一条件の実測で総遅延は WebM 1.4秒 / MP4 5.3秒。
 * 全体をMP4に落とすと、Apple系が1台混じるだけで**全員が4秒損をする**。
 * 2本流す分、先生の端末の負荷と上り通信量は増えるが、それは混在時だけで済む。
 *
 * なおMP4は、使える環境ではWebCodecsで自前に組み立てて断片を0.5秒ごとに切る
 * （`lowLatencyMp4.ts`）。ここのMediaRecorderは、それが使えない環境の受け皿。
 *
 * 音声のみの配信にはこの問題が無い（AACでも約0.5秒ごとに出る）ので、そちらはMP4優先のまま。
 *
 * baseline profile（avc1.42E01E）は最も対応の広いプロファイル。
 */
const VIDEO_MIME_CANDIDATES: Record<VideoFormat, string[]> = {
  webm: ['video/webm;codecs="vp8,opus"', 'video/webm;codecs="vp9,opus"', 'video/webm'],
  mp4: [
    'video/mp4;codecs="avc1.42E01E,mp4a.40.2"',
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4',
  ],
};

const CHUNK_MS = 500;
/** 授業の実演が見える範囲で通信量を抑える（720pの動きの少ない映像を想定） */
const VIDEO_BITS_PER_SECOND = 900_000;

/**
 * この環境で送信に使える形式。無ければこの端末からは映像を配信できない。
 *
 * 以前は「送信と再生の両方ができる形式」を選んでいたが、再生するのは受け手であって
 * 先生の端末ではない。先生の環境でたまたま再生できるかどうかで形式を決めると、
 * 受け手にとって不利な形式を選んでしまうため、送信できるかだけで判断する。
 */
export function supportedVideoMime(format?: VideoFormat): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  const families: VideoFormat[] = format ? [format] : ['webm', 'mp4'];
  for (const f of families) {
    for (const mime of VIDEO_MIME_CANDIDATES[f]) {
      if (MediaRecorder.isTypeSupported(mime)) return mime;
    }
  }
  // 指定の形式で録れない環境（例: Firefoxにmp4を求めた）は、録れる方に落として配信は続ける
  return format ? supportedVideoMime() : null;
}

/** Uint8Array を、送信でそのまま使える ArrayBuffer にする（余った領域を含めない） */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export type CameraOption = { deviceId: string; label: string };

/**
 * 使えるカメラの一覧。
 * ラベルはカメラの許可を一度得るまで空になるため、その場合は通し番号で表示する。
 */
export async function listCameras(): Promise<CameraOption[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((d) => d.kind === 'videoinput')
    .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `カメラ ${i + 1}` }));
}

export type CameraBroadcast = {
  stop: () => void;
  /**
   * いま流す形式の組を指定する。受け手の顔ぶれが変わるとサーバから指示が来る。
   * カメラは取り直さず録画器だけ足し引きするので、先生の手元の映像は途切れない
   */
  setFormats: (formats: VideoFormat[]) => void;
  /** 先生の手元に自分の映像を映すためのストリーム */
  stream: MediaStream;
  /**
   * このストリームに音声が入っているか。
   * マイクが使えないときは映像だけで配信を続けるが、その場合は受け手が
   * 音声のみのストリームを鳴らし続ける必要があるので、状態として伝える。
   */
  hasAudio: boolean;
};

export async function startCameraBroadcast(
  socket: AppSocket,
  deviceId?: string,
  formats: VideoFormat[] = ['webm']
): Promise<CameraBroadcast> {
  if (!supportedVideoMime()) throw new Error('この端末では映像の配信に対応していません');

  const video: MediaTrackConstraints = {
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 24 },
  };

  let stream: MediaStream;
  try {
    // 教室モニターはこの1本から音を鳴らすので、映像と同じストリームに音声も入れる
    // （別ストリームにすると口の動きと声がずれる）
    stream = await navigator.mediaDevices.getUserMedia({
      video,
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });
  } catch {
    // マイクが使えない環境でも映像だけは見せられるようにする
    stream = await navigator.mediaDevices.getUserMedia({ video });
  }
  const hasAudio = stream.getAudioTracks().length > 0;

  // 形式ごとの配信。同じMediaStreamから同時に何本でも録れる
  const recorders = new Map<VideoFormat, { stop: () => void; gen: number }>();
  // 世代番号。止めた録画器が最後に吐くチャンクを、新しい配信に混ぜないための目印
  let generation = 0;
  let stopped = false;

  const startMediaRecorder = (f: VideoFormat, gen: number) => {
    const mime = supportedVideoMime(f);
    if (!mime) return;
    const rec = new MediaRecorder(stream, {
      mimeType: mime,
      videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
      audioBitsPerSecond: 48_000,
    });
    // ブラウザが指定と違う形式を選ぶことがあるため、宣言ではなく実物を受け手に伝える
    const actualMime = rec.mimeType || mime;
    rec.ondataavailable = (e) => {
      if (e.data.size === 0 || recorders.get(f)?.gen !== gen) return;
      void e.data.arrayBuffer().then((buf) => {
        if (recorders.get(f)?.gen !== gen) return;
        // ライブ映像は古い欠片を再送しても遅延が増えるだけなので通常の断片は破棄可能にする。
        // デコーダ初期化用の先頭だけは落とせないため、確実に送る。
        if (isInitSegment(buf)) socket.emit('av_chunk', buf, actualMime);
        else socket.volatile.emit('av_chunk', buf, actualMime);
      });
    };
    rec.start(CHUNK_MS);
    recorders.set(f, {
      gen,
      stop: () => {
        if (rec.state !== 'inactive') rec.stop();
      },
    });
  };

  /**
   * MP4はWebCodecsで組み立てる。キーフレームを自分で打てるので断片が0.5秒ごとになり、
   * MediaRecorderの約4.1秒から大きく縮む。使えない環境・失敗した場合はMediaRecorderへ。
   */
  const startWebCodecsMp4 = (gen: number) => {
    // 先に席だけ取っておく。準備中に setFormats が来ても二重に立ち上げない
    recorders.set('mp4', { gen, stop: () => {} });
    void startLowLatencyMp4({
      stream,
      bitrate: VIDEO_BITS_PER_SECOND,
      onSegment: (bytes, mime, isInit) => {
        if (recorders.get('mp4')?.gen !== gen) return;
        const buf = toArrayBuffer(bytes);
        if (isInit) socket.emit('av_chunk', buf, mime);
        else socket.volatile.emit('av_chunk', buf, mime);
      },
      onFailure: () => {
        // 途中で符号化に失敗しても授業は続くので、黙って従来の経路に戻す
        if (recorders.get('mp4')?.gen !== gen || stopped) return;
        startMediaRecorder('mp4', gen);
      },
    })
      .then((session: LowLatencyMp4 | null) => {
        if (!session) {
          if (recorders.get('mp4')?.gen === gen && !stopped) startMediaRecorder('mp4', gen);
          return;
        }
        if (recorders.get('mp4')?.gen !== gen || stopped) {
          session.stop(); // 準備している間に止められていた
          return;
        }
        recorders.set('mp4', { gen, stop: () => session.stop() });
      })
      .catch(() => {
        if (recorders.get('mp4')?.gen === gen && !stopped) startMediaRecorder('mp4', gen);
      });
  };

  const startRecorder = (f: VideoFormat) => {
    const gen = ++generation;
    if (f === 'mp4' && lowLatencyMp4Supported()) startWebCodecsMp4(gen);
    else startMediaRecorder(f, gen);
  };

  const stopRecorder = (f: VideoFormat) => {
    const entry = recorders.get(f);
    if (!entry) return;
    recorders.delete(f); // 先に外す。止めたあとの最後のチャンクはもう送らない
    entry.stop();
  };

  /**
   * 流す形式を want に合わせる。
   *
   * want をそのまま使わないのは、**この端末で録れる形式が違うことがある**ため。
   * 例えばSafariはWebMを録れないので、WebMを求められてもMP4に落ちる。
   * 求められた形式のままキーにすると、WebMとMP4の両方を求められたときに
   * MP4の録画器が2本立ち上がり、同じ部屋に2系統が混ざって再生できなくなる。
   * 実際に録れる形式に読み替えてから集合にすることで、それが起きないようにする。
   */
  const apply = (want: VideoFormat[]) => {
    const actual = new Set<VideoFormat>();
    for (const f of want) {
      const mime = supportedVideoMime(f);
      if (mime) actual.add(mime.startsWith('video/mp4') ? 'mp4' : 'webm');
    }
    for (const f of [...recorders.keys()]) {
      if (!actual.has(f)) stopRecorder(f);
    }
    for (const f of actual) {
      if (!recorders.has(f)) startRecorder(f);
    }
  };

  apply(formats.length > 0 ? formats : ['webm']);

  return {
    stream,
    hasAudio,
    setFormats(want: VideoFormat[]) {
      if (stopped) return;
      // 受け手がまだ誰もいなくても、繋がった瞬間に映るように1本は流しておく
      apply(want.length > 0 ? want : ['webm']);
    },
    stop() {
      stopped = true;
      for (const f of [...recorders.keys()]) stopRecorder(f);
      stream.getTracks().forEach((t) => t.stop());
    },
  };
}

/** MediaRecorderの先頭断片（WebMのEBML / MP4のftyp）だけは確実に送るための判定 */
function isInitSegment(buf: ArrayBuffer): boolean {
  const b = new Uint8Array(buf);
  return (
    (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) ||
    (b.length >= 8 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70)
  );
}

/** 教室モニター・遠方の生徒側: カメラ映像（音声込み）を再生する */
export class LiveVideoPlayer extends LiveMediaPlayer {
  constructor(el: HTMLVideoElement) {
    super(el);
  }
}
