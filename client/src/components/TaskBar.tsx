import { useEffect, useRef, useState } from 'react';
import type { LessonTask, TaskMode } from '@shared';

/** 「できた」を押した直後に取り消しボタンを出しておく時間 */
const UNDO_WINDOW_MS = 6000;
/** 授業中にタスクが追加されたことを知らせる強調表示の時間 */
const NEW_TASK_FLASH_MS = 5000;

type Props = {
  tasks: LessonTask[];
  mode: TaskMode;
  /** 自分が完了したタスク（tasks の並び順） */
  doneIds: string[];
  disabled: boolean;
  /**
   * アンケート中は数字だけに縮む。アンケートは短時間で注意を求めるもの、
   * タスクバーはぼんやり見えていればよいもの、という性格の違いに合わせる
   */
  compact?: boolean;
  onSet: (taskId: string, done: boolean) => void;
};

/**
 * 生徒画面のタスクバー。先生がタスクモードを開始している間だけ表示される。
 *
 * 誤操作と押し忘れは対策が逆を向く（確認を挟むと押し忘れが増え、押しやすくすると
 * 誤操作が増える）ため、確認ダイアログは使わず次の2つで受ける:
 * - 常に「いまどこにいるか」を出しておく → 押し忘れた本人が見て気づける
 * - 一覧から正しい位置を選び直せる → 誤操作も押し忘れも同じ操作で直る
 *
 * 他の生徒の進捗は表示しない。遅れている生徒への圧力になるため、比較は先生画面だけに置く。
 */
export default function TaskBar({ tasks, mode, doneIds, disabled, compact, onSet }: Props) {
  const [open, setOpen] = useState(false);
  // 直前に完了にしたタスク（数秒だけ「取り消す」を同じ場所に出す）
  const [undoable, setUndoable] = useState<string | null>(null);
  const [flashNew, setFlashNew] = useState(false);
  const knownIdsRef = useRef<string[] | null>(null);

  const done = new Set(doneIds);
  const nextIndex = tasks.findIndex((t) => !done.has(t.id));
  const allDone = tasks.length > 0 && nextIndex < 0;
  const current = nextIndex >= 0 ? tasks[nextIndex] : null;

  useEffect(() => {
    if (!undoable) return;
    const timer = setTimeout(() => setUndoable(null), UNDO_WINDOW_MS);
    return () => clearTimeout(timer);
  }, [undoable]);

  // 授業中にタスクが増えたら知らせる（全部終えた生徒は変化に気づけないため）
  useEffect(() => {
    const ids = tasks.map((t) => t.id);
    const known = knownIdsRef.current;
    knownIdsRef.current = ids;
    if (!known) return; // 初回表示は「増えた」ではない
    if (ids.some((id) => !known.includes(id))) setFlashNew(true);
  }, [tasks]);

  useEffect(() => {
    if (!flashNew) return;
    const timer = setTimeout(() => setFlashNew(false), NEW_TASK_FLASH_MS);
    return () => clearTimeout(timer);
  }, [flashNew]);

  if (tasks.length === 0) return null;

  const toggle = (taskId: string, next: boolean) => {
    if (disabled) return;
    onSet(taskId, next);
    setUndoable(next ? taskId : null);
  };

  // アンケート中は場所を譲り、進み具合の数字と一覧だけを残す
  if (compact && !open) {
    return (
      <button type="button" className="task-mini" onClick={() => setOpen(true)}>
        タスク {doneIds.length}/{tasks.length}
      </button>
    );
  }

  return (
    <div className={`task-bar${flashNew ? ' task-bar-new' : ''}`}>
      {compact ? (
        <div className="task-row">
          <button type="button" className="task-label" onClick={() => setOpen(false)}>
            <span className="task-label-text">タスク {doneIds.length}/{tasks.length}</span>
            <span className="task-caret">▾</span>
          </button>
        </div>
      ) : (
      <div className="task-row">
        {mode === 'sequential' ? (
          <>
            <div className="task-dots" aria-hidden="true">
              {tasks.map((t, i) => (
                <span
                  key={t.id}
                  className={
                    done.has(t.id) ? 'task-dot done' : i === nextIndex ? 'task-dot current' : 'task-dot'
                  }
                >
                  {i === nextIndex ? i + 1 : ''}
                </span>
              ))}
            </div>
            <button
              type="button"
              className="task-label"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
            >
              <span className="task-label-text">
                {allDone ? '全部できた' : `${nextIndex + 1}. ${current?.label ?? ''}`}
              </span>
              <span className="task-caret">{open ? '▾' : '▴'}</span>
            </button>
            {undoable ? (
              <button
                type="button"
                className="task-undo"
                onClick={() => toggle(undoable, false)}
                disabled={disabled}
              >
                ↩ 取り消す
              </button>
            ) : (
              !allDone && (
                <button
                  type="button"
                  className="task-done-btn"
                  onClick={() => current && toggle(current.id, true)}
                  disabled={disabled || !current}
                >
                  できた
                </button>
              )
            )}
          </>
        ) : (
          <>
            {/* 順不同では「次」が決まらないので、名前のチップを直接タップして切り替える */}
            <div className="task-chips">
              {tasks.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={done.has(t.id) ? 'task-chip done' : 'task-chip'}
                  onClick={() => toggle(t.id, !done.has(t.id))}
                  disabled={disabled}
                >
                  {done.has(t.id) ? '✓ ' : ''}
                  {t.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="task-count"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
            >
              {doneIds.length} / {tasks.length}
            </button>
          </>
        )}
      </div>
      )}

      {open && (
        <ul className="task-list">
          {tasks.map((t, i) => {
            const isDone = done.has(t.id);
            const isCurrent = mode === 'sequential' && i === nextIndex;
            return (
              <li key={t.id}>
                <button
                  type="button"
                  className={`task-list-row${isDone ? ' done' : ''}${isCurrent ? ' current' : ''}`}
                  onClick={() => toggle(t.id, !isDone)}
                  disabled={disabled}
                >
                  <span className="task-list-mark">{isDone ? '✓' : isCurrent ? '●' : '○'}</span>
                  <span className="task-list-label">
                    {i + 1}. {t.label}
                  </span>
                  <span className="task-list-hint">
                    {isDone ? '取り消す' : isCurrent ? 'いまここ' : mode === 'sequential' ? 'ここまで終わった' : '完了にする'}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
