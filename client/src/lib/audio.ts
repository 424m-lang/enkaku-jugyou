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
        if (!failed.has(format)) {
          failed.add(format);
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
      gotData = true;
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
      options.onUnavailable?.(format);

      // 記録用の形式が失敗した場合も授業まるごと無音にはしない。
      // 別形式が録れるなら、以後の保存と対応端末への配信をそちらで続ける。
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
