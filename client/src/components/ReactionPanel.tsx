import { useState } from 'react';
import type { ReactionButtonDef } from '@shared';

/**
 * 生徒が押すリアクションボタンの設定と、直近の反応数。
 *
 * ボタンを消すのではなく「隠す」ようにしてあるのは、授業後の集計で
 * 過去の反応のラベルと色を引けなくなるため。授業の途中で聞きたいことが
 * 変わっても、前半の記録はそのまま読める。
 */

type Props = {
  buttons: ReactionButtonDef[];
  enabled: boolean;
  /** 直近5分のボタン別の反応数 */
  recentCounts: Record<string, number>;
  onSetEnabled: (enabled: boolean) => void;
  onSetButtons: (buttons: ReactionButtonDef[]) => void;
};

const MAX_BUTTONS = 6;

export default function ReactionPanel({
  buttons,
  enabled,
  recentCounts,
  onSetEnabled,
  onSetButtons,
}: Props) {
  const [draft, setDraft] = useState('');

  const patch = (i: number, p: Partial<ReactionButtonDef>) => {
    onSetButtons(buttons.map((b, j) => (j === i ? { ...b, ...p } : b)));
  };

  const add = () => {
    const label = draft.trim();
    if (!label || buttons.length >= MAX_BUTTONS) return;
    onSetButtons([...buttons, { key: `btn_${Date.now()}`, label, color: '#2563eb' }]);
    setDraft('');
  };

  const visible = buttons.filter((b) => !b.hidden);

  return (
    <>
      <div className="classroom-sec">
        <span className="classroom-label">直近5分の反応</span>
        {enabled && visible.length > 0 ? (
          <div className="recent-reactions">
            {visible.map((b) => (
              <span key={b.key} className="kind-pill" style={{ background: b.color }}>
                {b.label} ×{recentCounts[b.key] ?? 0}
              </span>
            ))}
          </div>
        ) : (
          <p className="muted small">
            {enabled ? '出しているボタンがありません' : 'いまボタンは出していません'}
          </p>
        )}
      </div>

      <div className="classroom-sec">
        <span className="classroom-label">生徒画面のボタン</span>
        <div className="classroom-row">
          <button
            className={`btn tool ${enabled ? 'tool-active' : ''}`}
            onClick={() => onSetEnabled(true)}
          >
            ボタンを使う
          </button>
          <button
            className={`btn tool ${enabled ? '' : 'tool-active'}`}
            onClick={() => onSetEnabled(false)}
            title="生徒画面からボタンの行ごと消えます。設定は残るのでいつでも戻せます"
          >
            使わない
          </button>
        </div>
        <p className="muted small">
          タスクやアンケートで様子が分かるなら、ボタンは無しでも授業は成立します。
        </p>
      </div>

      <div className="classroom-sec">
        <span className="classroom-label">ボタンの中身</span>
        {buttons.map((b, i) => (
          <div key={b.key} className={b.hidden ? 'reaction-edit-row hidden-row' : 'reaction-edit-row'}>
            <input
              value={b.label}
              maxLength={20}
              placeholder="ラベル"
              onChange={(e) => patch(i, { label: e.target.value })}
            />
            <input
              type="color"
              value={b.color}
              onChange={(e) => patch(i, { color: e.target.value })}
              aria-label={`${b.label}の色`}
            />
            <button
              className="btn small"
              onClick={() => patch(i, { hidden: !b.hidden })}
              title={b.hidden ? '生徒画面に出す' : '生徒画面から隠す（記録は残ります）'}
            >
              {b.hidden ? '出す' : '隠す'}
            </button>
          </div>
        ))}
        {buttons.length < MAX_BUTTONS && (
          <div className="reaction-edit-row">
            <input
              value={draft}
              maxLength={20}
              placeholder="ボタン名（授業中でも足せます）"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) add();
              }}
            />
            <button className="btn" onClick={add} disabled={!draft.trim()}>
              追加
            </button>
          </div>
        )}
      </div>
    </>
  );
}
