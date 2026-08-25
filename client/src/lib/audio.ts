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
/**
 * この時間ぶん1バイトも出てこなければ、その形式は使えないと判断する。
 *
 * **ChromeのAACは、入力が48kHzでないと何も吐かない**（24kHz・16kHzで実測0kbps。
 * エラーも例外も出ない）。マイクによっては48kHz以外で入ってくることがあり、
 * そのときは**授業まるごと無音**になる。黙って無音になるより、
 * 再生できない端末が出てもWebM/Opusに切り替えたほうがましなので、
 * 出てこないことを検知して切り替える
 */
const NO_DATA_MS = 3_000;

/** 別系統の形式（AACが駄目ならOpus、Opusが駄目ならAAC）を探す */
function fallbackMime(current: string): string | null {
  const wantMp4 = !current.startsWith('audio/mp4');
  for (const mime of AUDIO_MIME_CANDIDATES) {
    if (mime.startsWith('audio/mp4') !== wantMp4) continue;
    if (MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return null;
}

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
  let recorder: MediaRecorder | null = null;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let switched = false; // 切り替えは一度だけ（往復させない）

  const start = (mime: string | undefined) => {
    const rec = new MediaRecorder(stream, {
      mimeType: mime,
      audioBitsPerSecond: 48_000, // 音声主体の授業に十分な品質と帯域のバランス
    });
    // ブラウザが指定と違う形式を選ぶことがあるため、宣言ではなく実物を受け手に伝える
    const actual = rec.mimeType || mime || '';
    let got = false;
    rec.ondataavailable = (e) => {
      if (e.data.size === 0 || stopped || recorder !== rec) return;
      got = true;
      if (watchdog) {
        clearTimeout(watchdog);
        watchdog = null;
      }
      void e.data.arrayBuffer().then((buf) => {
        if (!stopped && recorder === rec) socket.emit('audio_chunk', buf, actual);
      });
    };
    rec.start(CHUNK_MS);
    recorder = rec;

    // 何も出てこないまま時間が過ぎたら、別の形式に切り替える
    watchdog = setTimeout(() => {
      if (got || stopped || switched || recorder !== rec) return;
      const alt = fallbackMime(actual);
      if (!alt) return; // 代わりが無いなら、そのまま様子を見るしかない
      switched = true;
      recorder = null;
      if (rec.state !== 'inactive') rec.stop();
      start(alt);
    }, NO_DATA_MS);
  };

  start(supportedAudioMime() ?? undefined);

  return {
    stop() {
      stopped = true;
      if (watchdog) clearTimeout(watchdog);
      const rec = recorder;
      recorder = null;
      if (rec && rec.state !== 'inactive') rec.stop();
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
