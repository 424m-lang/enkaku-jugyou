import { useEffect } from 'react';
import type { EndLessonCheck } from '@shared';

/**
 * 日付と時刻（例: 10月6日 9:11）。今日の時刻でも日付を付ける。
 * 終了を押し忘れた授業では、提案する時刻が前日以前のこともあるため
 */
function fmtDateTime(epochMs: number): string {
  const d = new Date(epochMs);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 経過時間（例: 45分、21時間15分） */
function fmtGap(ms: number): string {
  const min = Math.max(0, Math.floor(ms / 60_000));
  if (min < 60) return `${min}分`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h}時間` : `${h}時間${m}分`;
}

type Props = {
  check: EndLessonCheck & { suggestedEndMs: number };
  busy: boolean;
  /** endMs は授業開始からのms。null なら今の時刻で終える */
  onEnd: (endMs: number | null) => void;
  onCancel: () => void;
};

/**
 * 「授業を終了」を押したとき、最後の授業の動きから間が空いていた場合の確認。
 * 終了の押し忘れなら候補の時刻を、テストなどで授業が続いていたなら今の時刻を選ぶ
 */
export default function EndLessonDialog({ check, busy, onEnd, onCancel }: Props) {
  const last = fmtDateTime(check.startedAtEpochMs + check.lastActivityMs);
  const suggested = fmtDateTime(check.startedAtEpochMs + check.suggestedEndMs);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onCancel]);

  return (
    <div className="modal-backdrop" onClick={() => !busy && onCancel()}>
      <div
        className="modal end-lesson-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="end-lesson-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="end-lesson-title">授業の終了時刻を選んでください</h2>
        <p>
          <strong>{last}</strong>のあと、授業の動き（スライドの操作・書き込み・生徒の反応など）が
          {fmtGap(check.quietMs)}記録されていません。
        </p>
        <p>
          <strong>{suggested}</strong>を選ぶと、授業はその時刻に終わったものとして記録されます。
          振り返りと復習動画には、その時刻までの録音と記録が含まれます。
          その時刻より後の録音は削除され、元に戻せません。
        </p>
        <p className="muted end-lesson-note">
          候補の時刻は、最後の動きのあとも録音に声が続いていた場合、その終わりまで延ばしてあります。
          テストや個人作業などで授業が続いていた場合は、今の時刻を選んでください。
        </p>
        <div className="end-lesson-actions">
          <button className="btn primary" disabled={busy} onClick={() => onEnd(check.suggestedEndMs)}>
            {suggested}に終わったことにする
          </button>
          <button className="btn" disabled={busy} onClick={() => onEnd(null)}>
            今の時刻で終了する
          </button>
          <button className="btn-link" disabled={busy} onClick={onCancel}>
            キャンセル
          </button>
        </div>
      </div>
    </div>
  );
}
