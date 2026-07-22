import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, asc, desc, eq, ne } from 'drizzle-orm';
import type { ReviewChapter, TimelineEvent, TranscriptSegment, WatchPage } from '@shared';
import { config } from '../config';
import { db, schema } from '../db';
import { requireTeacher, teacherIdOf } from '../auth';
import { loadSlides } from '../live/liveSessions';
import { lessonDir, pdfPath } from '../storage';
import { transcribeRange } from '../ai/transcribe';
import { describeChapter } from '../ai/summarize';

/** 公開URLのトークン（推測されないだけの長さを持たせる） */
function newShareToken(): string {
  return crypto.randomBytes(16).toString('base64url');
}

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

function rowToChapter(r: typeof schema.reviewChapters.$inferSelect): ReviewChapter {
  return {
    id: r.id,
    position: r.position,
    startMs: r.startMs,
    endMs: r.endMs,
    title: r.title,
    description: r.description,
    included: r.included,
  };
}

async function listChapters(lessonId: string): Promise<ReviewChapter[]> {
  const rows = await db
    .select()
    .from(schema.reviewChapters)
    .where(eq(schema.reviewChapters.lessonId, lessonId))
    .orderBy(asc(schema.reviewChapters.position));
  return rows.map(rowToChapter);
}

/**
 * 生徒がつまずいた箇所（ボタン反応・コメント）を核に、章の区間を組み立てる。
 * 話の流れが追えるよう前後を足し、近い区間はつなぎ、
 * 章の頭はそのスライドの説明の最初まで戻す。
 */
export function buildRanges(
  cores: { startMs: number; endMs: number }[],
  slideChangeMs: number[],
  durationMs: number
): { startMs: number; endMs: number }[] {
  if (cores.length === 0) return [];

  const expanded = cores
    .map((c) => ({
      startMs: Math.max(0, c.startMs - config.chapterContextBeforeMs),
      endMs: Math.min(durationMs, c.endMs + config.chapterContextAfterMs),
    }))
    .sort((a, b) => a.startMs - b.startMs);

  const merged: { startMs: number; endMs: number }[] = [];
  for (const r of expanded) {
    const last = merged[merged.length - 1];
    if (last && r.startMs - last.endMs <= config.chapterMergeGapMs) {
      last.endMs = Math.max(last.endMs, r.endMs);
    } else {
      merged.push({ ...r });
    }
  }

  // 章の頭を直前のスライド切替まで戻す（説明の途中から始まらないように）
  for (const r of merged) {
    let snapped = r.startMs;
    for (const t of slideChangeMs) {
      if (t <= r.startMs && r.startMs - t <= config.chapterSnapBackMaxMs) {
        snapped = Math.min(snapped, t);
      }
    }
    r.startMs = snapped;
  }

  // 戻した結果また重なったものを再度つなぐ
  const final: { startMs: number; endMs: number }[] = [];
  for (const r of merged) {
    const last = final[final.length - 1];
    if (last && r.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, r.endMs);
    } else {
      final.push(r);
    }
  }
  return final;
}

/** 章の文字起こし: 全体文字起こしがあればそこから切り出し、無ければその区間だけ文字起こしする */
async function chapterText(
  lessonId: string,
  segments: TranscriptSegment[] | null,
  startMs: number,
  endMs: number
): Promise<string | null> {
  if (segments && segments.length > 0) {
    const text = segments
      .filter((s) => s.endMs > startMs && s.startMs < endMs)
      .map((s) => s.text)
      .join('');
    return text || null;
  }
  const t = await transcribeRange(lessonId, startMs, endMs);
  return t?.text ?? null;
}

export async function reviewVideoRoutes(app: FastifyInstance): Promise<void> {
  // ---- 先生: 復習動画の状態を取得 ----
  app.get('/api/lessons/:id/review-video', { preHandler: requireTeacher }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const lesson = await ownLesson(req, reply, id);
    if (!lesson) return;
    return {
      chapters: await listChapters(id),
      shareToken: lesson.reviewShareToken,
      publishedAt: lesson.reviewPublishedAt?.toISOString() ?? null,
    };
  });

  // ---- 先生: 章を自動生成（既存の章は作り直す） ----
  app.post('/api/lessons/:id/review-video/generate', { preHandler: requireTeacher }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const lesson = await ownLesson(req, reply, id);
    if (!lesson) return;
    const durationMs = lesson.audioDurationMs ?? 0;
    if (durationMs <= 0) return reply.code(409).send({ error: '録音がありません' });

    // つまずいた箇所の核: ボタン反応（の前後）と、コメントの解析済みクリップ
    const buttonRows = await db
      .select({ tMs: schema.reactions.tMs })
      .from(schema.reactions)
      .where(and(eq(schema.reactions.lessonId, id), ne(schema.reactions.kind, 'comment')))
      .orderBy(asc(schema.reactions.tMs));
    const commentClipRows = await db
      .select()
      .from(schema.commentClips)
      .where(eq(schema.commentClips.lessonId, id));
    const commentRows = await db
      .select({ tMs: schema.reactions.tMs, composeStartMs: schema.reactions.composeStartMs })
      .from(schema.reactions)
      .where(and(eq(schema.reactions.lessonId, id), eq(schema.reactions.kind, 'comment')));

    const cores = [
      ...buttonRows.map((r) => ({
        startMs: Math.max(0, r.tMs - config.buttonClipBeforeMs),
        endMs: r.tMs + config.buttonClipAfterMs,
      })),
      ...commentClipRows.map((c) => ({ startMs: c.clipStartMs, endMs: c.clipEndMs })),
      // 未解析のコメントは入力開始時刻を核にする
      ...commentRows
        .filter(() => commentClipRows.length === 0)
        .map((r) => {
          const base = r.composeStartMs ?? r.tMs;
          return { startMs: Math.max(0, base - config.buttonClipBeforeMs), endMs: r.tMs };
        }),
    ];
    if (cores.length === 0) {
      return reply.code(409).send({ error: '生徒の反応が無いため章を作れません' });
    }

    const slideEvents = await db
      .select({ tMs: schema.timelineEvents.tMs })
      .from(schema.timelineEvents)
      .where(and(eq(schema.timelineEvents.lessonId, id), eq(schema.timelineEvents.type, 'slide_change')))
      .orderBy(asc(schema.timelineEvents.tMs));

    const ranges = buildRanges(
      cores,
      slideEvents.map((e) => e.tMs),
      durationMs
    );

    // 全体文字起こしがあれば使い回し、無ければ章ごとに文字起こしする
    const [fullRow] = await db
      .select()
      .from(schema.transcripts)
      .where(and(eq(schema.transcripts.lessonId, id), eq(schema.transcripts.scope, 'full')))
      .orderBy(desc(schema.transcripts.createdAt))
      .limit(1);
    const segments = (fullRow?.segments ?? null) as TranscriptSegment[] | null;

    await db.delete(schema.reviewChapters).where(eq(schema.reviewChapters.lessonId, id));
    const chapters: ReviewChapter[] = [];
    for (let i = 0; i < ranges.length; i++) {
      const r = ranges[i];
      const text = await chapterText(id, segments, r.startMs, r.endMs);
      const desc = text ? await describeChapter(text) : null;
      const row = {
        id: crypto.randomUUID(),
        lessonId: id,
        position: i + 1,
        startMs: r.startMs,
        endMs: r.endMs,
        title: desc?.title || `${Math.floor(r.startMs / 60_000)}分ごろの説明`,
        description: desc?.description || null,
        included: true,
      };
      await db.insert(schema.reviewChapters).values(row);
      chapters.push(rowToChapter({ ...row, createdAt: new Date() }));
    }
    return chapters;
  });

  // ---- 先生: 章の編集（公開する/しない・見出し・範囲） ----
  app.patch('/api/lessons/:id/review-video/chapters/:chapterId', { preHandler: requireTeacher }, async (req, reply) => {
    const { id, chapterId } = req.params as { id: string; chapterId: string };
    const lesson = await ownLesson(req, reply, id);
    if (!lesson) return;
    const body = (req.body ?? {}) as Partial<Pick<ReviewChapter, 'included' | 'title' | 'startMs' | 'endMs'>>;
    const patch: Record<string, unknown> = {};
    if (typeof body.included === 'boolean') patch.included = body.included;
    if (typeof body.title === 'string' && body.title.trim()) patch.title = body.title.trim().slice(0, 80);
    if (typeof body.startMs === 'number' && body.startMs >= 0) patch.startMs = Math.round(body.startMs);
    if (typeof body.endMs === 'number' && body.endMs > 0) patch.endMs = Math.round(body.endMs);
    if (Object.keys(patch).length === 0) return reply.code(400).send({ error: '変更内容がありません' });

    await db
      .update(schema.reviewChapters)
      .set(patch)
      .where(and(eq(schema.reviewChapters.id, chapterId), eq(schema.reviewChapters.lessonId, id)));
    return listChapters(id);
  });

  // ---- 先生: 章の並び替え（idを新しい順序で受け取る） ----
  app.post('/api/lessons/:id/review-video/reorder', { preHandler: requireTeacher }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const lesson = await ownLesson(req, reply, id);
    if (!lesson) return;
    const { ids } = (req.body ?? {}) as { ids?: unknown };
    if (!Array.isArray(ids) || ids.some((x) => typeof x !== 'string')) {
      return reply.code(400).send({ error: '並び順が不正です' });
    }
    for (let i = 0; i < ids.length; i++) {
      await db
        .update(schema.reviewChapters)
        .set({ position: i + 1 })
        .where(and(eq(schema.reviewChapters.id, ids[i] as string), eq(schema.reviewChapters.lessonId, id)));
    }
    return listChapters(id);
  });

  // ---- 先生: 生徒へ公開 / 公開停止 ----
  app.post('/api/lessons/:id/review-video/publish', { preHandler: requireTeacher }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const lesson = await ownLesson(req, reply, id);
    if (!lesson) return;
    const included = (await listChapters(id)).filter((c) => c.included);
    if (included.length === 0) {
      return reply.code(409).send({ error: '公開する章がありません' });
    }
    const token = lesson.reviewShareToken ?? newShareToken();
    const publishedAt = new Date();
    await db
      .update(schema.lessons)
      .set({ reviewShareToken: token, reviewPublishedAt: publishedAt })
      .where(eq(schema.lessons.id, id));
    return { shareToken: token, publishedAt: publishedAt.toISOString() };
  });

  app.post('/api/lessons/:id/review-video/unpublish', { preHandler: requireTeacher }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const lesson = await ownLesson(req, reply, id);
    if (!lesson) return;
    // トークンは破棄する（再公開時は新しいURLになる）
    await db
      .update(schema.lessons)
      .set({ reviewShareToken: null, reviewPublishedAt: null })
      .where(eq(schema.lessons.id, id));
    return { shareToken: null, publishedAt: null };
  });

  // ================= 生徒向け公開ページ（ログイン不要・トークンのみ） =================
  // 生徒の反応・コメント・氏名は一切返さない
  async function lessonByToken(
    token: string,
    reply: FastifyReply
  ): Promise<typeof schema.lessons.$inferSelect | null> {
    const [lesson] = await db
      .select()
      .from(schema.lessons)
      .where(eq(schema.lessons.reviewShareToken, token));
    if (!lesson || !lesson.reviewPublishedAt) {
      reply.code(404).send({ error: 'この復習ページは公開されていません' });
      return null;
    }
    return lesson;
  }

  app.get('/api/watch/:token', async (req, reply) => {
    const { token } = req.params as { token: string };
    const lesson = await lessonByToken(token, reply);
    if (!lesson) return;

    const chapters = (await listChapters(lesson.id)).filter((c) => c.included);
    const slides = await loadSlides(lesson.id);
    const rows = await db
      .select({
        id: schema.timelineEvents.id,
        tMs: schema.timelineEvents.tMs,
        type: schema.timelineEvents.type,
        payload: schema.timelineEvents.payload,
      })
      .from(schema.timelineEvents)
      .where(eq(schema.timelineEvents.lessonId, lesson.id))
      .orderBy(asc(schema.timelineEvents.tMs));

    const events = rows as unknown as TimelineEvent[];
    const page: WatchPage = {
      title: lesson.title,
      chapters,
      slides,
      events,
      audioParts: rows
        .filter((e) => e.type === 'audio_part')
        .map((e) => ({ file: (e.payload as { file: string }).file, startMs: e.tMs })),
      durationMs: lesson.audioDurationMs ?? 0,
    };
    return page;
  });

  app.get('/api/watch/:token/pdf', async (req, reply) => {
    const { token } = req.params as { token: string };
    const lesson = await lessonByToken(token, reply);
    if (!lesson) return;
    const file = pdfPath(lesson.id);
    if (!fs.existsSync(file)) return reply.code(404).send({ error: 'PDFがありません' });
    reply.header('Content-Type', 'application/pdf');
    reply.header('Cache-Control', 'private, max-age=3600');
    return reply.send(fs.createReadStream(file));
  });

  app.get('/api/watch/:token/audio/:file', async (req, reply) => {
    const { token, file } = req.params as { token: string; file: string };
    const lesson = await lessonByToken(token, reply);
    if (!lesson) return;
    // パストラバーサル防止: レッスンディレクトリ直下の audio_*.webm のみ許可
    if (!/^audio_\d+\.webm$/.test(file)) {
      return reply.code(400).send({ error: '不正なファイル名です' });
    }
    const filePath = path.join(lessonDir(lesson.id), file);
    if (!fs.existsSync(filePath)) return reply.code(404).send({ error: '音声がありません' });

    const stat = await fs.promises.stat(filePath);
    const range = req.headers.range;
    reply.header('Accept-Ranges', 'bytes');
    reply.header('Content-Type', 'audio/webm');
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (m) {
        const start = m[1] ? parseInt(m[1], 10) : 0;
        const end = m[2] ? Math.min(parseInt(m[2], 10), stat.size - 1) : stat.size - 1;
        if (start <= end) {
          reply.code(206);
          reply.header('Content-Range', `bytes ${start}-${end}/${stat.size}`);
          reply.header('Content-Length', end - start + 1);
          return reply.send(fs.createReadStream(filePath, { start, end }));
        }
      }
    }
    reply.header('Content-Length', stat.size);
    return reply.send(fs.createReadStream(filePath));
  });
}
