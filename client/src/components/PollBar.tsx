import { useEffect, useState } from 'react';
import type { PollAnswer, PollResults, PublicPoll } from '@shared';

type Props = {
  poll: PublicPoll;
  /** 自分の回答（未回答なら null）。サーバから戻ってきた値で上書きされる */
  answer: PollAnswer | null;
  disabled: boolean;
  onAnswer: (p: { optionIds?: string[]; text?: string }) => void;
};

/**
 * 生徒画面のアンケート回答欄。先生がアンケートを開始している間だけ現れる。
 *
 * 締め切られるまで何度でも押し直せる（タスクと同じく、誤操作は確認ダイアログではなく
 * 「やり直せること」で受ける）。他の生徒が何を選んだかは締め切りまで一切見えない。
 */
export default function PollBar({ poll, answer, disabled, onAnswer }: Props) {
  const [draft, setDraft] = useState('');
  const selected = new Set(answer?.optionIds ?? []);

  // 設問が切り替わったら書きかけを捨てる（前の設問の文章が残らないように）
  useEffect(() => {
    setDraft('');
  }, [poll.id]);

  useEffect(() => {
    if (answer?.text) setDraft(answer.text);
  }, [answer?.text]);

  const choose = (optionId: string) => {
    if (disabled) return;
    if (poll.type === 'multiple') {
      const next = new Set(selected);
      if (next.has(optionId)) next.delete(optionId);
      else next.add(optionId);
      onAnswer({ optionIds: [...next] });
    } else {
      onAnswer({ optionIds: [optionId] });
    }
  };

  return (
    <div className="poll-bar">
      <div className="poll-head">
        <span className="poll-q">{poll.question}</span>
        {answer && <span className="poll-answered">回答済み（変更できます）</span>}
      </div>

      {poll.type === 'text' ? (
        <div className="poll-text-row">
          <input
            value={draft}
            maxLength={500}
            placeholder="答えを入力"
            disabled={disabled}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing && draft.trim()) {
                onAnswer({ text: draft.trim() });
              }
            }}
          />
          <button
            className="btn primary"
            disabled={disabled || !draft.trim()}
            onClick={() => onAnswer({ text: draft.trim() })}
          >
            {answer ? '出し直す' : '送信'}
          </button>
        </div>
      ) : poll.type === 'scale' ? (
        <div className="poll-scale">
          {poll.minLabel && <span className="poll-end-label">{poll.minLabel}</span>}
          {poll.options.map((o) => (
            <button
              key={o.id}
              className={selected.has(o.id) ? 'poll-scale-btn on' : 'poll-scale-btn'}
              disabled={disabled}
              onClick={() => choose(o.id)}
            >
              {o.label}
            </button>
          ))}
          {poll.maxLabel && <span className="poll-end-label">{poll.maxLabel}</span>}
        </div>
      ) : (
        <div className="poll-options">
          {poll.options.map((o) => (
            <button
              key={o.id}
              className={selected.has(o.id) ? 'poll-option on' : 'poll-option'}
              disabled={disabled}
              onClick={() => choose(o.id)}
            >
              {selected.has(o.id) ? '✓ ' : ''}
              {o.label}
            </button>
          ))}
          {poll.type === 'multiple' && (
            <span className="poll-hint">いくつでも選べます</span>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 締め切り後に先生が「結果を見せる」を選んだときだけ出る集計。
 * 単一選択・段階評価は円グラフ（誰でも一目で分かる）、
 * 複数選択は割合の合計が100%を超えるので横棒にする。
 */
export function PollResultView({
  poll,
  results,
  onClose,
}: {
  poll: PublicPoll;
  results: PollResults;
  onClose: () => void;
}) {
  const total = results.answered;
  const entries = poll.options.map((o) => ({ ...o, n: results.counts[o.id] ?? 0 }));
  const usePie = poll.type === 'single' || poll.type === 'scale';

  return (
    <div className="poll-bar poll-result">
      <div className="poll-head">
        <span className="poll-q">{poll.question}</span>
        <button className="btn-link" onClick={onClose}>
          閉じる
        </button>
      </div>
      {total === 0 ? (
        <p className="muted">回答はありませんでした</p>
      ) : usePie ? (
        <div className="poll-pie-row">
          <PieChart entries={entries} total={total} />
          <ul className="poll-legend">
            {entries.map((e, i) => (
              <li key={e.id}>
                <span className="legend-dot" style={{ background: PIE_COLORS[i % PIE_COLORS.length] }} />
                {e.label} {Math.round((e.n / total) * 100)}%
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <ul className="poll-bars">
          {entries.map((e) => (
            <li key={e.id}>
              <span className="poll-bar-label">{e.label}</span>
              <span className="poll-bar-track">
                <span className="poll-bar-fill" style={{ width: `${(e.n / total) * 100}%` }} />
              </span>
              <span className="poll-bar-num">{Math.round((e.n / total) * 100)}%</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// カラーユニバーサルデザイン（Okabe-Ito）寄りの並び。色覚の違いがあっても見分けやすい
const PIE_COLORS = ['#0072b2', '#e69f00', '#009e73', '#cc79a7', '#56b4e9', '#d55e00', '#f0e442', '#999999'];

function PieChart({ entries, total }: { entries: { id: string; n: number }[]; total: number }) {
  const R = 42;
  let acc = 0;
  const arcs = entries
    .filter((e) => e.n > 0)
    .map((e, i) => {
      const start = (acc / total) * Math.PI * 2 - Math.PI / 2;
      acc += e.n;
      const end = (acc / total) * Math.PI * 2 - Math.PI / 2;
      const large = end - start > Math.PI ? 1 : 0;
      const x1 = 50 + R * Math.cos(start);
      const y1 = 50 + R * Math.sin(start);
      const x2 = 50 + R * Math.cos(end);
      const y2 = 50 + R * Math.sin(end);
      // 1件しか選ばれていない場合は円弧では描けないので円をそのまま塗る
      const d =
        e.n === total
          ? `M 50 8 A ${R} ${R} 0 1 1 49.9 8 Z`
          : `M 50 50 L ${x1} ${y1} A ${R} ${R} 0 ${large} 1 ${x2} ${y2} Z`;
      return { d, color: PIE_COLORS[entries.indexOf(e) % PIE_COLORS.length], key: e.id, i };
    });
  return (
    <svg viewBox="0 0 100 100" className="poll-pie" role="img" aria-label="回答の割合">
      {arcs.map((a) => (
        <path key={a.key} d={a.d} fill={a.color} />
      ))}
    </svg>
  );
}
