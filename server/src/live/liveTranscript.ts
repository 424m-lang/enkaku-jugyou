import crypto from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import type { TranscriptSegment } from '@shared';
import { config } from '../config';
import { db, schema } from '../db';
import { transcribeRange } from '../ai/transcribe';
import { tMs, type LiveSession } from './liveSessions';

/**
 * 授業中にバックグラウンドで文字起こしを保存する仕組み。
 * - 5分間隔で、前回以降の範囲を文字起こしして追加する
 * - コメント受信時は、未処理の範囲だけを追加で文字起こしする
 * - 各区切りは直前を少し重ねて文字起こしし、つなぎ目の重複は取り除く
 * コメントを受信した時点までの文字起こしを、分析に利用できる状態にする。
 */

// 授業ごとに文字起こしを直列化し、定期実行とコメント受信時の処理の競合を防ぐ
const chains = new Map<string, Promise<void>>();

/** 授業中に継続して文字起こしを貯める機能が選ばれているか */
export function usesRollingTranscription(s: LiveSession): boolean {
  return s.aiSettings.commentAnalysis || s.aiSettings.whisperCaptionHistory;
}

export function startLiveTranscription(s: LiveSession): void {
  stopLiveTranscription(s);
  if (!usesRollingTranscription(s)) return;
  s.transcribeTimer = setInterval(() => {
    void ensureTranscribedUntil(s, tMs(s)).catch((err) =>
      console.error('[live-transcript] 定期文字起こしに失敗:', err)
    );
  }, config.liveTranscribeIntervalMs);
}

export function stopLiveTranscription(s: LiveSession): void {
  if (s.transcribeTimer) {
    clearInterval(s.transcribeTimer);
    s.transcribeTimer = null;
  }
}

/** targetMsまでの文字起こしを用意する。複数の要求は授業ごとに直列処理する */
export async function ensureTranscribedUntil(s: LiveSession, targetMs: number): Promise<void> {
  if (targetMs <= s.transcribedUntilMs + 2000) return;
  const prev = chains.get(s.lessonId) ?? Promise.resolve();
  const next = prev
    .then(() => catchUp(s, targetMs))
    .catch((err) => console.error('[live-transcript] 追いつき文字起こしに失敗:', err));
  chains.set(s.lessonId, next);
  await next;
}

async function catchUp(s: LiveSession, targetMs: number): Promise<void> {
  // 大きな空きがあってもWhisperの上限を超えないよう、最大チャンク長ずつ進める
  while (s.transcribedUntilMs + 2000 < targetMs) {
    const before = s.transcribedUntilMs;
    const from = Math.max(0, before - config.liveTranscribeOverlapMs);
    const to = Math.min(targetMs, before + config.liveTranscribeMaxChunkMs);
    const t = await transcribeRange(s.lessonId, from, to);
    if (!t) return; // まだ音声が無い区間（録音していない等）→ 次の機会に再挑戦

    // つなぎ目の重複除去: 既に貯めた範囲(before)より後のセグメントだけ採用する。
    // 重ねた分(from〜before)はWhisperに前後の文脈を与えるためだけに使い、捨てる
    const newSegs = (t.segments ?? []).filter((seg) => seg.startMs >= before);
    s.transcriptSegments = s.transcriptSegments
      .concat(newSegs)
      .sort((a, b) => a.startMs - b.startMs);
    s.transcribedUntilMs = to;

    // 再起動復元・授業後の再利用のためDBにも保存する
    await db.insert(schema.transcripts).values({
      id: crypto.randomUUID(),
      lessonId: s.lessonId,
      scope: 'clip',
      rangeStartMs: from,
      rangeEndMs: to,
      text: t.text,
      segments: t.segments,
      provider: t.provider,
    });
  }
}

/** サーバ再起動時: 保存済みのローリング文字起こしをメモリへ復元する */
export async function restoreLiveTranscript(s: LiveSession): Promise<void> {
  const rows = await db
    .select()
    .from(schema.transcripts)
    .where(and(eq(schema.transcripts.lessonId, s.lessonId), eq(schema.transcripts.scope, 'clip')))
    .orderBy(asc(schema.transcripts.rangeStartMs));
  const segs: TranscriptSegment[] = [];
  let until = 0;
  for (const r of rows) {
    for (const seg of (r.segments ?? []) as TranscriptSegment[]) {
      if (seg.startMs >= until) segs.push(seg); // 重なりは捨てる
    }
    until = Math.max(until, r.rangeEndMs);
  }
  segs.sort((a, b) => a.startMs - b.startMs);
  s.transcriptSegments = segs;
  s.transcribedUntilMs = until;
}

/** untilMs までに貯まっている文字起こしセグメント（コメントの全文参照用） */
export function segmentsUntil(s: LiveSession, untilMs: number): TranscriptSegment[] {
  return s.transcriptSegments.filter((seg) => seg.startMs < untilMs);
}
