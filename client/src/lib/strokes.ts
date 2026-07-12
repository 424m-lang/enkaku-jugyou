import type { ClearSlidePayload, StrokePayload, TimelineEvent } from '@shared';

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
