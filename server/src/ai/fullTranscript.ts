import crypto from 'node:crypto';
import { and, asc, desc, eq } from 'drizzle-orm';
import type { TranscriptSegment } from '@shared';
import { config } from '../config';
import { db, schema } from '../db';
import { transcribeRange } from './transcribe';

/** 重なりを落として時系列に並べる（授業中のローリング文字起こしは前を少し重ねているため） */
function dedupe(segments: TranscriptSegment[]): TranscriptSegment[] {
  const sorted = [...segments].sort((a, b) => a.startMs - b.startMs);
  const out: TranscriptSegment[] = [];
  let until = -Infinity;
  for (const seg of sorted) {
    // 既に取り込んだ範囲の中にほぼ収まっているものは重複とみなして捨てる
    if (seg.startMs < until - 500) continue;
    out.push(seg);
    until = Math.max(until, seg.endMs);
  }
  return out;
}

/** すでに文字起こし済みの範囲をつないで、[0, durationMs] の中の空きを返す */
function gapsIn(
  covered: { startMs: number; endMs: number }[],
  durationMs: number,
  minGapMs: number
): { startMs: number; endMs: number }[] {
  const merged: { startMs: number; endMs: number }[] = [];
  for (const r of [...covered].sort((a, b) => a.startMs - b.startMs)) {
    const last = merged[merged.length - 1];
    if (last && r.startMs <= last.endMs) last.endMs = Math.max(last.endMs, r.endMs);
    else merged.push({ ...r });
  }
  const gaps: { startMs: number; endMs: number }[] = [];
  let cursor = 0;
  for (const r of merged) {
    if (r.startMs - cursor >= minGapMs) gaps.push({ startMs: cursor, endMs: r.startMs });
    cursor = Math.max(cursor, r.endMs);
  }
  if (durationMs - cursor >= minGapMs) gaps.push({ startMs: cursor, endMs: durationMs });
  return gaps;
}

/**
 * 授業全体の文字起こしセグメントを用意する。
 * 授業中のローリング文字起こし（scope='clip'）が残っていればそれを組み合わせて使い、
 * 足りない範囲だけを追加で文字起こしする。すでに全体文字起こしがあればそのまま返す。
 * → 授業中に貯めていれば、復習動画の作成でほとんど追加コストがかからない。
 */
export async function ensureFullTranscript(
  lessonId: string,
  durationMs: number
): Promise<TranscriptSegment[]> {
  if (durationMs <= 0) return [];

  const [fullRow] = await db
    .select()
    .from(schema.transcripts)
    .where(and(eq(schema.transcripts.lessonId, lessonId), eq(schema.transcripts.scope, 'full')))
    .orderBy(desc(schema.transcripts.createdAt))
    .limit(1);
  const existing = (fullRow?.segments ?? null) as TranscriptSegment[] | null;
  if (existing && existing.length > 0 && fullRow.rangeEndMs >= durationMs - 30_000) {
    return dedupe(existing);
  }

  // 授業中に貯めた分を集める
  const clipRows = await db
    .select()
    .from(schema.transcripts)
    .where(and(eq(schema.transcripts.lessonId, lessonId), eq(schema.transcripts.scope, 'clip')))
    .orderBy(asc(schema.transcripts.rangeStartMs));

  const segments: TranscriptSegment[] = [...(existing ?? [])];
  const covered: { startMs: number; endMs: number }[] = existing
    ? [{ startMs: fullRow.rangeStartMs, endMs: fullRow.rangeEndMs }]
    : [];
  for (const r of clipRows) {
    const segs = (r.segments ?? []) as TranscriptSegment[];
    if (segs.length === 0) continue;
    segments.push(...segs);
    covered.push({ startMs: r.rangeStartMs, endMs: r.rangeEndMs });
  }

  // 空いている範囲だけを、Whisperの上限に収まる長さずつ文字起こしする
  const texts: string[] = [];
  for (const gap of gapsIn(covered, durationMs, 20_000)) {
    let from = gap.startMs;
    while (from < gap.endMs) {
      const to = Math.min(gap.endMs, from + config.liveTranscribeMaxChunkMs);
      const t = await transcribeRange(lessonId, from, to);
      if (!t) break; // 録音が無い範囲
      segments.push(...(t.segments ?? []));
      texts.push(t.text);
      from = to;
    }
  }

  const result = dedupe(segments);
  if (result.length === 0) return [];

  // 次回以降のためにまとめて保存する（既存の全体文字起こしは置き換える）
  await db
    .delete(schema.transcripts)
    .where(and(eq(schema.transcripts.lessonId, lessonId), eq(schema.transcripts.scope, 'full')));
  await db.insert(schema.transcripts).values({
    id: crypto.randomUUID(),
    lessonId,
    scope: 'full',
    rangeStartMs: 0,
    rangeEndMs: durationMs,
    text: result.map((s) => s.text).join(''),
    summary: fullRow?.summary ?? null,
    segments: result,
    provider: clipRows[0]?.provider ?? (texts.length > 0 ? config.transcribeProvider : 'mixed'),
  });
  return result;
}
