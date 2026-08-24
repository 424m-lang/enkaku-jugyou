/**
 * MediaSource(MSE)でチャンクを逐次追加して再生するライブプレイヤー。
 * 先生のMediaRecorderが吐くWebMチャンクをそのまま流し込む前提で、
 * 音声のみのストリームにもカメラ映像（音声込み）にも同じ仕組みを使う。
 *
 * - init（WebMヘッダ）を受け取るたびにデコーダを初期化し直す
 * - バッファが遅延しすぎたらライブエッジ付近へシークして遅延を回復する
 */
export class LiveMediaPlayer {
  protected el: HTMLMediaElement;
  private mime: string;
  private mediaSource: MediaSource | null = null;
  private sourceBuffer: SourceBuffer | null = null;
  private queue: ArrayBuffer[] = [];
  private objectUrl: string | null = null;
  enabled = false;

  constructor(el: HTMLMediaElement, mime: string) {
    this.el = el;
    this.mime = mime;
  }

  /** ユーザー操作（タップ）を起点に呼ぶこと（自動再生制限のため） */
  enable(): void {
    this.enabled = true;
    void this.el.play().catch(() => {});
  }

  /**
   * 鳴らすかどうかだけを切り替える（受信とデコードは続ける）。
   * 教室モードの切替でストリームを張り直すと音が途切れるため、ミュートで切り替える。
   */
  setMuted(muted: boolean): void {
    this.el.muted = muted;
  }

  reset(initChunk: ArrayBuffer): void {
    this.dispose();
    const ms = new MediaSource();
    this.mediaSource = ms;
    this.objectUrl = URL.createObjectURL(ms);
    this.el.src = this.objectUrl;
    this.queue = [initChunk];
    ms.addEventListener('sourceopen', () => {
      if (this.mediaSource !== ms) return;
      const sb = ms.addSourceBuffer(this.mime);
      this.sourceBuffer = sb;
      sb.addEventListener('updateend', () => this.pump());
      this.pump();
    });
    if (this.enabled) void this.el.play().catch(() => {});
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
            sb.remove(buffered.start(0), Math.max(buffered.start(0) + 1, this.el.currentTime - 10));
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
    if (this.el.currentTime < end - 3) {
      this.el.currentTime = Math.max(buffered.start(buffered.length - 1), end - 0.8);
    } else if (this.el.paused && this.enabled) {
      void this.el.play().catch(() => {});
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
