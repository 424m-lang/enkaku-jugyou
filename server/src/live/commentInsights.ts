import crypto from 'node:crypto';
import { and, desc, eq, gte, lte, ne } from 'drizzle-orm';
import type { Server } from 'socket.io';
import type { CommentInsight, InsightComment, ReactionCounts } from '@shared';
import { config } from '../config';
import { db, schema } from '../db';
import {
  TOPIC_NOT_COVERED_MESSAGE,
  judgeSameTopic,
  locateCommentTarget,
  summarizeCommentContext,
} from '../ai/summarize';
// transcribeRange は直接使わず、ローリング文字起こし(liveTranscript)経由で参照する
import { tMs, type LiveSession } from './liveSessions';
import { ensureTranscribedUntil, segmentsUntil } from './liveTranscript';

type AnyServer = Server<any, any>;

/** 1枚のカードに統合するコメントの上限 */
const MAX_COMMENTS_PER_INSIGHT = 10;
/** ボタン反応の集計はコメント時刻の少し後まで含める（周辺に届いた反応を拾う） */
const REACTION_TAIL_MS = 30_000;

function emitInsight(io: AnyServer, lessonId: string, insight: CommentInsight): void {
  io.to(`lesson:${lessonId}:teacher`).emit('comment_insight', insight);
}

type InsightRow = typeof schema.commentInsights.$inferSelect;

function rowToInsight(r: InsightRow): CommentInsight {
  return {
    id: r.id,
    slideId: r.slideId,
    windowStartMs: r.windowStartMs,
    windowEndMs: r.windowEndMs,
    comments: r.comments,
    kinds: r.kinds,
    summary: r.summary,
    status: r.status,
    resolved: r.resolved,
  };
}

/**
 * 「対応済み」の印を付ける・外す。
 * カードは消さない。授業後の振り返りで読み返すため、印だけを持つ
 */
export async function setInsightResolved(
  lessonId: string,
  insightId: string,
  resolved: boolean
): Promise<CommentInsight | null> {
  await db
    .update(schema.commentInsights)
    .set({ resolved })
    .where(
      and(
        eq(schema.commentInsights.id, insightId),
        eq(schema.commentInsights.lessonId, lessonId)
      )
    );
  const [row] = await db
    .select()
    .from(schema.commentInsights)
    .where(
      and(
        eq(schema.commentInsights.id, insightId),
        eq(schema.commentInsights.lessonId, lessonId)
      )
    );
  return row ? rowToInsight(row) : null;
}

// 統合判定と分析が同時に走って矛盾しないよう、授業ごとに直列処理する
const chains = new Map<string, Promise<void>>();
function enqueue(lessonId: string, job: () => Promise<void>): void {
  const prev = chains.get(lessonId) ?? Promise.resolve();
  const next = prev.then(job).catch((err) => console.error('[comment-insight] 処理に失敗:', err));
  chains.set(lessonId, next);
}

/**
 * コメント到着時に呼ぶ。
 * 1. まずコメント原文だけのカード（status=pending）を保存・配信する（①即時表示）
 * 2. 分析範囲が近接する既存カードがあれば「同じ事柄への言及か」をAIで判定し、
 *    同じなら既存カードへ統合する（新カードは削除通知を配信）
 * 3. 入力開始時刻周辺の音声を文字起こし→コメントに関連する説明の重要ポイントを要約し、
 *    周辺のボタン反応数とあわせてカードを更新する（②への成長）
 */
export function handleCommentForInsight(
  io: AnyServer,
  s: LiveSession,
  comment: {
    reactionId: string;
    text: string;
    participantName: string;
    tMs: number;
    slideId: string | null;
    composeStartMs: number;
  }
): void {
  // 分析対象は「入力開始時刻の90秒前」〜「コメント送信時刻」
  const windowStartMs = Math.max(0, comment.composeStartMs - config.insightWindowBeforeMs);
  const windowEndMs = Math.max(comment.tMs, comment.composeStartMs);
  const ic: InsightComment = {
    reactionId: comment.reactionId,
    text: comment.text,
    participantName: comment.participantName,
    tMs: comment.tMs,
    composeStartMs: comment.composeStartMs,
  };
  const insight: CommentInsight = {
    id: crypto.randomUUID(),
    slideId: comment.slideId,
    windowStartMs,
    windowEndMs,
    comments: [ic],
    kinds: {},
    summary: null,
    status: 'pending',
    resolved: false,
  };

  enqueue(s.lessonId, async () => {
    await db.insert(schema.commentInsights).values({
      id: insight.id,
      lessonId: s.lessonId,
      slideId: insight.slideId,
      windowStartMs,
      windowEndMs,
      comments: insight.comments,
      kinds: insight.kinds,
      summary: null,
      status: 'pending',
    });
    emitInsight(io, s.lessonId, insight);

    const target = (await tryMerge(io, s, insight)) ?? insight;
    await analyze(io, s, target);
  });
}

/**
 * 分析範囲が近接する既存カードのうち「同じ事柄への言及」と判定されたものへ統合する。
 * 統合したら統合先カードを返し、しなければ null。
 */
async function tryMerge(
  io: AnyServer,
  s: LiveSession,
  insight: CommentInsight
): Promise<CommentInsight | null> {
  const gap = config.insightMergeGapMs;
  const candidates = await db
    .select()
    .from(schema.commentInsights)
    .where(
      and(
        eq(schema.commentInsights.lessonId, s.lessonId),
        ne(schema.commentInsights.id, insight.id),
        gte(schema.commentInsights.windowEndMs, insight.windowStartMs - gap),
        lte(schema.commentInsights.windowStartMs, insight.windowEndMs + gap)
      )
    )
    .orderBy(desc(schema.commentInsights.createdAt))
    .limit(3);

  const newComment = insight.comments[0];
  for (const cand of candidates) {
    if (cand.comments.length >= MAX_COMMENTS_PER_INSIGHT) continue;
    // LLMが使えない環境では「同じスライドへのコメント」で近似する
    const same =
      (await judgeSameTopic(
        cand.comments.map((c) => c.text),
        newComment.text
      )) ?? (cand.slideId !== null && cand.slideId === insight.slideId);
    if (!same) continue;

    const merged: CommentInsight = {
      ...rowToInsight(cand),
      windowStartMs: Math.min(cand.windowStartMs, insight.windowStartMs),
      windowEndMs: Math.max(cand.windowEndMs, insight.windowEndMs),
      comments: [...cand.comments, newComment],
      status: 'pending',
      // 同じ話題でも新しい声が届いたので、拾い直す対象に戻す
      resolved: false,
    };
    await db.delete(schema.commentInsights).where(eq(schema.commentInsights.id, insight.id));
    io.to(`lesson:${s.lessonId}:teacher`).emit('comment_insight_removed', insight.id);
    await db
      .update(schema.commentInsights)
      .set({
        windowStartMs: merged.windowStartMs,
        windowEndMs: merged.windowEndMs,
        comments: merged.comments,
        status: 'pending',
        resolved: false,
      })
      .where(eq(schema.commentInsights.id, cand.id));
    emitInsight(io, s.lessonId, merged);
    return merged;
  }
  return null;
}

/** 音声の文字起こし→関連する説明の要約と、周辺のボタン反応数でカードを完成させる */
async function analyze(io: AnyServer, s: LiveSession, insight: CommentInsight): Promise<void> {
  try {
    // コメント周辺（分析範囲＋少し後ろ、現在時刻まで）に届いた全生徒のボタン反応数
    const countEnd = Math.min(insight.windowEndMs + REACTION_TAIL_MS, Math.max(tMs(s), insight.windowEndMs));
    const rows = await db
      .select({ kind: schema.reactions.kind })
      .from(schema.reactions)
      .where(
        and(
          eq(schema.reactions.lessonId, s.lessonId),
          ne(schema.reactions.kind, 'comment'),
          gte(schema.reactions.tMs, insight.windowStartMs),
          lte(schema.reactions.tMs, countEnd)
        )
      );
    const kinds: ReactionCounts = {};
    for (const r of rows) kinds[r.kind] = (kinds[r.kind] ?? 0) + 1;

    const summary = await summarizeForComment(s, insight);

    const ready: CommentInsight = { ...insight, kinds, summary, status: 'ready' };
    await db
      .update(schema.commentInsights)
      .set({ kinds, summary, status: 'ready' })
      .where(eq(schema.commentInsights.id, insight.id));
    emitInsight(io, s.lessonId, ready);
  } catch (err) {
    console.error('[comment-insight] 分析に失敗:', err);
    try {
      await db
        .update(schema.commentInsights)
        .set({ status: 'failed' })
        .where(eq(schema.commentInsights.id, insight.id));
    } catch {
      /* 保存失敗は配信のみで通知 */
    }
    emitInsight(io, s.lessonId, { ...insight, status: 'failed' });
  }
}

/**
 * 二段構えでコメントに対する説明を要約する。
 * 1段目: 授業のここまでの文字起こし全体から、コメントが向けられた発言を特定する
 *        （授業後の「コメント」タブと同じ locateCommentTarget を共通利用）
 * 2段目: 特定した発言の前後だけを要約する（先生が話していなければ定型文のみ）
 * 録音がまだ無い（文字起こしできない）場合は null を返す。
 */
async function summarizeForComment(s: LiveSession, insight: CommentInsight): Promise<string | null> {
  // コメント送信時刻まで文字起こしが貯まっているようにする（直近だけ追いつく）
  await ensureTranscribedUntil(s, insight.windowEndMs);
  const segments = segmentsUntil(s, insight.windowEndMs);
  if (segments.length === 0) return null; // 録音なし

  // 1段目: 授業全体から対象の発言を特定
  const idx = await locateCommentTarget(segments, insight.comments[0].text);
  if (idx === null) return TOPIC_NOT_COVERED_MESSAGE; // 先生が話していない

  // 2段目: 特定した発言の前後だけを要約対象にする
  const target = segments[idx];
  const from = target.startMs - config.insightFocusBeforeMs;
  const to = target.endMs + config.insightFocusAfterMs;
  const focusText = segments
    .filter((seg) => seg.endMs > from && seg.startMs < to)
    .map((seg) => seg.text)
    .join('');
  const result = await summarizeCommentContext(
    focusText,
    insight.comments.map((c) => c.text)
  );
  return result.text;
}

/** 保存済みのコメント・振り返りを取得（先生画面の初期表示・再接続時用） */
export async function listCommentInsights(lessonId: string): Promise<CommentInsight[]> {
  const rows = await db
    .select()
    .from(schema.commentInsights)
    .where(eq(schema.commentInsights.lessonId, lessonId))
    .orderBy(schema.commentInsights.windowStartMs);
  return rows.map(rowToInsight);
}
