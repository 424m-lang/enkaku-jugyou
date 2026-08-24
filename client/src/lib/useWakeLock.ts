import { useEffect } from 'react';

type WakeLockLike = { release: () => Promise<void> };

/**
 * 授業中に画面が暗くならないようにする。
 *
 * 3つの画面すべてで要る:
 * - 教室の大画面: 投影が消えると授業が止まる
 * - 先生画面: 操作の合間に暗転すると配信の状態が見えなくなる
 * - 生徒画面: スライドを見ているだけの時間が長く、触らないので自動ロックされやすい
 *
 * Wake Lock API は対応していない環境（古いiOSやテレビ内蔵ブラウザ）や、
 * 権限で取れない環境がある。取れなくても授業は続くので、失敗は無視する。
 *
 * @param active 授業中だけ有効にしたい場合に false を渡すとロックを解放する
 */
export function useWakeLock(active = true): void {
  useEffect(() => {
    if (!active) return;
    const nav = navigator as Navigator & {
      wakeLock?: { request: (type: 'screen') => Promise<WakeLockLike> };
    };
    const wakeLock = nav.wakeLock;
    if (!wakeLock) return;

    let lock: WakeLockLike | null = null;
    let disposed = false;
    const acquire = async () => {
      try {
        const next = await wakeLock.request('screen');
        if (disposed) void next.release().catch(() => {});
        else lock = next;
      } catch {
        /* 権限やブラウザの制限で取れないことがある。取れなくても授業は続く */
      }
    };
    void acquire();
    // タブが裏に回るとロックは自動的に解除されるので、戻ったら取り直す
    const onVisible = () => {
      if (document.visibilityState === 'visible') void acquire();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', onVisible);
      void lock?.release().catch(() => {});
    };
  }, [active]);
}
