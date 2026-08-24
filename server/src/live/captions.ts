import { and, asc, eq, gte } from 'drizzle-orm';
import type { CaptionLine, TranscriptSegment } from '@shared';
import { db, schema } from '../db';
import type { LiveSession } from './liveSessions';

/** 重なりを落として時系列に並べる（ローリング文字起こしは前を少し重ねているため） */
function dedupe(segments: TranscriptSegment[]): TranscriptSegment[] {
  const sorted = [...segments].sort((a, b) => a.startMs - b.startMs);
  const out: TranscriptSegment[] = [];
  let until = -Infinity;
  for (const seg of sorted) {
    if (seg.startMs < until - 500) continue;
    out.push(seg);
    until = Math.max(until, seg.endMs);
  }
  return out;
}

/**
 * 字幕の履歴を組み立てる。
 *
 * 文字起こしが追いついた範囲は Whisper の結果に差し替え、まだ追いついていない
 * 直近だけブラウザ音声認識の暫定を使う。Whisperの側はスライドPDFから作った
 * 用語ヒントが効いているので、読み返したときに専門用語が正しく出る。
 *
 * 行ごとに突き合わせるのではなく時刻で切り分けているのは、ブラウザ音声認識と
 * Whisperで発話の区切り位置が揃わず、混ぜると重複や欠落が出るため。
 */
export async function captionHistory(s: LiveSession): Promise<CaptionLine[]> {
  const confirmedUntilMs = s.transcribedUntilMs;

  // ---- 確定ぶん: ローリング文字起こし ----
  const rows = await db
    .select({ segments: schema.transcripts.segments })
    .from(schema.transcripts)
    .where(
      and(eq(schema.transcripts.lessonId, s.lessonId), eq(schema.transcripts.scope, 'clip'))
    );
  const segments: TranscriptSegment[] = [];
  for (const r of rows) {
    if (Array.isArray(r.segments)) segments.push(...(r.segments as TranscriptSegment[]));
  }
  const confirmed: CaptionLine[] = dedupe(segments)
    .filter((seg) => seg.startMs < confirmedUntilMs && seg.text.trim())
    .map((seg) => ({ tMs: seg.startMs, text: seg.text.trim(), source: 'whisper' as const }));

  // ---- 暫定ぶん: 文字起こしがまだ届いていない直近 ----
  const events = await db
    .select({ tMs: schema.timelineEvents.tMs, payload: schema.timelineEvents.payload })
    .from(schema.timelineEvents)
    .where(
      and(
        eq(schema.timelineEvents.lessonId, s.lessonId),
        eq(schema.timelineEvents.type, 'caption'),
        gte(schema.timelineEvents.tMs, confirmedUntilMs)
      )
    )
    .orderBy(asc(schema.timelineEvents.tMs));
  const live: CaptionLine[] = events
    .map((e) => ({
      tMs: e.tMs,
      text: String((e.payload as { text?: string }).text ?? '').trim(),
      source: 'live' as const,
    }))
    .filter((l) => l.text);

  return [...confirmed, ...live];
}
