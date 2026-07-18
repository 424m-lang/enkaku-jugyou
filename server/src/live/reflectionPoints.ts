import crypto from 'node:crypto';
import { and, eq, gte, lt } from 'drizzle-orm';
import type { Server } from 'socket.io';
import type { ReactionCounts, ReflectionPoint } from '@shared';
import { config } from '../config';
import { db, schema } from '../db';
import { transcribeRange } from '../ai/transcribe';
import { summarizeSlideVisit } from '../ai/summarize';

type AnyServer = Server<any, any>;

const MAX_COMMENTS = 20;

function emitPoint(io: AnyServer, lessonId: string, point: ReflectionPoint): void {
  io.to(`lesson:${lessonId}:teacher`).emit('reflection_point', point);
}

/**
 * スライドの滞在が終わったときに呼ばれる（スライド切替・授業終了時）。
 * 一定時間（既定1分）以上の滞在だけを「振り返りポイント」のクラスタとして採用し、
 * 区間内の反応を集計して保存・配信、AIまとめは非同期で後追い生成する。
 *
 * 人数しきい値や反応の密度には依存しないため、大人数で常に反応がある授業でも、
 * 反応が少ない消極的なクラスでも、同じ基準でポイントが作られる。
 */
export async function finalizeVisit(
  io: AnyServer,
  lessonId: string,
  slideId: string | null,
  startMs: number,
  endMs: number
): Promise<void> {
  if (!slideId) return;
  if (endMs - startMs < config.reflectionMinVisitMs) return; // 短い通過は対象外

  // 区間内の反応を集計
  const rows = await db
    .select({ kind: schema.reactions.kind, comment: schema.reactions.comment })
    .from(schema.reactions)
    .where(
      and(
        eq(schema.reactions.lessonId, lessonId),
        gte(schema.reactions.tMs, startMs),
        lt(schema.reactions.tMs, endMs)
      )
    );
  const kinds: ReactionCounts = {};
  const comments: string[] = [];
  for (const r of rows) {
    kinds[r.kind] = (kinds[r.kind] ?? 0) + 1;
    if (r.comment) comments.push(r.comment);
  }

  const point: ReflectionPoint = {
    id: crypto.randomUUID(),
    slideId,
    startMs,
    endMs,
    kinds,
    comments: comments.slice(0, MAX_COMMENTS),
    summary: null,
    status: 'pending',
  };

  await db.insert(schema.reflectionPoints).values({
    id: point.id,
    lessonId,
    slideId,
    startMs,
    endMs,
    kinds,
    comments: point.comments,
    summary: null,
    status: 'pending',
  });
  emitPoint(io, lessonId, point);

  // AIまとめ（区間の文字起こし＋反応の要約）は後追いで生成して差し込む
  void generateSummary(io, lessonId, point).catch(async (err) => {
    console.error('[reflection-point] まとめ生成に失敗:', err);
    try {
      await db
        .update(schema.reflectionPoints)
        .set({ status: 'failed' })
        .where(eq(schema.reflectionPoints.id, point.id));
    } catch {
      /* 保存失敗は配信のみで通知 */
    }
    emitPoint(io, lessonId, { ...point, status: 'failed' });
  });
}

async function generateSummary(
  io: AnyServer,
  lessonId: string,
  point: ReflectionPoint
): Promise<void> {
  const [lesson] = await db
    .select({ reactionButtons: schema.lessons.reactionButtons })
    .from(schema.lessons)
    .where(eq(schema.lessons.id, lessonId));
  const labels = Object.fromEntries(
    (lesson?.reactionButtons ?? []).map((b) => [b.key, b.label])
  );

  // 音声はコピーせず、タイムスタンプ範囲の切り出し→文字起こし（録音が無ければnull）
  const t = await transcribeRange(lessonId, point.startMs, point.endMs);

  const result = await summarizeSlideVisit(t?.text ?? null, {
    kinds: point.kinds,
    labels,
    comments: point.comments,
    durationMs: point.endMs - point.startMs,
  });

  // 生成した文字起こしはtranscriptsにも保存し、授業後のクリップ表示で再利用する
  if (t) {
    await db.insert(schema.transcripts).values({
      id: crypto.randomUUID(),
      lessonId,
      scope: 'clip',
      rangeStartMs: point.startMs,
      rangeEndMs: point.endMs,
      text: t.text,
      summary: result.text,
      segments: t.segments,
      provider: t.provider,
      model: result.provider,
    });
  }

  await db
    .update(schema.reflectionPoints)
    .set({ summary: result.text, status: 'ready' })
    .where(eq(schema.reflectionPoints.id, point.id));
  emitPoint(io, lessonId, { ...point, summary: result.text, status: 'ready' });
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
    status: r.status,
  }));
}
