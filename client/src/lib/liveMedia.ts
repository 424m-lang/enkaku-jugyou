/**
 * MediaSource(MSE)でチャンクを逐次追加して再生するライブプレイヤー。
 * 先生のMediaRecorderが吐くチャンクをそのまま流し込む前提で、
 * 音声のみのストリームにもカメラ映像（音声込み）にも同じ仕組みを使う。
 *
 * 形式(mime)は先生の環境によって変わる（AAC/MP4かOpus/WebM）ため、
 * ここでは固定せず、init チャンクと一緒にサーバから受け取ったものを使う。
 *
 * - init を受け取るたびにデコーダを初期化し直す
 * - ライブエッジからの遅れを常に詰める（少しの遅れは再生速度、大きな遅れはシーク）
 * - その端末で再生できない形式だったときは onUnsupported で知らせる
 *   （教室のモニターが無音のまま放置されるのを防ぐため、必ず表に出す）
 */

type MediaSourceCtor = {
  new (): MediaSource;
  isTypeSupported(mime: string): boolean;
};

/**
 * MSEの実装を取り出す。
 * iPhoneのSafariは MediaSource を持たず ManagedMediaSource だけを持つ（iOS 17.1以降）ので、
 * そちらを優先して拾う。どちらも無い端末では再生できない。
 */
export function getMediaSourceCtor(): MediaSourceCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    ManagedMediaSource?: MediaSourceCtor;
    MediaSource?: MediaSourceCtor;
  };
  return w.ManagedMediaSource ?? w.MediaSource ?? null;
}

/** その端末でこの形式を再生できるか */
export function canPlayMime(mime: string): boolean {
  const Ctor = getMediaSourceCtor();
  if (!Ctor) return false;
  try {
    return Ctor.isTypeSupported(mime);
  } catch {
    return false;
  }
}

/** 目標とする遅れ。これより短いと、受信が少し途切れただけで音が飛ぶ */
const TARGET_LAG_S = 0.6;
/** これ以上遅れたらシークで一気に追いつく */
const HARD_SEEK_S = 1.6;
/** わずかな遅れを詰めるときの再生速度（声の高さの変化が分からない範囲） */
const CATCH_UP_RATE = 1.04;

export class LiveMediaPlayer {
  protected el: HTMLMediaElement;
  private mime: string | null = null;
  private mediaSource: MediaSource | null = null;
  private sourceBuffer: SourceBuffer | null = null;
  private queue: ArrayBuffer[] = [];
  private objectUrl: string | null = null;
  enabled = false;
  /** 再生できない形式だったときに呼ばれる（mimeは受け取った形式） */
  onUnsupported: ((mime: string) => void) | null = null;

  constructor(el: HTMLMediaElement) {
    this.el = el;
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

  reset(initChunk: ArrayBuffer, mime: string): void {
    this.dispose();
    this.el.playbackRate = 1; // 前の配信で追いつき中だった速度を持ち越さない
    const Ctor = getMediaSourceCtor();
    if (!Ctor || !canPlayMime(mime)) {
      // 対応していない端末。黙って無音にせず、呼び出し元に知らせて表示させる
      this.mime = mime;
      this.onUnsupported?.(mime);
      return;
    }
    this.mime = mime;
    const ms = new Ctor();
    this.mediaSource = ms;
    // ManagedMediaSource は外部出力への転送を切っていないと再生できない
    (this.el as HTMLMediaElement & { disableRemotePlayback?: boolean }).disableRemotePlayback = true;
    // ManagedMediaSource は srcObject 経由での接続が正規の手順。
    // 対応していない環境（従来のMediaSource）では objectURL に落とす
    let attached = false;
    try {
      (this.el as HTMLMediaElement & { srcObject: unknown }).srcObject = ms;
      attached = true;
    } catch {
      attached = false;
    }
    if (!attached) {
      this.objectUrl = URL.createObjectURL(ms);
      this.el.src = this.objectUrl;
    }
    this.queue = [initChunk];
    ms.addEventListener('sourceopen', () => {
      if (this.mediaSource !== ms) return;
      let sb: SourceBuffer;
      try {
        sb = ms.addSourceBuffer(mime);
      } catch {
        // isTypeSupported が true でも実際には追加できない端末がある
        this.dispose();
        this.onUnsupported?.(mime);
        return;
      }
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

  /**
   * ライブエッジへの追従。
   *
   * 受信が一瞬詰まるたびに遅れが積み上がり、放っておくと先生の声・映像だけが
   * 数秒遅れたまま戻らない。授業では書き込みやスライド送りが即座に届くので、
   * ここが遅れるほど「いま説明しているところ」とズレて見える。
   *
   * ただしシークは映像が飛んで見えるので、遅れの大きさで対処を分ける。
   * - わずかな遅れ: 再生速度を4%だけ上げて自然に詰める（声の高さの変化は分からない）
   * - 大きな遅れ: シークで一気に追いつく（そのまま速度で詰めると時間がかかりすぎる）
   */
  private catchUp(): void {
    const sb = this.sourceBuffer;
    if (!sb) return;
    const buffered = sb.buffered;
    if (buffered.length === 0) return;
    const end = buffered.end(buffered.length - 1);
    const behind = end - this.el.currentTime;
    if (behind > HARD_SEEK_S) {
      this.el.currentTime = Math.max(buffered.start(buffered.length - 1), end - TARGET_LAG_S);
      this.el.playbackRate = 1;
    } else if (behind > TARGET_LAG_S + 0.25) {
      this.el.playbackRate = CATCH_UP_RATE;
    } else if (this.el.playbackRate !== 1) {
      this.el.playbackRate = 1;
    }
    if (this.el.paused && this.enabled) void this.el.play().catch(() => {});
  }

  dispose(): void {
    this.sourceBuffer = null;
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
    if (this.mediaSource) {
      try {
        (this.el as HTMLMediaElement & { srcObject: unknown }).srcObject = null;
      } catch {
        /* ignore */
      }
    }
    this.mediaSource = null;
    this.queue = [];
  }
}
