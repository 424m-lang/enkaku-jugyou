import { and, asc, eq } from 'drizzle-orm';
import { db, schema } from './db';
import { loadSlides } from './live/liveSessions';

/** ブロックやスライド一覧で「そのスライドを説明していた」とみなす最短の表示時間 */
export const SLIDE_DWELL_MIN_MS = 3_000;

/** どの時刻にどのスライドを映していたか（slide_change イベントから組み立てる） */
export type SlideInterval = { slideId: string; startMs: number; endMs: number };

export function buildSlideIntervals(
  slideChanges: { tMs: number; slideId: string }[],
  durationMs: number
): SlideInterval[] {
  const out: SlideInterval[] = [];
  for (let i = 0; i < slideChanges.length; i++) {
    const cur = slideChanges[i];
    const end = i + 1 < slideChanges.length ? slideChanges[i + 1].tMs : durationMs;
    if (end > cur.tMs) out.push({ slideId: cur.slideId, startMs: cur.tMs, endMs: end });
  }
  return out;
}

export async function loadSlideIntervals(
  lessonId: string,
  durationMs: number
): Promise<SlideInterval[]> {
  const rows = await db
    .select({ tMs: schema.timelineEvents.tMs, payload: schema.timelineEvents.payload })
    .from(schema.timelineEvents)
    .where(
      and(
        eq(schema.timelineEvents.lessonId, lessonId),
        eq(schema.timelineEvents.type, 'slide_change')
      )
    )
    .orderBy(asc(schema.timelineEvents.tMs));
  return buildSlideIntervals(
    rows.map((r) => ({ tMs: r.tMs, slideId: (r.payload as { slideId: string }).slideId })),
    durationMs
  );
}

/** その時刻に映していたスライド */
export function slideAt(intervals: SlideInterval[], tMs: number): string | null {
  for (const iv of intervals) {
    if (iv.startMs <= tMs && tMs < iv.endMs) return iv.slideId;
  }
  return null;
}

/**
 * その区間に説明していたスライド（表示順）。
 * 一瞬めくっただけのスライドは「説明していた」とは扱わないが、
 * 短い区間で0枚になってしまう場合は最長の1枚を残す。
 */
export function slidesInRange(intervals: SlideInterval[], startMs: number, endMs: number): string[] {
  const dwell = new Map<string, number>();
  const firstAt = new Map<string, number>();
  for (const iv of intervals) {
    const overlap = Math.min(iv.endMs, endMs) - Math.max(iv.startMs, startMs);
    if (overlap <= 0) continue;
    dwell.set(iv.slideId, (dwell.get(iv.slideId) ?? 0) + overlap);
    if (!firstAt.has(iv.slideId)) firstAt.set(iv.slideId, Math.max(iv.startMs, startMs));
  }
  if (dwell.size === 0) return [];
  let ids = [...dwell.entries()].filter(([, ms]) => ms >= SLIDE_DWELL_MIN_MS).map(([id]) => id);
  if (ids.length === 0) ids = [[...dwell.entries()].sort((a, b) => b[1] - a[1])[0][0]];
  return ids.sort((a, b) => (firstAt.get(a) ?? 0) - (firstAt.get(b) ?? 0));
}

/** スライドIDから授業内の通し番号（1始まり）を引く表 */
export async function slideNumberMap(lessonId: string): Promise<Map<string, number>> {
  const slides = await loadSlides(lessonId);
  const map = new Map<string, number>();
  slides.forEach((s, i) => map.set(s.id, i + 1));
  return map;
}
