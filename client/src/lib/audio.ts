import type { AppSocket } from './socket';
import { LiveMediaPlayer } from './liveMedia';

/**
 * 送信に使う形式を対応の広い順に並べる。
 *
 * AAC/MP4 を先頭にしているのは再生側の都合。Safari（iPad・Mac・Apple TV）と
 * テレビ内蔵ブラウザのMSEはWebMを再生できず、AAC/MP4しか受け付けない。
 * 一方でChrome・Edge・FirefoxはどちらもMSEで再生できるため、
 * AACで送れる環境ならAACで送るのが最も多くの端末に届く。
 * AACで録音できない環境（Firefoxなど）だけがWebM/Opusに落ちる。
 */
const AUDIO_MIME_CANDIDATES = [
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
  'audio/webm;codecs=opus',
  'audio/webm',
];

const CHUNK_MS = 500;

/** この環境で録音に使える形式。無ければ null（音声を配信できない） */
export function supportedAudioMime(): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const mime of AUDIO_MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return null;
}

/**
 * 先生側: マイク音声を低遅延エンコードし、500msごとのチャンクとして送信する。
 * MediaRecorderはソケット切断中も動き続け、Socket.IOのクライアントバッファに
 * 溜まったチャンクは再接続時にまとめて送信される（録音の欠落を防ぐ）。
 *
 * 実際に使われた形式は recorder.mimeType から読み取ってチャンクと一緒に送る。
 * ブラウザが指定と違う形式を選ぶことがあるため、宣言ではなく実物を信用する。
 */
export async function startAudioBroadcast(socket: AppSocket): Promise<{ stop: () => void }> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
  });
  const preferred = supportedAudioMime();
  const recorder = new MediaRecorder(stream, {
    mimeType: preferred ?? undefined,
    audioBitsPerSecond: 48_000, // 音声主体の授業に十分な品質と帯域のバランス
  });
  const mime = recorder.mimeType || preferred || '';
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) {
      void e.data.arrayBuffer().then((buf) => socket.emit('audio_chunk', buf, mime));
    }
  };
  recorder.start(CHUNK_MS);
  return {
    stop() {
      if (recorder.state !== 'inactive') recorder.stop();
      stream.getTracks().forEach((t) => t.stop());
    },
  };
}

/** 生徒・大画面側: 音声のみのライブストリームを再生する */
export class LiveAudioPlayer extends LiveMediaPlayer {
  constructor(el: HTMLAudioElement) {
    super(el);
  }
}
