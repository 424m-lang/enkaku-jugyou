import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, asc, desc, eq } from 'drizzle-orm';
import type { LessonStats, ReactionCounts, TranscriptSegment } from '@shared';
import { db, schema } from '../db';
import { requireTeacher, teacherIdOf } from '../auth';
import { clusterReactions } from '../live/reactions';
import { transcribeRange } from '../ai/transcribe';
import { summarizeLesson } from '../ai/summarize';

/** 自分の授業であることを確認して返す（振り返り系は先生専用） */
async function ownLesson(
  req: FastifyRequest,
  reply: FastifyReply,
  lessonId: string
): Promise<typeof schema.lessons.$inferSelect | null> {
  const [lesson] = await db
    .select()
    .from(schema.lessons)
    .where(and(eq(schema.lessons.id, lessonId), eq(schema.lessons.teacherId, teacherIdOf(req))));
  if (!lesson) {
    reply.code(404).send({ error: '授業が見つかりません' });
    return null;
  }
  return lesson;
}

async function reactionsWithNames(lessonId: string) {
  return db
    .select({
      id: schema.reactions.id,
      tMs: schema.reactions.tMs,
      kind: schema.reactions.kind,
      comment: schema.reactions.comment,
      participantId: schema.reactions.participantId,
      participantName: schema.participants.displayName,
    })
    .from(schema.reactions)
    .innerJoin(schema.participants, eq(schema.reactions.participantId, schema.participants.id))
    .where(eq(schema.reactions.lessonId, lessonId))
    .orderBy(asc(schema.reactions.tMs));
}

function fmtMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export async function reviewRoutes(app: FastifyInstance): Promise<void> {
  // ---- タイムライン全イベント（同期再生用） ----
  app.get('/api/lessons/:id/timeline', { preHandler: requireTeacher }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const lesson = await ownLesson(req, reply, id);
    if (!lesson) return;
    const events = await db
      .select({
        id: schema.timelineEvents.id,
        tMs: schema.timelineEvents.tMs,
        type: schema.timelineEvents.type,
        payload: schema.timelineEvents.payload,
      })
      .from(schema.timelineEvents)
      .where(eq(schema.timelineEvents.lessonId, id))
      .orderBy(asc(schema.timelineEvents.tMs));
    return { durationMs: lesson.audioDurationMs ?? 0, events };
  });

  // ---- クリップ一覧（反応クラスタ + 既存の文字起こし/提案） ----
  app.get('/api/lessons/:id/clips', { preHandler: requireTeacher }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const lesson = await ownLesson(req, reply, id);
    if (!lesson) return;

    const rows = await reactionsWithNames(id);
    const clusters = clusterReactions(rows);

    // 授業中に生成済みのクリップ文字起こし・提案を範囲の重なりで対応付け
    const clipTranscripts = await db
      .select()
      .from(schema.transcripts)
      .where(and(eq(schema.transcripts.lessonId, id), eq(schema.transcripts.scope, 'clip')));
    for (const c of clusters) {
      const t = clipTranscripts.find(
        (row) => row.rangeStartMs < c.endMs && row.rangeEndMs > c.startMs
      );
      if (t) {
        c.transcriptText = t.text;
        c.summaryText = t.summary;
      }
    }
    return clusters;
  });

  // ---- クリップ範囲のオンデマンド文字起こし ----
  app.post('/api/lessons/:id/clips/transcribe', { preHandler: requireTeacher }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const lesson = await ownLesson(req, reply, id);
    if (!lesson) return;
    const { startMs, endMs } = (req.body ?? {}) as { startMs?: number; endMs?: number };
    if (typeof startMs !== 'number' || typeof endMs !== 'number' || endMs <= startMs) {
      return reply.code(400).send({ error: '範囲が不正です' });
    }
    const t = await transcribeRange(id, startMs, endMs);
    if (!t) return reply.code(404).send({ error: '対象範囲の音声がありません' });
    await db.insert(schema.transcripts).values({
      id: crypto.randomUUID(),
      lessonId: id,
      scope: 'clip',
      rangeStartMs: startMs,
      rangeEndMs: endMs,
      text: t.text,
      segments: t.segments,
      provider: t.provider,
    });
    return { text: t.text };
  });

  // ---- 授業全体の文字起こし + AI要約（振り返り提案と同じ仕組みを全体に適用） ----
  app.post('/api/lessons/:id/summarize', { preHandler: requireTeacher }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const lesson = await ownLesson(req, reply, id);
    if (!lesson) return;
    if (lesson.status !== 'ended') {
      return reply.code(409).send({ error: '授業終了後に実行できます' });
    }
    const durationMs = lesson.audioDurationMs ?? 0;
    if (durationMs <= 0) return reply.code(409).send({ error: '録音がありません' });

    const t = await transcribeRange(id, 0, durationMs);
    if (!t) return reply.code(409).send({ error: '録音ファイルが見つかりません' });

    const rows = await reactionsWithNames(id);
    const clusters = clusterReactions(rows).slice(0, 8);
    const clusterNotes = clusters.map((c) => {
      const kinds = Object.entries(c.kinds)
        .map(([k, n]) => `${k}×${n}`)
        .join(', ');
      const comments = c.participants
        .map((p) => p.comment)
        .filter(Boolean)
        .slice(0, 3)
        .join(' / ');
      return `${fmtMs(c.centerMs)}頃: ${c.participantCount}人が反応（${kinds}）${comments ? ` コメント: ${comments}` : ''}`;
    });

    const summary = await summarizeLesson(t.text, clusterNotes);

    // 既存の全体要約は置き換える
    await db
      .delete(schema.transcripts)
      .where(and(eq(schema.transcripts.lessonId, id), eq(schema.transcripts.scope, 'full')));
    await db.insert(schema.transcripts).values({
      id: crypto.randomUUID(),
      lessonId: id,
      scope: 'full',
      rangeStartMs: 0,
      rangeEndMs: durationMs,
      text: t.text,
      summary: summary.text,
      segments: t.segments,
      provider: t.provider,
      model: summary.provider,
    });

    return {
      text: t.text,
      summary: summary.text,
      segments: t.segments,
      provider: t.provider,
      model: summary.provider,
      createdAt: new Date().toISOString(),
    };
  });

  // ---- 保存済みの全体要約を取得 ----
  app.get('/api/lessons/:id/summary', { preHandler: requireTeacher }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const lesson = await ownLesson(req, reply, id);
    if (!lesson) return;
    const [row] = await db
      .select()
      .from(schema.transcripts)
      .where(and(eq(schema.transcripts.lessonId, id), eq(schema.transcripts.scope, 'full')))
      .orderBy(desc(schema.transcripts.createdAt))
      .limit(1);
    if (!row) return reply.code(404).send({ error: 'まだ要約がありません' });
    return {
      text: row.text,
      summary: row.summary,
      segments: row.segments,
      provider: row.provider,
      model: row.model,
      createdAt: row.createdAt.toISOString(),
    };
  });

  // ---- 統計ダッシュボード ----
  app.get('/api/lessons/:id/stats', { preHandler: requireTeacher }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const lesson = await ownLesson(req, reply, id);
    if (!lesson) return;

    const parts = await db
      .select()
      .from(schema.participants)
      .where(eq(schema.participants.lessonId, id));
    const rows = await reactionsWithNames(id);

    const countsByKind: ReactionCounts = {};
    const byMinute = new Map<number, ReactionCounts>();
    const byParticipant = new Map<
      string,
      { name: string; counts: ReactionCounts; reactions: { tMs: number; kind: string; comment: string | null }[] }
    >();

    for (const p of parts) {
      byParticipant.set(p.id, { name: p.displayName, counts: {}, reactions: [] });
    }
    for (const r of rows) {
      countsByKind[r.kind] = (countsByKind[r.kind] ?? 0) + 1;
      const minute = Math.floor(r.tMs / 60_000);
      const m = byMinute.get(minute) ?? {};
      m[r.kind] = (m[r.kind] ?? 0) + 1;
      byMinute.set(minute, m);
      const bp = byParticipant.get(r.participantId);
      if (bp) {
        bp.counts[r.kind] = (bp.counts[r.kind] ?? 0) + 1;
        bp.reactions.push({ tMs: r.tMs, kind: r.kind, comment: r.comment });
      }
    }

    // 話速（文字/分）: 全体文字起こしのセグメントから算出
    let speechRate: LessonStats['speechRate'] = null;
    const [fullRow] = await db
      .select()
      .from(schema.transcripts)
      .where(and(eq(schema.transcripts.lessonId, id), eq(schema.transcripts.scope, 'full')))
      .orderBy(desc(schema.transcripts.createdAt))
      .limit(1);
    const segments = (fullRow?.segments ?? null) as TranscriptSegment[] | null;
    if (segments && segments.length > 0) {
      const charsPerMinute = new Map<number, number>();
      for (const seg of segments) {
        // セグメントの文字数を、跨いでいる分に比例配分する
        const durMs = Math.max(1, seg.endMs - seg.startMs);
        for (let minute = Math.floor(seg.startMs / 60_000); minute <= Math.floor((seg.endMs - 1) / 60_000); minute++) {
          const overlap =
            Math.min(seg.endMs, (minute + 1) * 60_000) - Math.max(seg.startMs, minute * 60_000);
          const chars = (seg.text.length * overlap) / durMs;
          charsPerMinute.set(minute, (charsPerMinute.get(minute) ?? 0) + chars);
        }
      }
      speechRate = [...charsPerMinute.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([minute, chars]) => ({ minute, charsPerMin: Math.round(chars) }));
    }

    const durationMin = Math.ceil((lesson.audioDurationMs ?? 0) / 60_000);
    const timeline: LessonStats['timeline'] = [];
    for (let minute = 0; minute < Math.max(durationMin, byMinute.size > 0 ? Math.max(...byMinute.keys()) + 1 : 0); minute++) {
      const counts = byMinute.get(minute) ?? {};
      timeline.push({
        minute,
        counts,
        total: Object.values(counts).reduce((a, b) => a + b, 0),
      });
    }

    const stats: LessonStats = {
      totalParticipants: parts.length,
      totalReactions: rows.length,
      countsByKind,
      timeline,
      perParticipant: [...byParticipant.entries()]
        .map(([participantId, v]) => ({
          participantId,
          name: v.name,
          total: v.reactions.length,
          counts: v.counts,
          reactions: v.reactions,
        }))
        .sort((a, b) => b.total - a.total),
      speechRate,
    };
    return stats;
  });
}
