import type { ReactionInput } from '@shared';
import type { AppSocket } from './socket';
import { readStored, writeStored } from './storage';

type QueuedReaction = {
  kind: string;
  comment?: string;
  /** 反応の対象スライド（コメントは入力を始めたときのスライド） */
  slideId?: string;
  pressedAtEpochMs: number;
};

/**
 * リアクションのオフラインキュー。
 * 回線断で送信できなかったリアクションを localStorage に保持し、
 * 回線復旧後に「押した時刻」を保ったまま再送する（delayMsで補正）。
 */
export class ReactionQueue {
  private key: string;
  private socket: AppSocket;
  private flushing = false;
  private onChange: (count: number) => void;
  private readonly onConnect = () => void this.flush();
  private readonly onOnline = () => void this.flush();

  constructor(
    lessonId: string,
    participantId: string,
    socket: AppSocket,
    onChange: (count: number) => void = () => {}
  ) {
    // 同じ端末を別の生徒が使っても、前の生徒の未送信反応を引き継がない。
    this.key = `reactionQueue:${lessonId}:${participantId}`;
    this.socket = socket;
    this.onChange = onChange;
    socket.on('connect', this.onConnect);
    window.addEventListener('online', this.onOnline);
  }

  private load(): QueuedReaction[] {
    try {
      const parsed: unknown = JSON.parse(readStored('local', this.key) ?? '[]');
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((item): item is QueuedReaction => {
        if (!item || typeof item !== 'object') return false;
        const q = item as Partial<QueuedReaction>;
        return (
          typeof q.kind === 'string' &&
          q.kind.length > 0 &&
          q.kind.length <= 40 &&
          typeof q.pressedAtEpochMs === 'number' &&
          Number.isFinite(q.pressedAtEpochMs) &&
          (q.comment === undefined || typeof q.comment === 'string') &&
          (q.slideId === undefined || typeof q.slideId === 'string')
        );
      });
    } catch {
      return [];
    }
  }

  private save(items: QueuedReaction[]): void {
    writeStored('local', this.key, JSON.stringify(items));
    this.onChange(items.length);
  }

  get pendingCount(): number {
    return this.load().length;
  }

  /** 送信。失敗（切断・タイムアウト）した場合はキューに積んで後で再送する */
  async send(kind: string, comment?: string, slideId?: string): Promise<'sent' | 'queued'> {
    const pressedAtEpochMs = Date.now();
    const ok = await this.trySend({ kind, comment, slideId, pressedAtEpochMs });
    if (ok) return 'sent';
    const items = this.load();
    items.push({ kind, comment, slideId, pressedAtEpochMs });
    this.save(items);
    return 'queued';
  }

  private trySend(q: QueuedReaction): Promise<boolean> {
    if (!this.socket.connected) return Promise.resolve(false);
    const input: ReactionInput = {
      kind: q.kind,
      comment: q.comment,
      slideId: q.slideId,
      delayMs: Math.max(0, Date.now() - q.pressedAtEpochMs),
    };
    return new Promise((resolve) => {
      this.socket.timeout(5000).emit('reaction', input, (err, res) => {
        resolve(!err && !!res?.ok);
      });
    });
  }

  async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      let items = this.load();
      while (items.length > 0) {
        const ok = await this.trySend(items[0]);
        if (!ok) break;
        items = items.slice(1);
        this.save(items);
      }
    } finally {
      this.flushing = false;
    }
  }

  dispose(): void {
    this.socket.off('connect', this.onConnect);
    window.removeEventListener('online', this.onOnline);
  }
}
