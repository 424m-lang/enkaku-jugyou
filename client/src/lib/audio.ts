import type { AudioFormat } from '@shared';
import type { AppSocket } from './socket';
import { LiveMediaPlayer } from './liveMedia';

/**
 * 音声は受け手ごとに形式を選ぶ。
 *
 * - WebM/Opus: 通信量が少ないため標準
 * - MP4/AAC: Opusをライブ再生できないApple系・テレビ系端末の受け皿
 */
const AUDIO_MIME_CANDIDATES: Record<AudioFormat, string[]> = {
  webm: ['audio/webm;codecs=opus', 'audio/webm'],
  mp4: ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4'],
};

const CHUNK_MS = 500;
/** 1バイトも出なければ、対応判定が誤っていたものとしてその形式を停止する */
const NO_DATA_MS = 3_000;
/**
 * 一度失敗した形式を、もう一度だけ試すまでの待ち時間。
 *
 * マイクが立ち上がる最初の数秒だけデータが出ないことがあり、そこで諦めると
 * **本当は使える形式が授業中ずっと使われないまま**になる（Opusが落ちると
 * AACへ切り替わり、生徒側の通信量が増える）。落ち着いた頃に1回だけ試し直す。
 * 2回目も駄目なら、その端末では本当に作れないものとして諦める。
 */
const RETRY_AFTER_MS = 15_000;

/** 指定形式をこの先生端末で録音できるか。形式を省略した場合はOpusを優先する */
export function supportedAudioMime(format?: AudioFormat): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  const formats: AudioFormat[] = format ? [format] : ['webm', 'mp4'];
  for (const f of formats) {
    for (const mime of AUDIO_MIME_CANDIDATES[f]) {
      if (MediaRecorder.isTypeSupported(mime)) return mime;
    }
  }
  return null;
}

export type AudioBroadcast = {
  stop: () => void;
  /** 受け手の顔ぶれが変わったとき、マイクは取り直さず録音器だけ足し引きする */
  setFormats: (formats: AudioFormat[]) => void;
  /** サーバ再起動後に、全形式のinitチャンクを出し直す */
  restart: () => void;
};

type AudioBroadcastOptions = {
  /** 実際には1バイトも作れなかった形式。AAC無音を先生画面へ出すために使う */
  onUnavailable?: (format: AudioFormat) => void;
  /** 一度失敗した形式が、試し直しで使えるようになったとき。警告を消すために使う */
  onAvailable?: (format: AudioFormat) => void;
};

/**
 * 先生側: 1本のマイクから、必要な音声形式だけを並行して送信する。
 *
 * 受け手が全員Opus対応ならWebMだけ、AAC専用端末が混じった間だけMP4も動かす。
 * 授業後の文字起こし用録音を受け手の出入りで途切れさせないため、受け手が0人でも
 * Opus（先生端末が非対応ならAAC）の1本は記録用として常に維持する。
 */
export async function startAudioBroadcast(
  socket: AppSocket,
  formats: AudioFormat[] = ['webm'],
  options: AudioBroadcastOptions = {}
): Promise<AudioBroadcast> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
  });

  const initialArchiveFormat: AudioFormat | null = supportedAudioMime('webm')
    ? 'webm'
    : supportedAudioMime('mp4')
      ? 'mp4'
      : null;
  if (!initialArchiveFormat) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error('この端末では音声の配信に対応していません');
  }

  type RecorderEntry = {
    recorder: MediaRecorder;
    watchdog: ReturnType<typeof setTimeout>;
    generation: number;
  };
  const recorders = new Map<AudioFormat, RecorderEntry>();
  const failed = new Set<AudioFormat>();
  /** 先生画面に「作れません」と出した形式。使えるようになったら取り消す */
  const warned = new Set<AudioFormat>();
  /** 試し直しは形式ごとに1回だけ。何度も繰り返して負荷をかけない */
  const retried = new Set<AudioFormat>();
  const retryTimers = new Map<AudioFormat, ReturnType<typeof setTimeout>>();
  let archiveFormat = initialArchiveFormat;
  let wanted = [...formats];
  let generation = 0;
  let stopped = false;

  const stopRecorder = (format: AudioFormat) => {
    const entry = recorders.get(format);
    if (!entry) return;
    recorders.delete(format);
    clearTimeout(entry.watchdog);
    if (entry.recorder.state !== 'inactive') entry.recorder.stop();
  };

  const desiredFormats = (): Set<AudioFormat> => {
    const desired = new Set<AudioFormat>([archiveFormat]);
    for (const format of wanted) {
      if (!supportedAudioMime(format)) {
        // ブラウザが元から非対応。時間を置いても変わらないので試し直さない
        if (!failed.has(format)) {
          failed.add(format);
          warned.add(format);
          options.onUnavailable?.(format);
        }
        continue;
      }
      if (!failed.has(format)) desired.add(format);
    }
    return desired;
  };

  const startRecorder = (format: AudioFormat) => {
    const mime = supportedAudioMime(format);
    if (!mime || stopped || failed.has(format) || recorders.has(format)) return;
    const myGeneration = ++generation;
    const recorder = new MediaRecorder(stream, {
      mimeType: mime,
      audioBitsPerSecond: 48_000,
    });
    const actualMime = recorder.mimeType || mime;
    let gotData = false;

    recorder.ondataavailable = (event) => {
      if (
        event.data.size === 0 ||
        stopped ||
        recorders.get(format)?.generation !== myGeneration
      ) {
        return;
      }
      if (!gotData) {
        gotData = true;
        // 試し直しで復活した場合、先生画面に出した警告をここで取り消す
        if (warned.delete(format)) options.onAvailable?.(format);
      }
      const entry = recorders.get(format);
      if (entry) clearTimeout(entry.watchdog);
      void event.data.arrayBuffer().then((buffer) => {
        if (!stopped && recorders.get(format)?.generation === myGeneration) {
          socket.emit('audio_chunk', buffer, actualMime, format === archiveFormat);
        }
      });
    };

    const watchdog = setTimeout(() => {
      if (gotData || stopped || recorders.get(format)?.generation !== myGeneration) return;
      failed.add(format);
      stopRecorder(format);
      if (!warned.has(format)) {
        warned.add(format);
        options.onUnavailable?.(format);
      }

      // マイクの立ち上がりでつまずいただけかもしれないので、1回だけ試し直す
      if (!retried.has(format)) {
        retried.add(format);
        retryTimers.set(
          format,
          setTimeout(() => {
            retryTimers.delete(format);
            if (stopped) return;
            failed.delete(format);
            // いま必要とされている形式なら apply() が録音器を立て直す。
            // 誰も要らない形式なら何も起きず、必要になった時点で試される
            apply();
          }, RETRY_AFTER_MS)
        );
      }

      // 記録用の形式が失敗した場合も授業まるごと無音にはしない。
      // 別形式が録れるなら、以後の保存と対応端末への配信をそちらで続ける。
      // なお、試し直しで元の形式が復活しても記録用は戻さない。戻すと録音が
      // もう1つのパートに分かれるだけで、得るものがないため
      if (archiveFormat === format) {
        const alternate: AudioFormat = format === 'webm' ? 'mp4' : 'webm';
        if (supportedAudioMime(alternate) && !failed.has(alternate)) {
          archiveFormat = alternate;
          // すでに受信者向けに動いていた場合も、保存用として新しいinitを出し直す
          if (recorders.has(alternate)) stopRecorder(alternate);
          startRecorder(alternate);
        }
      }
    }, NO_DATA_MS);

    recorders.set(format, { recorder, watchdog, generation: myGeneration });
    recorder.start(CHUNK_MS);
  };

  const apply = () => {
    const desired = desiredFormats();
    for (const format of [...recorders.keys()]) {
      if (!desired.has(format)) stopRecorder(format);
    }
    for (const format of desired) startRecorder(format);
  };

  apply();

  return {
    setFormats(next) {
      if (stopped) return;
      wanted = [...next];
      apply();
    },
    restart() {
      if (stopped) return;
      for (const format of [...recorders.keys()]) stopRecorder(format);
      apply();
    },
    stop() {
      stopped = true;
      for (const timer of retryTimers.values()) clearTimeout(timer);
      retryTimers.clear();
      for (const format of [...recorders.keys()]) stopRecorder(format);
      stream.getTracks().forEach((t) => t.stop());
    },
  };
}

/** 生徒・教室モニター側: 音声のみのライブストリームを再生する */
export class LiveAudioPlayer extends LiveMediaPlayer {
  constructor(el: HTMLAudioElement) {
    super(el);
  }
}
