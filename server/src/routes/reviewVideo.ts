import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, asc, eq } from 'drizzle-orm';
import type {
  ReviewChapter,
  TimelineEvent,
  TimelineEventType,
  TranscriptSegment,
  WatchPage,
} from '@shared';
import { db, schema } from '../db';
import { requireTeacher, teacherIdOf } from '../auth';
import { loadSlides } from '../live/liveSessions';
import { lessonDir, pdfPath } from '../storage';
import { ensureFullTranscript } from '../ai/fullTranscript';
import { describeChapter, segmentLessonIntoBlocks } from '../ai/summarize';
import {
  loadSlideIntervals,
  slideAt,
  slideNumberMap,
  slidesInRange,
  type SlideInterval,
} from '../slideTimeline';

/** AIに渡す1行にまとめる長さの上限（細かすぎると行数が膨らむ） */
const LINE_MAX_MS = 20_000;
/** AIが使えないときのフォールバックで作るブロックの目安の長さ */
const FALLBACK_BLOCK_MS = 240_000;

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
    slideIds: r.slideIds ?? [],
    note: r.note,
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

// ---- AIに渡す発言の行 ----
export type TranscriptLine = {
  startMs: number;
  endMs: number;
  slideId: string | null;
  text: string;
};

/**
 * 文字起こしセグメントを、同じスライドを映している間ごとに20秒程度へまとめる。
 * 行数を抑えつつ、ブロックの切れ目がスライド切替と揃いやすくなる。
 */
export function buildLines(
  segments: TranscriptSegment[],
  intervals: SlideInterval[]
): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  for (const seg of segments) {
    const slideId = slideAt(intervals, seg.startMs);
    const last = lines[lines.length - 1];
    if (last && last.slideId === slideId && seg.endMs - last.startMs <= LINE_MAX_MS) {
      last.endMs = seg.endMs;
      last.text += seg.text;
    } else {
      lines.push({ startMs: seg.startMs, endMs: seg.endMs, slideId, text: seg.text });
    }
  }
  return lines;
}

function fmtClock(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** AIが使えない・失敗したときに、スライドの切れ目を使って機械的にブロックを作る */
export function fallbackBlockStarts(intervals: SlideInterval[], durationMs: number): number[] {
  if (durationMs <= 0) return [];
  const starts = [0];
  for (const iv of intervals) {
    if (iv.startMs - starts[starts.length - 1] >= FALLBACK_BLOCK_MS) starts.push(iv.startMs);
  }
  return starts;
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

  // ---- 先生: PDF各ページの本文を保存（クライアントで抽出したものを受け取る） ----
  // ブロック分けのAIにスライドの内容も参考にさせるために使う
  app.put('/api/lessons/:id/pdf-text', { preHandler: requireTeacher }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const lesson = await ownLesson(req, reply, id);
    if (!lesson) return;
    const { texts } = (req.body ?? {}) as { texts?: unknown };
    if (!Array.isArray(texts) || texts.some((t) => typeof t !== 'string')) {
      return reply.code(400).send({ error: 'PDFテキストが不正です' });
    }
    const trimmed = (texts as string[]).map((t) => t.replace(/\s+/g, ' ').trim().slice(0, 4000));
    await db.update(schema.lessons).set({ pdfPageTexts: trimmed }).where(eq(schema.lessons.id, id));
    return { ok: true, pages: trimmed.length };
  });

  // ---- 先生: 授業全体をブロックに区分けする（既存のブロックは作り直す） ----
  app.post(
    '/api/lessons/:id/review-video/generate',
    { preHandler: requireTeacher },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const lesson = await ownLesson(req, reply, id);
      if (!lesson) return;
      if (!lesson.aiSettings.reviewChapters) {
        return reply.code(409).send({ error: 'この授業では復習動画の自動章分けを使用しない設定です' });
      }
      const durationMs = lesson.audioDurationMs ?? 0;
      if (durationMs <= 0) return reply.code(409).send({ error: '録音がありません' });

      const intervals = await loadSlideIntervals(id, durationMs);
      const segments = await ensureFullTranscript(id, durationMs);

      let starts: number[] = [];
      let described: { title: string; description: string }[] | null = null;

      const lines = buildLines(segments, intervals);
      if (lines.length > 0) {
        const slideNoOf = await slideNumberMap(id);
        const labelled = lines.map((l) => {
          const no = l.slideId ? slideNoOf.get(l.slideId) : undefined;
          return `[${fmtClock(l.startMs)}]${no ? `(スライド${no})` : ''} ${l.text.trim()}`;
        });
        const outline = ((lesson.pdfPageTexts ?? []) as string[])
          .map((t, i) => (t ? `--- スライド${i + 1} ---` + '\n' + t : ''))
          .filter(Boolean)
          .join('\n');
        const blocks = await segmentLessonIntoBlocks(labelled, outline);
        if (blocks) {
          starts = blocks.map((b) => lines[b.startNo - 1].startMs);
          described = blocks.map((b) => ({ title: b.title, description: b.description }));
        }
      }
      if (starts.length === 0) starts = fallbackBlockStarts(intervals, durationMs);
      if (starts.length === 0) return reply.code(409).send({ error: 'ブロックを作れませんでした' });
      starts[0] = 0; // 授業の最初から切れ目なく区分けする

      await db.delete(schema.reviewChapters).where(eq(schema.reviewChapters.lessonId, id));
      const chapters: ReviewChapter[] = [];
      for (let i = 0; i < starts.length; i++) {
        const startMs = starts[i];
        const endMs = i + 1 < starts.length ? starts[i + 1] : durationMs;
        if (endMs <= startMs) continue;
        // AIが区分けできなかった（フォールバック）ときだけ、区間ごとに見出しを作る
        let d = described?.[i] ?? null;
        if (!d) {
          const text = segments
            .filter((s) => s.endMs > startMs && s.startMs < endMs)
            .map((s) => s.text)
            .join('');
          d = text ? await describeChapter(text) : null;
        }
        const row = {
          id: crypto.randomUUID(),
          lessonId: id,
          position: i + 1,
          startMs,
          endMs,
          title: d?.title || `${Math.floor(startMs / 60_000)}分ごろの説明`,
          description: d?.description || null,
          included: true,
          slideIds: slidesInRange(intervals, startMs, endMs),
          note: null,
        };
        await db.insert(schema.reviewChapters).values(row);
        chapters.push(rowToChapter({ ...row, createdAt: new Date() }));
      }
      return chapters;
    }
  );

  // ---- 先生: ブロックを手で足す（AIが分けなかった場所を復習に入れたいとき） ----
  app.post(
    '/api/lessons/:id/review-video/chapters',
    { preHandler: requireTeacher },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const lesson = await ownLesson(req, reply, id);
      if (!lesson) return;
      const body = (req.body ?? {}) as { startMs?: number; endMs?: number; title?: string };
      const startMs = Math.max(0, Math.round(Number(body.startMs)));
      const endMs = Math.round(Number(body.endMs));
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
        return reply.code(400).send({ error: '範囲が不正です' });
      }
      const intervals = await loadSlideIntervals(id, lesson.audioDurationMs ?? endMs);
      const existing = await listChapters(id);
      const row = {
        id: crypto.randomUUID(),
        lessonId: id,
        // 開始時刻の順に並ぶ位置へ入れる
        position: existing.filter((c) => c.startMs <= startMs).length + 0.5,
        startMs,
        endMs,
        title:
          (body.title ?? '').trim().slice(0, 80) || `${Math.floor(startMs / 60_000)}分ごろの説明`,
        description: null,
        included: true,
        slideIds: slidesInRange(intervals, startMs, endMs),
        note: null,
      };
      await db.insert(schema.reviewChapters).values(row);
      return listChapters(id);
    }
  );

  // ---- 先生: ブロックの編集（入れる/入れない・見出し・概要・補足文章・範囲） ----
  app.patch(
    '/api/lessons/:id/review-video/chapters/:chapterId',
    { preHandler: requireTeacher },
    async (req, reply) => {
      const { id, chapterId } = req.params as { id: string; chapterId: string };
      const lesson = await ownLesson(req, reply, id);
      if (!lesson) return;
      const body = (req.body ?? {}) as Partial<
        Pick<ReviewChapter, 'included' | 'title' | 'description' | 'note' | 'startMs' | 'endMs'>
      >;
      const patch: Record<string, unknown> = {};
      if (typeof body.included === 'boolean') patch.included = body.included;
      if (typeof body.title === 'string' && body.title.trim()) {
        patch.title = body.title.trim().slice(0, 80);
      }
      if (typeof body.description === 'string') {
        patch.description = body.description.trim().slice(0, 600) || null;
      }
      if (typeof body.note === 'string') patch.note = body.note.trim().slice(0, 600) || null;
      if (typeof body.startMs === 'number' && body.startMs >= 0) {
        patch.startMs = Math.round(body.startMs);
      }
      if (typeof body.endMs === 'number' && body.endMs > 0) patch.endMs = Math.round(body.endMs);
      if (Object.keys(patch).length === 0) {
        return reply.code(400).send({ error: '変更内容がありません' });
      }

      // 範囲が変わったら、説明していたスライドも取り直す
      if (patch.startMs !== undefined || patch.endMs !== undefined) {
        const [cur] = await db
          .select()
          .from(schema.reviewChapters)
          .where(
            and(eq(schema.reviewChapters.id, chapterId), eq(schema.reviewChapters.lessonId, id))
          );
        if (!cur) return reply.code(404).send({ error: 'ブロックが見つかりません' });
        const startMs = (patch.startMs as number | undefined) ?? cur.startMs;
        const endMs = (patch.endMs as number | undefined) ?? cur.endMs;
        if (endMs <= startMs) return reply.code(400).send({ error: '範囲が不正です' });
        const intervals = await loadSlideIntervals(id, lesson.audioDurationMs ?? endMs);
        patch.slideIds = slidesInRange(intervals, startMs, endMs);
      }

      await db
        .update(schema.reviewChapters)
        .set(patch)
        .where(and(eq(schema.reviewChapters.id, chapterId), eq(schema.reviewChapters.lessonId, id)));
      return listChapters(id);
    }
  );

  // ---- 先生: ブロックを削除 ----
  app.delete(
    '/api/lessons/:id/review-video/chapters/:chapterId',
    { preHandler: requireTeacher },
    async (req, reply) => {
      const { id, chapterId } = req.params as { id: string; chapterId: string };
      const lesson = await ownLesson(req, reply, id);
      if (!lesson) return;
      await db
        .delete(schema.reviewChapters)
        .where(and(eq(schema.reviewChapters.id, chapterId), eq(schema.reviewChapters.lessonId, id)));
      return listChapters(id);
    }
  );

  // ---- 先生: ブロックの見出し・概要をAIで作り直す（手で足したブロック用） ----
  app.post(
    '/api/lessons/:id/review-video/chapters/:chapterId/describe',
    { preHandler: requireTeacher },
    async (req, reply) => {
      const { id, chapterId } = req.params as { id: string; chapterId: string };
      const lesson = await ownLesson(req, reply, id);
      if (!lesson) return;
      if (!lesson.aiSettings.reviewChapters) {
        return reply.code(409).send({ error: 'この授業では復習動画の自動章分けを使用しない設定です' });
      }
      const [cur] = await db
        .select()
        .from(schema.reviewChapters)
        .where(and(eq(schema.reviewChapters.id, chapterId), eq(schema.reviewChapters.lessonId, id)));
      if (!cur) return reply.code(404).send({ error: 'ブロックが見つかりません' });

      const segments = await ensureFullTranscript(id, lesson.audioDurationMs ?? cur.endMs);
      const text = segments
        .filter((s) => s.endMs > cur.startMs && s.startMs < cur.endMs)
        .map((s) => s.text)
        .join('');
      if (!text) return reply.code(409).send({ error: 'この範囲の文字起こしがありません' });
      const d = await describeChapter(text);
      if (!d) return reply.code(409).send({ error: '概要を作れませんでした' });
      await db
        .update(schema.reviewChapters)
        .set({ title: d.title.slice(0, 80), description: d.description.slice(0, 600) || null })
        .where(eq(schema.reviewChapters.id, chapterId));
      return listChapters(id);
    }
  );

  // ---- 先生: ブロックの並び替え（idを新しい順序で受け取る） ----
  app.post(
    '/api/lessons/:id/review-video/reorder',
    { preHandler: requireTeacher },
    async (req, reply) => {
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
          .where(
            and(
              eq(schema.reviewChapters.id, ids[i] as string),
              eq(schema.reviewChapters.lessonId, id)
            )
          );
      }
      return listChapters(id);
    }
  );

  // ---- 先生: 生徒へ公開 / 公開停止 ----
  app.post(
    '/api/lessons/:id/review-video/publish',
    { preHandler: requireTeacher },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const lesson = await ownLesson(req, reply, id);
      if (!lesson) return;
      const included = (await listChapters(id)).filter((c) => c.included);
      if (included.length === 0) {
        return reply.code(409).send({ error: '公開するブロックがありません' });
      }
      const token = lesson.reviewShareToken ?? newShareToken();
      const publishedAt = new Date();
      await db
        .update(schema.lessons)
        .set({ reviewShareToken: token, reviewPublishedAt: publishedAt })
        .where(eq(schema.lessons.id, id));
      return { shareToken: token, publishedAt: publishedAt.toISOString() };
    }
  );

  app.post(
    '/api/lessons/:id/review-video/unpublish',
    { preHandler: requireTeacher },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const lesson = await ownLesson(req, reply, id);
      if (!lesson) return;
      // トークンは破棄する（再公開時は新しいURLになる）
      await db
        .update(schema.lessons)
        .set({ reviewShareToken: null, reviewPublishedAt: null })
        .where(eq(schema.lessons.id, id));
      return { shareToken: null, publishedAt: null };
    }
  );

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

    // 公開ページに必要なのは表示の再現だけ。タスク進捗・字幕・内部イベントは、
    // UIが使わなくてもJSONを直接見れば読めるため、公開APIへ含めない。
    const publicEventTypes = new Set<TimelineEventType>([
      'slide_change',
      'stroke',
      'clear_slide',
      'pointer',
    ]);
    const events = rows.filter((e) =>
      publicEventTypes.has(e.type as TimelineEventType)
    ) as unknown as TimelineEvent[];
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
    // パストラバーサル防止: レッスンディレクトリ直下の audio_*.webm / audio_*.mp4 のみ許可
    // （録音の形式は先生の環境によってWebMにもMP4にもなる）
    if (!/^audio_\d+\.(webm|mp4)$/.test(file)) {
      return reply.code(400).send({ error: '不正なファイル名です' });
    }
    const filePath = path.join(lessonDir(lesson.id), file);
    if (!fs.existsSync(filePath)) return reply.code(404).send({ error: '音声がありません' });

    const stat = await fs.promises.stat(filePath);
    const range = req.headers.range;
    reply.header('Accept-Ranges', 'bytes');
    reply.header('Content-Type', file.endsWith('.mp4') ? 'audio/mp4' : 'audio/webm');
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
