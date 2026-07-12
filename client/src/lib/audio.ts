import type { AppSocket } from './socket';

const MIME = 'audio/webm;codecs=opus';
const CHUNK_MS = 500;

/**
 * 先生側: マイク音声をOpusで低遅延エンコードし、500msごとのチャンクとして送信する。
 * MediaRecorderはソケット切断中も動き続け、Socket.IOのクライアントバッファに
 * 溜まったチャンクは再接続時にまとめて送信される（録音の欠落を防ぐ）。
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
  const recorder = new MediaRecorder(stream, {
    mimeType: MediaRecorder.isTypeSupported(MIME) ? MIME : undefined,
    audioBitsPerSecond: 48_000, // 音声主体の授業に十分な品質と帯域のバランス
  });
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) {
      void e.data.arrayBuffer().then((buf) => socket.emit('audio_chunk', buf));
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

/**
 * 生徒側: MediaSource(MSE)でチャンクを逐次追加して再生するライブプレイヤー。
 * - audio_init（WebMヘッダ）を受け取るたびにデコーダを初期化し直す
 * - バッファが遅延しすぎたらライブエッジ付近へシークして遅延を回復する
 */
export class LiveAudioPlayer {
  private audio: HTMLAudioElement;
  private mediaSource: MediaSource | null = null;
  private sourceBuffer: SourceBuffer | null = null;
  private queue: ArrayBuffer[] = [];
  private objectUrl: string | null = null;
  enabled = false;

  constructor(audio: HTMLAudioElement) {
    this.audio = audio;
  }

  /** ユーザー操作（タップ）を起点に呼ぶこと（自動再生制限のため） */
  enable(): void {
    this.enabled = true;
    void this.audio.play().catch(() => {});
  }

  reset(initChunk: ArrayBuffer): void {
    this.dispose();
    const ms = new MediaSource();
    this.mediaSource = ms;
    this.objectUrl = URL.createObjectURL(ms);
    this.audio.src = this.objectUrl;
    this.queue = [initChunk];
    ms.addEventListener('sourceopen', () => {
      if (this.mediaSource !== ms) return;
      const sb = ms.addSourceBuffer(MIME);
      this.sourceBuffer = sb;
      sb.addEventListener('updateend', () => this.pump());
      this.pump();
    });
    if (this.enabled) void this.audio.play().catch(() => {});
  }

  push(chunk: ArrayBuffer): void {
    if (!this.mediaSource) return; // initが来るまで破棄
    this.queue.push(chunk);
    this.pump();
  }

  private pump(): void {
    const sb = this.sourceBuffer;
    if (!sb || sb.updating) return;
    const next = this.queue.shift();
    if (next) {
      try {
        sb.appendBuffer(next);
      } catch {
        // バッファ溢れなど。古い範囲を削除してリトライ
        this.queue.unshift(next);
        const buffered = sb.buffered;
        if (buffered.length > 0 && !sb.updating) {
          try {
            sb.remove(buffered.start(0), Math.max(buffered.start(0) + 1, this.audio.currentTime - 10));
          } catch {
            /* ignore */
          }
        }
        return;
      }
      this.catchUp();
    }
  }

  /** 遅延が3秒を超えたらライブエッジへ追従 */
  private catchUp(): void {
    const sb = this.sourceBuffer;
    if (!sb) return;
    const buffered = sb.buffered;
    if (buffered.length === 0) return;
    const end = buffered.end(buffered.length - 1);
    if (this.audio.currentTime < end - 3) {
      this.audio.currentTime = Math.max(buffered.start(buffered.length - 1), end - 0.8);
    } else if (this.audio.paused && this.enabled) {
      void this.audio.play().catch(() => {});
    }
  }

  dispose(): void {
    this.sourceBuffer = null;
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
    this.mediaSource = null;
    this.queue = [];
  }
}
