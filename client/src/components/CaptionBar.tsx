import { useCallback, useEffect, useRef, useState } from 'react';
import type { CaptionLine } from '@shared';

/**
 * 自動字幕の表示。
 *
 * ライブのバンドはブラウザ音声認識の結果だけを流す。Whisperの確定テキストを
 * ここへ差し込まないのは、訂正が届く頃には読み手が先へ進んでいて、書き換えが
 * かえって流れを切るため。用語が正しい版は履歴側で読める。
 *
 * バンドを2行に抑えているのは、訂正の文脈を抱える必要がないから。
 * 読み返したい人はタップして履歴を開く。そのときスライドは隠れてよい
 * （字幕を集中して読んでいる人は、その瞬間スライドの細部を見ていない）。
 */

type LiveLine = { tMs: number; text: string };

type Props = {
  /** 確定した直近の行（古い順） */
  lines: LiveLine[];
  /** 認識途中の文字列。薄く出して「まだ確定していない」ことを見せる */
  interim: string;
  /** 履歴を取りに行く。開いたときだけ呼ぶ */
  loadHistory: () => Promise<CaptionLine[]>;
  /** 字幕を閉じる（生徒が自分で切れるようにする） */
  onHide?: () => void;
  /** 教室の大画面用。文字を大きくする */
  large?: boolean;
};

function mmss(tMs: number): string {
  const total = Math.max(0, Math.floor(tMs / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export default function CaptionBar({ lines, interim, loadHistory, onHide, large }: Props) {
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState<CaptionLine[] | null>(null);
  const [loading, setLoading] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const openHistory = useCallback(async () => {
    setOpen(true);
    setLoading(true);
    try {
      setHistory(await loadHistory());
    } catch {
      setHistory([]);
    } finally {
      setLoading(false);
    }
  }, [loadHistory]);

  // 開いたら最新（下端）を見せる。読み返したい人はそこから上へ辿る
  useEffect(() => {
    if (!open || loading || !listRef.current) return;
    listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [open, loading, history]);

  if (open) {
    const confirmed = history?.filter((l) => l.source === 'whisper').length ?? 0;
    return (
      <div className="caption-history">
        <div className="caption-history-head">
          <strong>字幕の履歴</strong>
          <span className="muted small">
            {loading ? '読み込み中…' : `${history?.length ?? 0}行（うち${confirmed}行は確定）`}
          </span>
          <button className="btn" onClick={() => setOpen(false)}>
            閉じる
          </button>
        </div>
        <div className="caption-history-list" ref={listRef}>
          {!loading && (history?.length ?? 0) === 0 && (
            <p className="muted">まだ字幕がありません。</p>
          )}
          {history?.map((l, i) => (
            <p key={`${l.tMs}-${i}`} className={l.source === 'live' ? 'caption-line live' : 'caption-line'}>
              <span className="caption-time">{mmss(l.tMs)}</span>
              <span>{l.text}</span>
            </p>
          ))}
        </div>
        <p className="caption-history-note">
          薄い行はまだ確定していません。少し経つと、専門用語まで直った文に置き換わります。
        </p>
      </div>
    );
  }

  // ---- ライブのバンド ----
  const recent = lines.slice(-2);
  const empty = recent.length === 0 && !interim;
  return (
    <div className={large ? 'caption-bar caption-bar-large' : 'caption-bar'}>
      <button
        type="button"
        className="caption-bar-text"
        onClick={openHistory}
        title="タップすると履歴を開きます"
      >
        {empty ? (
          <span className="caption-waiting">自動字幕：先生が話すとここに出ます</span>
        ) : (
          <>
            {recent.map((l, i) => (
              <span key={`${l.tMs}-${i}`} className="caption-final">
                {l.text}
              </span>
            ))}
            {interim && <span className="caption-interim">{interim}</span>}
          </>
        )}
      </button>
      <div className="caption-bar-actions">
        <button type="button" className="caption-bar-btn" onClick={openHistory} title="履歴">
          ▲
        </button>
        {onHide && (
          <button type="button" className="caption-bar-btn" onClick={onHide} title="字幕を消す">
            ×
          </button>
        )}
      </div>
    </div>
  );
}
