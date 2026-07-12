import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { PDFDocument } from 'pdf-lib';
import { DEFAULT_REACTION_BUTTONS, type ReactionButtonDef } from '@shared';
import { db, schema } from '../db';
import { requireTeacher, teacherIdOf, verifyParticipantToken } from '../auth';
import { pdfPath, lessonDir } from '../storage';
import { loadSlides } from '../live/liveSessions';

// 紛らわしい文字（0/O, 1/I/L）を除いた授業コード
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function generateJoinCode(): string {
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
  }
  return code;
}

const buttonsSchema = z
  .array(
    z.object({
      key: z.string().min(1).max(30),
      label: z.string().min(1).max(20),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    })
  )
  .min(1)
  .max(6);

/** 先生本人 or その授業の参加者であることを確認して lesson を返す */
async function authorizeLessonAccess(
  req: FastifyRequest,
  reply: FastifyReply,
  lessonId: string
): Promise<typeof schema.lessons.$inferSelect | null> {
  const [lesson] = await db.select().from(schema.lessons).where(eq(schema.lessons.id, lessonId));
  if (!lesson) {
    reply.code(404).send({ error: '授業が見つかりません' });
    return null;
  }
  // 先生
  const teacherCookie = req.cookies['teacher_session'];
  if (teacherCookie) {
    const unsigned = req.unsignCookie(teacherCookie);
    if (unsigned.valid && unsigned.value === lesson.teacherId) return lesson;
  }
  // 生徒
  const token = req.headers['x-participant-token'];
  const participant = await verifyParticipantToken(
    typeof token === 'string' ? token : undefined
  );
  if (participant && participant.lessonId === lessonId) return lesson;

  reply.code(403).send({ error: 'アクセス権がありません' });
  return null;
}

function lessonToSummary(l: typeof schema.lessons.$inferSelect) {
  return {
    id: l.id,
    title: l.title,
    joinCode: l.joinCode,
    status: l.status,
    reactionButtons: l.reactionButtons,
    pdfPageCount: l.pdfPageCount,
    startedAt: l.startedAt?.toISOString() ?? null,
    endedAt: l.endedAt?.toISOString() ?? null,
    createdAt: l.createdAt.toISOString(),
    audioDurationMs: l.audioDurationMs,
  };
}

export async function lessonRoutes(app: FastifyInstance): Promise<void> {
  // ---- 授業作成（PDFアップロード込み・multipart） ----
  app.post('/api/lessons', { preHandler: requireTeacher }, async (req, reply) => {
    const parts = req.parts();
    let title = '';
    let buttons: ReactionButtonDef[] = DEFAULT_REACTION_BUTTONS;
    let pdfBuffer: Buffer | null = null;

    for await (const part of parts) {
      if (part.type === 'file' && part.fieldname === 'pdf') {
        pdfBuffer = await part.toBuffer();
      } else if (part.type === 'field' && part.fieldname === 'title') {
        title = String(part.value).trim();
      } else if (part.type === 'field' && part.fieldname === 'reactionButtons') {
        const parsed = buttonsSchema.safeParse(JSON.parse(String(part.value)));
        if (!parsed.success) {
          return reply.code(400).send({ error: 'リアクションボタンの設定が不正です' });
        }
        buttons = parsed.data;
      }
    }

    if (!title) return reply.code(400).send({ error: 'タイトルを入力してください' });
    if (!pdfBuffer) return reply.code(400).send({ error: 'スライドPDFを選択してください' });

    // PDFのページ数を取得（内容の検証も兼ねる）
    let pageCount = 0;
    try {
      const doc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
      pageCount = doc.getPageCount();
    } catch {
      return reply.code(400).send({ error: 'PDFファイルとして読み込めませんでした' });
    }
    if (pageCount === 0) return reply.code(400).send({ error: 'PDFにページがありません' });

    const lessonId = crypto.randomUUID();
    await fs.promises.writeFile(pdfPath(lessonId), pdfBuffer);

    // 授業コードの衝突を避けて生成
    let joinCode = generateJoinCode();
    for (let i = 0; i < 5; i++) {
      const [dup] = await db
        .select({ id: schema.lessons.id })
        .from(schema.lessons)
        .where(eq(schema.lessons.joinCode, joinCode));
      if (!dup) break;
      joinCode = generateJoinCode();
    }

    await db.insert(schema.lessons).values({
      id: lessonId,
      teacherId: teacherIdOf(req),
      title,
      joinCode,
      status: 'draft',
      reactionButtons: buttons,
      pdfPath: pdfPath(lessonId),
      pdfPageCount: pageCount,
    });

    // PDFの各ページをスライドとして登録
    await db.insert(schema.lessonSlides).values(
      Array.from({ length: pageCount }, (_, i) => ({
        id: crypto.randomUUID(),
        lessonId,
        kind: 'pdf_page' as const,
        pdfPageIndex: i,
        position: i + 1,
      }))
    );

    const [lesson] = await db.select().from(schema.lessons).where(eq(schema.lessons.id, lessonId));
    return lessonToSummary(lesson);
  });

  // ---- 授業一覧（先生） ----
  app.get('/api/lessons', { preHandler: requireTeacher }, async (req) => {
    const rows = await db
      .select()
      .from(schema.lessons)
      .where(eq(schema.lessons.teacherId, teacherIdOf(req)))
      .orderBy(desc(schema.lessons.createdAt));
    return rows.map(lessonToSummary);
  });

  // ---- 授業詳細（先生 or 参加生徒） ----
  app.get('/api/lessons/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const lesson = await authorizeLessonAccess(req, reply, id);
    if (!lesson) return;
    const slides = await loadSlides(id);
    return { ...lessonToSummary(lesson), slides };
  });

  // ---- 授業設定の更新（タイトル・ボタン。開始前のみ） ----
  app.patch('/api/lessons/:id', { preHandler: requireTeacher }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const [lesson] = await db
      .select()
      .from(schema.lessons)
      .where(and(eq(schema.lessons.id, id), eq(schema.lessons.teacherId, teacherIdOf(req))));
    if (!lesson) return reply.code(404).send({ error: '授業が見つかりません' });
    if (lesson.status !== 'draft') {
      return reply.code(409).send({ error: '開始後の授業は設定を変更できません' });
    }

    const bodySchema = z.object({
      title: z.string().min(1).max(100).optional(),
      reactionButtons: buttonsSchema.optional(),
    });
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: '入力内容が不正です' });

    await db
      .update(schema.lessons)
      .set({
        ...(parsed.data.title ? { title: parsed.data.title } : {}),
        ...(parsed.data.reactionButtons ? { reactionButtons: parsed.data.reactionButtons } : {}),
      })
      .where(eq(schema.lessons.id, id));
    const [updated] = await db.select().from(schema.lessons).where(eq(schema.lessons.id, id));
    return lessonToSummary(updated);
  });

  // ---- スライドPDFの配信（参加時に一括ダウンロード＆全ページ事前レンダリング） ----
  app.get('/api/lessons/:id/pdf', async (req, reply) => {
    const { id } = req.params as { id: string };
    const lesson = await authorizeLessonAccess(req, reply, id);
    if (!lesson) return;
    const file = pdfPath(id);
    if (!fs.existsSync(file)) return reply.code(404).send({ error: 'PDFがありません' });
    reply.header('Content-Type', 'application/pdf');
    reply.header('Cache-Control', 'private, max-age=3600');
    return reply.send(fs.createReadStream(file));
  });

  // ---- 録音パートの配信（授業後の再生用・Range対応） ----
  app.get('/api/lessons/:id/audio/:file', async (req, reply) => {
    const { id, file } = req.params as { id: string; file: string };
    const lesson = await authorizeLessonAccess(req, reply, id);
    if (!lesson) return;

    // パストラバーサル防止: レッスンディレクトリ直下の audio_*.webm のみ許可
    if (!/^audio_\d+\.webm$/.test(file)) {
      return reply.code(400).send({ error: '不正なファイル名です' });
    }
    const filePath = path.join(lessonDir(id), file);
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
