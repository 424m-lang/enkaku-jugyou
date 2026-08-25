import type { VideoFormat } from '@shared';
import type { AppSocket } from './socket';
import { LiveMediaPlayer } from './liveMedia';

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
 * どちらを使うかは**受け手が決める**（サーバが `av_format` で伝えてくる）。
 * MP4しか再生できない端末（Safari＝iPad・Mac・Apple TV、テレビ内蔵ブラウザ）が
 * 1台でも繋がればMP4、全員がWebMを再生できるならWebM。
 *
 * WebMを優先したい理由: ChromeのMediaRecorderはMP4だと**キーフレーム単位でしか
 * 断片を切らない**ため、timesliceに500msを指定しても実際には約4.1秒ごとにしか
 * データが出てこない。同一条件の実測で総遅延は WebM 1.4秒 / MP4 5.3秒。
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
   * 送信形式を切り替える。受け手の顔ぶれが変わったときにサーバから指示が来る。
   * カメラは取り直さず録画器だけ作り直すので、先生の手元の映像は途切れない
   */
  setFormat: (format: VideoFormat) => void;
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
  format: VideoFormat = 'webm'
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

  let recorder: MediaRecorder | null = null;
  let current: VideoFormat | null = null;
  // 世代番号。古い録画器が stop() 後に吐く最後のチャンクを、新しい配信に混ぜないための目印
  let generation = 0;
  let stopped = false;

  const startRecorder = (f: VideoFormat) => {
    const mime = supportedVideoMime(f);
    if (!mime) return;
    const gen = ++generation;
    const rec = new MediaRecorder(stream, {
      mimeType: mime,
      videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
      audioBitsPerSecond: 48_000,
    });
    // ブラウザが指定と違う形式を選ぶことがあるため、宣言ではなく実物を受け手に伝える
    const actualMime = rec.mimeType || mime;
    rec.ondataavailable = (e) => {
      if (e.data.size === 0 || gen !== generation) return;
      void e.data.arrayBuffer().then((buf) => {
        if (gen === generation) socket.emit('av_chunk', buf, actualMime);
      });
    };
    rec.start(CHUNK_MS);
    recorder = rec;
    current = f;
  };

  startRecorder(format);

  return {
    stream,
    hasAudio,
    setFormat(f: VideoFormat) {
      if (stopped || f === current) return;
      // 先に世代を進めてから止める。stop() の最後のチャンクは新しい配信に混ぜない
      generation++;
      if (recorder && recorder.state !== 'inactive') recorder.stop();
      startRecorder(f);
    },
    stop() {
      stopped = true;
      generation++;
      if (recorder && recorder.state !== 'inactive') recorder.stop();
      stream.getTracks().forEach((t) => t.stop());
    },
  };
}

/** 教室モニター・遠隔の生徒側: カメラ映像（音声込み）を再生する */
export class LiveVideoPlayer extends LiveMediaPlayer {
  constructor(el: HTMLVideoElement) {
    super(el);
  }
}
