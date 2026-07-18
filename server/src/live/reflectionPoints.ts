import crypto from 'node:crypto';
import { and, eq, gte, isNull, lt, lte, ne, or } from 'drizzle-orm';
import type { Server } from 'socket.io';
import type { ReactionCounts, ReflectionPoint } from '@shared';
import { config } from '../config';
import { db, schema } from '../db';
import { transcribeRange } from '../ai/transcribe';
import { summarizeComments, summarizeExplanation } from '../ai/summarize';
import { tMs, type LiveSession } from './liveSessions';

type AnyServer = Server<any, any>;

/** コメント入力中の合図がこの時間途絶えたら入力を止めたとみなす */
const COMPOSING_STALE_MS = 20_000;
/** コメント入力中の生徒を待つ最大時間 */
const COMPOSING_MAX_WAIT_MS = 90_000;
const MAX_COMMENTS = 20;

function emitPoint(io: AnyServer, lessonId: string, point: ReflectionPoint): void {
  io.to(`lesson:${lessonId}:teacher`).emit('reflection_point', point);
}

/**
 * スライド切替時: 切替先が「確定保留中のスライド」への1分以内の復帰なら、
 * 滞在を継続扱いにして true を返す（切り替わりとして判定しない）。
 */
export function resumeHeldVisit(s: LiveSession, slideId: string, nowMs: number): boolean {
  const held = s.heldVisit;
  if (!held || held.slideId !== slideId) return false;
  if (nowMs - held.leftAtMs > config.reflectionReturnWindowMs) return false;
  clearTimeout(held.timer);
  s.heldVisit = null;
  s.visitStartMs = held.startMs; // 元の滞在開始時刻から連続しているものとする
  return true;
}

/**
 * スライドを離れたときに呼ぶ。1分以上の滞在なら即確定せず保留し、
 * 1分以内に戻らなければタイマーで確定する（戻れば resumeHeldVisit が継続させる）。
 */
export function holdVisitEnd(
  io: AnyServer,
  s: LiveSession,
  slideId: string,
  startMs: number,
  leftAtMs: number
): void {
  if (leftAtMs - startMs < config.reflectionMinVisitMs) return; // 短い通過は対象外

  // 別のスライドの保留が残っていれば先に確定させる（保留は常に1件）
  if (s.heldVisit) {
    const prev = s.heldVisit;
    clearTimeout(prev.timer);
    s.heldVisit = null;
    void finalizeVisit(io, s, prev.slideId, prev.startMs, prev.leftAtMs).catch((err) =>
      console.error('[reflection-point] 確定に失敗:', err)
    );
  }

  const timer = setTimeout(() => {
    s.heldVisit = null;
    void finalizeVisit(io, s, slideId, startMs, leftAtMs).catch((err) =>
      console.error('[reflection-point] 確定に失敗:', err)
    );
  }, config.reflectionReturnWindowMs);
  s.heldVisit = { slideId, startMs, leftAtMs, timer };
}

/** 授業終了時: 保留中の滞在と表示中スライドの滞在をすべて確定する */
export function flushVisitsAtEnd(io: AnyServer, s: LiveSession, endMs: number): void {
  if (s.heldVisit) {
    const held = s.heldVisit;
    clearTimeout(held.timer);
    s.heldVisit = null;
    void finalizeVisit(io, s, held.slideId, held.startMs, held.leftAtMs).catch((err) =>
      console.error('[reflection-point] 確定に失敗:', err)
    );
  }
  if (s.currentSlideId) {
    void finalizeVisit(io, s, s.currentSlideId, s.visitStartMs, endMs).catch((err) =>
      console.error('[reflection-point] 確定に失敗:', err)
    );
  }
}

/** このスライド宛のコメントを入力中の生徒がいる間は待つ（最大90秒） */
async function waitForComposers(s: LiveSession, slideId: string): Promise<void> {
  const deadline = Date.now() + COMPOSING_MAX_WAIT_MS;
  for (;;) {
    const now = Date.now();
    let active = false;
    for (const [pid, c] of s.composing) {
      if (now - c.atEpochMs > COMPOSING_STALE_MS) {
        s.composing.delete(pid); // 合図が途絶えた生徒は入力をやめたとみなす
      } else if (c.slideId === slideId) {
        active = true;
      }
    }
    if (!active || now >= deadline) return;
    await new Promise((r) => setTimeout(r, 3000));
  }
}

/**
 * 滞在区間を振り返りポイントとして確定する。
 * - コメント入力中の生徒がいれば、そのコメントが届くまで要約を待つ
 * - ボタン反応もコメントも無ければポイントにしない
 * - コメントは「入力開始時のスライド」タグで紐づけるため、
 *   ページ切替後に届いた分もこの区間に含まれる
 */
export async function finalizeVisit(
  io: AnyServer,
  s: LiveSession,
  slideId: string | null,
  startMs: number,
  endMs: number
): Promise<void> {
  if (!slideId) return;
  if (endMs - startMs < config.reflectionMinVisitMs) return;

  await waitForComposers(s, slideId);

  // ボタン反応: 滞在時間内のもの
  const buttonRows = await db
    .select({ kind: schema.reactions.kind })
    .from(schema.reactions)
    .where(
      and(
        eq(schema.reactions.lessonId, s.lessonId),
        ne(schema.reactions.kind, 'comment'),
        gte(schema.reactions.tMs, startMs),
        lt(schema.reactions.tMs, endMs)
      )
    );
  const kinds: ReactionCounts = {};
  for (const r of buttonRows) kinds[r.kind] = (kinds[r.kind] ?? 0) + 1;

  // コメント: このスライド宛タグ付き（遅れて届いた分も含む）＋ タグ無し旧データは時間内のみ
  const collectUntil = Math.max(endMs, tMs(s));
  const commentRows = await db
    .select({ comment: schema.reactions.comment })
    .from(schema.reactions)
    .where(
      and(
        eq(schema.reactions.lessonId, s.lessonId),
        eq(schema.reactions.kind, 'comment'),
        gte(schema.reactions.tMs, startMs),
        or(
          and(eq(schema.reactions.slideId, slideId), lte(schema.reactions.tMs, collectUntil)),
          and(isNull(schema.reactions.slideId), lt(schema.reactions.tMs, endMs))
        )
      )
    );
  const comments = commentRows
    .map((r) => r.comment)
    .filter((c): c is string => !!c)
    .slice(0, MAX_COMMENTS);

  // 反応もコメントも無い区間は振り返りポイントに載せない
  if (Object.keys(kinds).length === 0 && comments.length === 0) return;

  const point: ReflectionPoint = {
    id: crypto.randomUUID(),
    slideId,
    startMs,
    endMs,
    kinds,
    comments,
    summary: null,
    commentSummary: null,
    status: 'pending',
  };

  await db.insert(schema.reflectionPoints).values({
    id: point.id,
    lessonId: s.lessonId,
    slideId,
    startMs,
    endMs,
    kinds,
    comments,
    summary: null,
    commentSummary: null,
    status: 'pending',
  });
  emitPoint(io, s.lessonId, point);

  void generateSummaries(io, s.lessonId, point).catch(async (err) => {
    console.error('[reflection-point] 要約生成に失敗:', err);
    try {
      await db
        .update(schema.reflectionPoints)
        .set({ status: 'failed' })
        .where(eq(schema.reflectionPoints.id, point.id));
    } catch {
      /* 保存失敗は配信のみで通知 */
    }
    emitPoint(io, s.lessonId, { ...point, status: 'failed' });
  });
}

/**
 * 「説明内容」（音声の文字起こし）と「コメント」を独立して要約する。
 * ボタン反応は要約の入力に使わない（数として表示するだけ）。
 */
async function generateSummaries(
  io: AnyServer,
  lessonId: string,
  point: ReflectionPoint
): Promise<void> {
  // 音声はコピーせず、タイムスタンプ範囲の切り出し→文字起こし（録音が無ければnull）
  const t = await transcribeRange(lessonId, point.startMs, point.endMs);

  const [explanation, commentSummary] = await Promise.all([
    t ? summarizeExplanation(t.text) : Promise.resolve(null),
    point.comments.length > 0 ? summarizeComments(point.comments) : Promise.resolve(null),
  ]);

  // 生成した文字起こしはtranscriptsにも保存し、授業後のクリップ表示で再利用する
  if (t) {
    await db.insert(schema.transcripts).values({
      id: crypto.randomUUID(),
      lessonId,
      scope: 'clip',
      rangeStartMs: point.startMs,
      rangeEndMs: point.endMs,
      text: t.text,
      summary: explanation?.text ?? null,
      segments: t.segments,
      provider: t.provider,
      model: explanation?.provider ?? null,
    });
  }

  const updated: ReflectionPoint = {
    ...point,
    summary: explanation?.text ?? null,
    commentSummary: commentSummary?.text ?? null,
    status: 'ready',
  };
  await db
    .update(schema.reflectionPoints)
    .set({ summary: updated.summary, commentSummary: updated.commentSummary, status: 'ready' })
    .where(eq(schema.reflectionPoints.id, point.id));
  emitPoint(io, lessonId, updated);
}

/** 保存済みの振り返りポイントを取得（先生画面の初期表示・再接続時用） */
export async function listReflectionPoints(lessonId: string): Promise<ReflectionPoint[]> {
  const rows = await db
    .select()
    .from(schema.reflectionPoints)
    .where(eq(schema.reflectionPoints.lessonId, lessonId))
    .orderBy(schema.reflectionPoints.startMs);
  return rows.map((r) => ({
    id: r.id,
    slideId: r.slideId,
    startMs: r.startMs,
    endMs: r.endMs,
    kinds: r.kinds,
    comments: r.comments,
    summary: r.summary,
    commentSummary: r.commentSummary,
    status: r.status,
  }));
}
