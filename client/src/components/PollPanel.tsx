import { useState } from 'react';
import type { LessonStatus, Poll, PollResults, PollType } from '@shared';
import { POLL_TYPE_LABELS } from '@shared';

type Props = {
  polls: Poll[];
  results: Record<string, PollResults>;
  openPollId: string | null;
  status: LessonStatus;
  onSave: (p: {
    id?: string;
    question: string;
    type: PollType;
    options?: { id?: string; label: string }[];
    minLabel?: string | null;
    maxLabel?: string | null;
  }) => void;
  onDelete: (pollId: string) => void;
  onOpen: (pollId: string) => void;
  /** 同じ質問をもう一度聞く。前回の回答を上書きせず、別の回として集計する */
  onRepeat: (poll: Poll) => void;
  onClose: (pollId: string, reveal: boolean) => void;
};

const TYPES: PollType[] = ['single', 'multiple', 'scale', 'text'];

/**
 * 先生画面のアンケートパネル（動作確認できる最小限。表示の作り込みは後で調整する）。
 *
 * 集計は横棒で出し、未回答をグレーとして必ず含める。円グラフだと「回答済みの内訳」
 * しか描けず、12人中3人しか答えていない状態の67%を見誤るため。
 */
export default function PollPanel({
  polls,
  results,
  openPollId,
  status,
  onSave,
  onDelete,
  onOpen,
  onRepeat,
  onClose,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [question, setQuestion] = useState('');
  const [type, setType] = useState<PollType>('single');
  const [options, setOptions] = useState<string[]>(['', '']);
  const [scaleMax, setScaleMax] = useState(5);
  const [minLabel, setMinLabel] = useState('');
  const [maxLabel, setMaxLabel] = useState('');

  const reset = () => {
    setQuestion('');
    setType('single');
    setOptions(['', '']);
    setScaleMax(5);
    setMinLabel('');
    setMaxLabel('');
    setEditing(false);
  };

  const submit = () => {
    if (!question.trim()) return;
    onSave({
      question: question.trim(),
      type,
      options:
        type === 'text'
          ? []
          : type === 'scale'
            ? Array.from({ length: scaleMax }, (_, i) => ({ label: String(i + 1) }))
            : options.filter((o) => o.trim()).map((label) => ({ label: label.trim() })),
      minLabel: type === 'scale' ? minLabel || null : null,
      maxLabel: type === 'scale' ? maxLabel || null : null,
    });
    reset();
  };

  return (
    <div className="card poll-panel">
      <div className="task-panel-head">
        <h3>アンケート</h3>
        <button className="btn-link" onClick={() => (editing ? reset() : setEditing(true))}>
          {editing ? 'やめる' : '＋ 設問を作る'}
        </button>
      </div>

      {editing && (
        <div className="poll-edit">
          <input
            value={question}
            maxLength={200}
            placeholder="質問（例: この式が成り立つのは？）"
            onChange={(e) => setQuestion(e.target.value)}
          />
          <div className="poll-type-row">
            {TYPES.map((t) => (
              <button
                key={t}
                className={type === t ? 'chip chip-on' : 'chip'}
                onClick={() => setType(t)}
              >
                {POLL_TYPE_LABELS[t]}
              </button>
            ))}
          </div>

          {type === 'scale' && (
            <div className="poll-scale-edit">
              <label>
                段階
                <select value={scaleMax} onChange={(e) => setScaleMax(Number(e.target.value))}>
                  {[3, 4, 5, 6, 7].map((n) => (
                    <option key={n} value={n}>
                      1〜{n}
                    </option>
                  ))}
                </select>
              </label>
              <input
                value={minLabel}
                maxLength={30}
                placeholder="1の意味（例: わからない）"
                onChange={(e) => setMinLabel(e.target.value)}
              />
              <input
                value={maxLabel}
                maxLength={30}
                placeholder={`${scaleMax}の意味（例: よくわかった）`}
                onChange={(e) => setMaxLabel(e.target.value)}
              />
            </div>
          )}

          {(type === 'single' || type === 'multiple') && (
            <>
              {options.map((o, i) => (
                <input
                  key={i}
                  value={o}
                  maxLength={60}
                  placeholder={`選択肢 ${i + 1}`}
                  onChange={(e) =>
                    setOptions((prev) => prev.map((v, j) => (j === i ? e.target.value : v)))
                  }
                />
              ))}
              {options.length < 8 && (
                <button className="btn-link" onClick={() => setOptions((p) => [...p, ''])}>
                  ＋ 選択肢を足す
                </button>
              )}
            </>
          )}

          <button className="btn primary" onClick={submit} disabled={!question.trim()}>
            保存
          </button>
        </div>
      )}

      {polls.length === 0 && !editing && (
        <p className="muted">「＋ 設問を作る」から、授業中に聞きたいことを準備できます</p>
      )}

      <ul className="poll-list">
        {polls.map((p) => {
          const r = results[p.id];
          const isOpen = p.id === openPollId;
          return (
            <li key={p.id} className={isOpen ? 'poll-item open' : 'poll-item'}>
              <div className="poll-item-head">
                <span className="poll-item-q">{p.question}</span>
                <span className="chip">{POLL_TYPE_LABELS[p.type]}</span>
              </div>

              <div className="poll-item-actions">
                {isOpen ? (
                  <>
                    <button className="btn" onClick={() => onClose(p.id, false)}>
                      締め切る
                    </button>
                    <button className="btn primary" onClick={() => onClose(p.id, true)}>
                      結果を見せて締め切る
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      className="btn"
                      onClick={() => (p.status === 'closed' ? onRepeat(p) : onOpen(p.id))}
                      disabled={status !== 'live'}
                      title={
                        status !== 'live'
                          ? '授業を開始すると始められます'
                          : p.status === 'closed'
                            ? '同じ質問をもう一度聞きます。前回の結果は残ります'
                            : ''
                      }
                    >
                      {p.status === 'closed' ? 'もう一度聞く' : '開始'}
                    </button>
                    <button className="btn-link danger" onClick={() => onDelete(p.id)}>
                      削除
                    </button>
                  </>
                )}
              </div>

              {r && (r.answered > 0 || isOpen) && (
                <>
                  <p className="poll-count muted">
                    {r.answered} / {r.total}人が回答
                    {p.type === 'scale' && r.answered > 0 && (
                      <> ・ 平均 {scaleMean(p, r).toFixed(1)}</>
                    )}
                  </p>
                  {p.type !== 'text' && (
                    <ul className="poll-bars">
                      {p.options.map((o) => {
                        const n = r.counts[o.id] ?? 0;
                        // 分母は参加者全員。未回答が「回答済みの内訳」に埋もれないようにする
                        const pct = r.total > 0 ? (n / r.total) * 100 : 0;
                        return (
                          <li key={o.id}>
                            <span className="poll-bar-label">{o.label}</span>
                            <span className="poll-bar-track">
                              <span className="poll-bar-fill" style={{ width: `${pct}%` }} />
                            </span>
                            <span className="poll-bar-num">{n}</span>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  {p.type === 'text' && r.texts.length > 0 && (
                    <ul className="poll-texts">
                      {r.texts.map((t, i) => (
                        <li key={i}>
                          <span className="muted">{t.participantName}</span> {t.text}
                        </li>
                      ))}
                    </ul>
                  )}
                  {r.pending.length > 0 && (
                    <p className="poll-pending muted">未回答: {r.pending.join('、')}</p>
                  )}
                </>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function scaleMean(poll: Poll, r: PollResults): number {
  let sum = 0;
  let n = 0;
  for (const o of poll.options) {
    const c = r.counts[o.id] ?? 0;
    sum += Number(o.label) * c;
    n += c;
  }
  return n > 0 ? sum / n : 0;
}
