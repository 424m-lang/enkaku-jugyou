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

  /**
   * ボタンを書き換える。あわせて「使う / 使わない」を実態に合わせる。
   *
   * 全部隠したのに「ボタンを使う」のままだと、生徒画面に空の行だけが残って
   * 先生からは分からない。逆に1つでも出せば使う気があるということなので、
   * 二度目の操作を求めない。
   */
  const patch = (i: number, p: Partial<ReactionButtonDef>) => {
    const next = buttons.map((b, j) => (j === i ? { ...b, ...p } : b));
    onSetButtons(next);
    const visibleCount = next.filter((b) => !b.hidden).length;
    if (visibleCount === 0 && enabled) onSetEnabled(false);
    else if (visibleCount > 0 && !enabled) onSetEnabled(true);
  };

  const add = () => {
    const label = draft.trim();
    if (!label || buttons.length >= MAX_BUTTONS) return;
    onSetButtons([...buttons, { key: `btn_${Date.now()}`, label, color: '#2563eb' }]);
    if (!enabled) onSetEnabled(true);
    setDraft('');
  };

  const visible = buttons.filter((b) => !b.hidden);
  /**
   * 出ているボタンが1つも無ければ「使わない」と同じ状態なので、そう見せる。
   *
   * `enabled` の値だけで見せると、全部隠したまま「ボタンを使う」を押した場合に
   * 「使う」と表示されているのに生徒側には何も出ない、という食い違いが残る。
   * 窓を閉じて開き直したときに表示が変わって見えるのもこれが原因だった
   */
  const effectivelyOn = enabled && visible.length > 0;

  return (
    <>
      <div className="classroom-sec">
        <span className="classroom-label">直近5分の反応</span>
        {effectivelyOn ? (
          <div className="recent-reactions">
            {visible.map((b) => (
              <span key={b.key} className="kind-pill" style={{ background: b.color }}>
                {b.label} ×{recentCounts[b.key] ?? 0}
              </span>
            ))}
          </div>
        ) : (
          <p className="muted small">いまボタンは出していません</p>
        )}
      </div>

      <div className="classroom-sec">
        <span className="classroom-label">生徒画面のボタン</span>
        <div className="classroom-row">
          <button
            className={`btn tool ${effectivelyOn ? 'tool-active' : ''}`}
            onClick={() => onSetEnabled(true)}
            disabled={visible.length === 0}
            title={
              visible.length === 0
                ? '出しているボタンが1つもありません。下で「出す」を押すと使えるようになります'
                : '生徒画面にボタンの行を出します'
            }
          >
            ボタンを使う
          </button>
          <button
            className={`btn tool ${effectivelyOn ? '' : 'tool-active'}`}
            onClick={() => onSetEnabled(false)}
            title="生徒画面からボタンの行ごと消えます。設定は残るのでいつでも戻せます"
          >
            使わない
          </button>
        </div>
        <p className="muted small">
          タスクやアンケートで様子が分かるなら、ボタンは無しでも授業は成立します。
          下で全部隠すと「使わない」に、1つでも出すと「ボタンを使う」に切り替わります。
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
