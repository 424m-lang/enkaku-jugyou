import type {
  ClearSlidePayload,
  StrokePayload,
  StrokeProgressPayload,
  TimelineEvent,
} from '@shared';

export type StrokesBySlide = Record<string, StrokePayload[]>;

/** タイムラインの stroke / clear_slide イベント列から各スライドの描画状態を再構成する */
export function rebuildStrokes(events: TimelineEvent[]): StrokesBySlide {
  const by: StrokesBySlide = {};
  for (const ev of events) {
    applyDrawingEvent(by, ev.type, ev.payload as StrokePayload | ClearSlidePayload);
  }
  return by;
}

export function applyDrawingEvent(
  by: StrokesBySlide,
  type: string,
  payload: StrokePayload | ClearSlidePayload
): StrokesBySlide {
  if (type === 'stroke') {
    const p = payload as StrokePayload;
    by[p.slideId] = [...(by[p.slideId] ?? []), p];
  } else if (type === 'clear_slide') {
    const p = payload as ClearSlidePayload;
    if (by[p.slideId]) {
      by[p.slideId] =
        p.strokeIds && p.strokeIds.length > 0
          ? by[p.slideId].filter((s) => !p.strokeIds!.includes(s.strokeId))
          : [];
    }
  }
  return by;
}

/** 描画途中のプレビュー。strokeId → いまの形 */
export type ProgressStrokes = Record<string, StrokePayload>;

/**
 * 描画途中の断片を取り込む。
 *
 * 送り側は前回から増えた点だけを送り、`fromIndex` にその開始位置を入れてくる
 * （テキストの入力・移動は全体を送るので fromIndex なし）。
 *
 * この経路は volatile なので断片が落ちることがある。落ちると添字が飛ぶので、
 * **繋がらない断片は捨てて、いまの形をそのまま残す**。
 * 線が伸びるのが一瞬止まって見えるが、描き終わりに届く確定ストロークで正しい形に戻る。
 * 無理に繋ぐと、実際には引いていない線が生徒の画面に出てしまう。
 */
export function applyStrokeProgress(
  prev: ProgressStrokes,
  p: StrokeProgressPayload
): ProgressStrokes {
  const from = p.fromIndex ?? 0;
  if (from === 0) return { ...prev, [p.strokeId]: { ...p, points: [...p.points] } };
  const cur = prev[p.strokeId];
  if (!cur || cur.points.length !== from) return prev; // 落ちた断片がある
  return { ...prev, [p.strokeId]: { ...cur, points: [...cur.points, ...p.points] } };
}
