import { useMemo, useState } from 'react';
import type { LessonStatus, LessonTask, TaskMode, TaskProgressEntry } from '@shared';
import { MAX_TASKS } from '@shared';

/** この時間だけ進捗が動いていない生徒を「止まっている」として上に出す */
const STALLED_MS = 5 * 60_000;

type Props = {
  tasks: LessonTask[];
  mode: TaskMode;
  active: boolean;
  progress: TaskProgressEntry[];
  status: LessonStatus;
  /** 授業タイムライン上の現在時刻（未開始なら null）。滞留時間の計算に使う */
  nowMs: number | null;
  onSetTasks: (tasks: { id?: string; label: string }[]) => void;
  onSetConfig: (p: { mode?: TaskMode; active?: boolean }) => void;
};

/**
 * 先生画面のタスクパネル（動作確認できる最小限。表示の作り込みは後で調整する）。
 *
 * 集計の読み方はモードで変わる:
 * - 順番通り: 完了は累積するので上から下へ必ず短くなる。落差の大きい段が難所
 * - 順不同: 完了は累積しないので棒の長短は前後する。短い棒そのものが難所
 */
export default function TaskPanel({
  tasks,
  mode,
  active,
  progress,
  status,
  nowMs,
  onSetTasks,
  onSetConfig,
}: Props) {
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);

  const total = progress.length;

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const t of tasks) map.set(t.id, 0);
    for (const p of progress) {
      for (const id of p.taskIds) map.set(id, (map.get(id) ?? 0) + 1);
    }
    return map;
  }, [tasks, progress]);

  // 進捗が止まっている生徒を上に。全部終えた生徒は対象外
  const watchList = useMemo(() => {
    return [...progress]
      .filter((p) => p.taskIds.length < tasks.length)
      .sort((a, b) => a.updatedAtMs - b.updatedAtMs)
      .slice(0, 8);
  }, [progress, tasks.length]);

  const addTask = () => {
    const label = draft.trim();
    if (!label || tasks.length >= MAX_TASKS) return;
    onSetTasks([...tasks.map((t) => ({ id: t.id, label: t.label })), { label }]);
    setDraft('');
  };

  const renameTask = (id: string, label: string) => {
    const trimmed = label.trim();
    if (!trimmed || trimmed === tasks.find((t) => t.id === id)?.label) return;
    onSetTasks(tasks.map((t) => ({ id: t.id, label: t.id === id ? trimmed : t.label })));
  };

  const removeTask = (id: string) => {
    onSetTasks(tasks.filter((t) => t.id !== id).map((t) => ({ id: t.id, label: t.label })));
  };

  return (
    <div className="card task-panel">
      <div className="task-panel-head">
        <h3>タスク</h3>
        <button
          className={active ? 'btn' : 'btn primary'}
          onClick={() => onSetConfig({ active: !active })}
          disabled={tasks.length === 0 || status !== 'live'}
          title={
            status !== 'live'
              ? '授業を開始すると生徒に表示できます'
              : tasks.length === 0
                ? 'タスクを1つ以上追加してください'
                : ''
          }
        >
          {active ? '表示を終了' : '生徒に表示'}
        </button>
      </div>

      <div className="task-mode-row">
        <span className="muted">進め方</span>
        <button
          className={mode === 'sequential' ? 'chip chip-on' : 'chip'}
          onClick={() => onSetConfig({ mode: 'sequential' })}
        >
          順番通り
        </button>
        <button
          className={mode === 'free' ? 'chip chip-on' : 'chip'}
          onClick={() => onSetConfig({ mode: 'free' })}
        >
          順不同
        </button>
        <button className="btn-link" onClick={() => setEditing((v) => !v)}>
          {editing ? '編集を閉じる' : 'タスクを編集'}
        </button>
      </div>

      {editing && (
        <div className="task-edit">
          {tasks.map((t, i) => (
            <div className="task-edit-row" key={t.id}>
              <span className="muted">{i + 1}</span>
              <input
                defaultValue={t.label}
                maxLength={40}
                onBlur={(e) => renameTask(t.id, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                }}
              />
              <button className="btn-link danger" onClick={() => removeTask(t.id)} title="削除">
                ×
              </button>
            </div>
          ))}
          {tasks.length < MAX_TASKS && (
            <div className="task-edit-row">
              <span className="muted">＋</span>
              <input
                value={draft}
                maxLength={40}
                placeholder="タスク名（授業中でも追加できます）"
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) addTask();
                }}
              />
              <button className="btn" onClick={addTask} disabled={!draft.trim()}>
                追加
              </button>
            </div>
          )}
        </div>
      )}

      {tasks.length === 0 ? (
        <p className="muted">
          「タスクを編集」から、生徒に達成してほしいことを追加してください
        </p>
      ) : (
        <>
          <ul className="task-funnel">
            {tasks.map((t, i) => {
              const n = counts.get(t.id) ?? 0;
              const pct = total > 0 ? Math.round((n / total) * 100) : 0;
              return (
                <li key={t.id}>
                  <span className="funnel-label" title={t.label}>
                    {i + 1}. {t.label}
                    {mode === 'sequential' ? ' まで' : ''}
                  </span>
                  <span className="funnel-track">
                    <span className="funnel-fill" style={{ width: `${pct}%` }} />
                  </span>
                  <span className="funnel-num">
                    {pct}% <span className="muted">({n}/{total})</span>
                  </span>
                </li>
              );
            })}
          </ul>

          {watchList.length > 0 && (
            <ul className="task-watch">
              {watchList.map((p) => {
                // 時計は30秒ごとにしか進まないので、直後の更新では負になりうる
                const idleMs = nowMs !== null ? Math.max(0, nowMs - p.updatedAtMs) : 0;
                const stalled = nowMs !== null && idleMs >= STALLED_MS;
                return (
                  <li key={p.participantId} className={stalled ? 'stalled' : ''}>
                    <span className="watch-name">{p.participantName}</span>
                    <span className="muted">
                      {p.taskIds.length === 0 ? '未着手' : `${p.taskIds.length}/${tasks.length}`}
                    </span>
                    {nowMs !== null && p.updatedAtMs > 0 && (
                      <span className="watch-idle">{Math.floor(idleMs / 60_000)}分</span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
