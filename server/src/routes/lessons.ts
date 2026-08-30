import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { and, asc, desc, eq } from 'drizzle-orm';
import { PDFDocument } from 'pdf-lib';
import { DEFAULT_REACTION_BUTTONS, type ReactionButtonDef } from '@shared';
import { db, schema } from '../db';
import { requireTeacher, teacherIdOf, verifyParticipantToken } from '../auth';
import { pdfPath, lessonDir, lessonDirPath } from '../storage';
import { loadSlides, forgetSession } from '../live/liveSessions';
import { forgetAnonymousNames } from '../anonymousName';
import { listCommentInsights } from '../live/commentInsights';

// 授業コード（4文字）の文字セット。
// - 紛らわしい文字（0/O, 1/I/L）を除外
// - 母音（A/E/I/O/U）とYを除外 → 単語として読める文字列が生まれない
//   （1文字打ち間違えても母音は現れないため「1文字違いで意味のある語」も起こらない）
const CODE_LETTERS = 'BCDFGHJKMNPQRSTVWXZ';
const CODE_DIGITS = '23456789';
const CODE_CHARS = CODE_LETTERS + CODE_DIGITS;
// 母音なしでも意味を連想させる略語は避ける
const CODE_BLOCKLIST = ['FCK', 'FKN', 'FGT', 'NGR', 'KKK', 'SHT', 'WTF', 'CNT', 'DCK', 'PNS', 'SS'];

/**
 * 教室モニター用の短いコード（6文字）。
 *
 * トークン入りのURLは100文字ほどになるため、教室モニター向けに6文字の短縮コードを発行する。
 * 授業コードと同じ文字セット（紛らわしい字と母音を除いたもの）を使い、
 * 桁だけ増やして総当たりを実用的でなくする（27^6 ≒ 3.9億通り）。
 */
function generateScreenCode(): string {
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
  }
  return code;
}

function generateJoinCode(): string {
  for (;;) {
    let code = '';
    for (let i = 0; i < 4; i++) {
      code += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    }
    // 数字を最低1つ含める（4文字すべてが子音の並びになるのを防ぐ）
    if (![...code].some((c) => CODE_DIGITS.includes(c))) continue;
    if (CODE_BLOCKLIST.some((w) => code.includes(w))) continue;
    return code;
  }
}

/**
 * まだ使われていない授業コードを1つ選ぶ。空きが尽きていれば null を返す。
 *
 * 4文字・27種の文字から作るので、数字を1つ以上含む条件を満たす組み合わせは約40万通りある。
 * 一方 `lessons.join_code` は UNIQUE 制約付きで、授業を削除するまではコードを再利用しない。
 * つまり保存されている授業の数だけ空きが減っていく方式になっている。
 *
 * 学校で使う規模なら、この40万通りが埋まることは実際には起きない。
 * それでも空きを数え切れる形にしてあるのは、埋まりかけたときに
 * **重複したコードのまま INSERT して UNIQUE 制約で落ちる**のを避けるため。
 * 使用中のコードを一度に引いて突き合わせ、空きが無いことは呼び出し側へ伝える。
 */
async function pickJoinCode(): Promise<string | null> {
  const rows = await db.select({ joinCode: schema.lessons.joinCode }).from(schema.lessons);
  const used = new Set(rows.map((r) => r.joinCode));
  // 空きが十分にある限り1回目で決まる。上限は、埋まりかけたときに固まらないための保険
  for (let i = 0; i < 500; i++) {
    const code = generateJoinCode();
    if (!used.has(code)) return code;
  }
  return null;
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
  // 教室モニター（表示専用。スライドを描くためにPDFと授業情報だけ読めればよい）
  const screenToken = req.headers['x-screen-token'];
  if (lesson.screenToken && typeof screenToken === 'string') {
    // 長さは**バイト数**で比べる。文字数（String.length）で比べると、
    // マルチバイトの混ざったトークンを送られたときにバイト長が食い違い、
    // timingSafeEqual が例外を投げて 401 ではなく 500 になる
    const given = Buffer.from(screenToken, 'utf8');
    const want = Buffer.from(lesson.screenToken, 'utf8');
    if (given.length === want.length && crypto.timingSafeEqual(given, want)) return lesson;
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
    aiSettings: l.aiSettings,
  };
}

export async function lessonRoutes(app: FastifyInstance): Promise<void> {
  // ---- 授業作成（PDFアップロード込み・multipart） ----
  app.post('/api/lessons', { preHandler: requireTeacher }, async (req, reply) => {
    const parts = req.parts();
    let title = '';
    let buttons: ReactionButtonDef[] = DEFAULT_REACTION_BUTTONS;
    // ボタンを使わない授業。定義そのものは保存しておき、後から使いたくなったら戻せる
    let reactionsEnabled = true;
    const pdfBuffers: Buffer[] = [];

    for await (const part of parts) {
      if (part.type === 'file' && part.fieldname === 'pdf') {
        pdfBuffers.push(await part.toBuffer());
      } else if (part.type === 'field' && part.fieldname === 'title') {
        title = String(part.value).trim();
      } else if (part.type === 'field' && part.fieldname === 'reactionsEnabled') {
        reactionsEnabled = String(part.value) !== 'false';
      } else if (part.type === 'field' && part.fieldname === 'reactionButtons') {
        let value: unknown;
        try {
          value = JSON.parse(String(part.value));
        } catch {
          return reply.code(400).send({ error: 'リアクションボタンの設定が不正です' });
        }
        const parsed = buttonsSchema.safeParse(value);
        if (!parsed.success) {
          return reply.code(400).send({ error: 'リアクションボタンの設定が不正です' });
        }
        buttons = parsed.data;
      }
    }

    if (!title) return reply.code(400).send({ error: 'タイトルを入力してください' });
    if (pdfBuffers.length === 0) {
      return reply.code(400).send({ error: 'スライドPDFを選択してください' });
    }

    // 複数PDFは1つに結合して保存する（授業中はページ送りだけでPDFを跨げる）。
    // 1ファイルのときは元のバイト列をそのまま保存し、再保存による劣化を避ける
    let pdfBuffer: Buffer;
    let pageCount = 0;
    try {
      if (pdfBuffers.length === 1) {
        pdfBuffer = pdfBuffers[0];
        const doc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
        pageCount = doc.getPageCount();
      } else {
        const merged = await PDFDocument.create();
        for (const buf of pdfBuffers) {
          const src = await PDFDocument.load(buf, { ignoreEncryption: true });
          const pages = await merged.copyPages(src, src.getPageIndices());
          for (const p of pages) merged.addPage(p);
        }
        pageCount = merged.getPageCount();
        pdfBuffer = Buffer.from(await merged.save());
      }
    } catch {
      return reply.code(400).send({ error: 'PDFファイルとして読み込めませんでした' });
    }
    if (pageCount === 0) return reply.code(400).send({ error: 'PDFにページがありません' });

    // コードの確保はPDFを書き出す前に済ませる。
    // あとで失敗すると、授業として登録されないPDFが DATA_DIR に残る
    const joinCode = await pickJoinCode();
    if (!joinCode) {
      return reply
        .code(503)
        .send({ error: '授業コードの空きがありません。管理者にご連絡ください' });
    }

    const lessonId = crypto.randomUUID();
    await fs.promises.writeFile(pdfPath(lessonId), pdfBuffer);

    await db.insert(schema.lessons).values({
      id: lessonId,
      teacherId: teacherIdOf(req),
      title,
      joinCode,
      status: 'draft',
      reactionButtons: buttons,
      reactionsEnabled,
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

  /**
   * 教室モニター用のURLトークン。
   * 教室モニターは先生のPCとは別の端末で開く（音声をそこから鳴らすため）ので、
   * 先生のログイン無しに表示だけできるトークンを発行する。
   * この接続は表示専用で、教室モニター側から授業へ何かを送ることはできない。
   */
  app.get('/api/lessons/:id/screen-token', { preHandler: requireTeacher }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const [lesson] = await db
      .select()
      .from(schema.lessons)
      .where(and(eq(schema.lessons.id, id), eq(schema.lessons.teacherId, teacherIdOf(req))));
    if (!lesson) return reply.code(404).send({ error: '授業が見つかりません' });
    if (lesson.screenToken && lesson.screenCode) {
      return { screenToken: lesson.screenToken, screenCode: lesson.screenCode };
    }

    // 途中で短いコードを足したので、トークンだけある古い授業にも後から補う
    const screenToken = lesson.screenToken ?? crypto.randomBytes(16).toString('base64url');
    let screenCode = lesson.screenCode;
    for (let i = 0; !screenCode && i < 20; i++) {
      const candidate = generateScreenCode();
      const [taken] = await db
        .select({ id: schema.lessons.id })
        .from(schema.lessons)
        .where(eq(schema.lessons.screenCode, candidate));
      if (!taken) screenCode = candidate;
    }
    await db
      .update(schema.lessons)
      .set({ screenToken, screenCode })
      .where(eq(schema.lessons.id, id));
    return { screenToken, screenCode };
  });

  /**
   * 短いコードから教室モニターの入口を引く（ログイン不要）。
   *
   * 返すのは表示専用のトークンなので、コードそのものが鍵になる。
   * 終了した授業では引けなくして、コードが後から効き続けないようにする。
   */
  app.get('/api/screen-entry/:code', async (req, reply) => {
    const { code } = req.params as { code: string };
    const [lesson] = await db
      .select({
        id: schema.lessons.id,
        screenToken: schema.lessons.screenToken,
        status: schema.lessons.status,
      })
      .from(schema.lessons)
      .where(eq(schema.lessons.screenCode, code.toUpperCase()));
    if (!lesson || !lesson.screenToken || lesson.status === 'ended') {
      return reply.code(404).send({ error: 'この番号の授業は見つかりません' });
    }
    return { lessonId: lesson.id, screenToken: lesson.screenToken };
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

  /**
   * 授業を消す。
   *
   * 消えるのは、その授業に紐づくものすべて（スライド・録音・反応・コメント・
   * 文字起こし・要約）。**元に戻せない**ので、画面側では確認を挟んでいる。
   *
   * 授業中は消せない。生徒がつないだままの画面が理由も出ずに壊れるうえ、
   * 録音や文字起こしが、消したはずの授業IDへ書きに来るため。
   *
   * 消す順番は**外部キーの子から親へ**。逆にすると外部キー制約で落ちる
   * （本番のPostgreSQLでも開発のPGliteでも同じように拒否される）。
   */
  app.delete('/api/lessons/:id', { preHandler: requireTeacher }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const [lesson] = await db
      .select()
      .from(schema.lessons)
      .where(and(eq(schema.lessons.id, id), eq(schema.lessons.teacherId, teacherIdOf(req))));
    if (!lesson) return reply.code(404).send({ error: '授業が見つかりません' });
    if (lesson.status === 'live') {
      return reply
        .code(409)
        .send({ error: '授業中は削除できません。授業を終了してから削除してください' });
    }

    // メモリ側を先に外す。残っていると、消したあとの授業IDへ書き込もうとする
    forgetSession(id);
    forgetAnonymousNames(id);

    // 子 → 親。並びを変えないこと。
    // ひとまとめのトランザクションにしてあるのは、途中で失敗したときに
    // 「反応だけ消えて授業は一覧に残る」半端な状態を作らないため
    await db.transaction(async (tx) => {
      await tx.delete(schema.pollAnswers).where(eq(schema.pollAnswers.lessonId, id));
      await tx.delete(schema.commentClips).where(eq(schema.commentClips.lessonId, id));
      await tx.delete(schema.reactions).where(eq(schema.reactions.lessonId, id));
      await tx.delete(schema.polls).where(eq(schema.polls.lessonId, id));
      await tx.delete(schema.participants).where(eq(schema.participants.lessonId, id));
      await tx.delete(schema.timelineEvents).where(eq(schema.timelineEvents.lessonId, id));
      await tx.delete(schema.commentInsights).where(eq(schema.commentInsights.lessonId, id));
      await tx.delete(schema.reflectionPoints).where(eq(schema.reflectionPoints.lessonId, id));
      await tx.delete(schema.reviewChapters).where(eq(schema.reviewChapters.lessonId, id));
      await tx.delete(schema.transcripts).where(eq(schema.transcripts.lessonId, id));
      await tx.delete(schema.lessonSlides).where(eq(schema.lessonSlides.lessonId, id));
      await tx.delete(schema.lessonTelemetry).where(eq(schema.lessonTelemetry.lessonId, id));
      await tx.delete(schema.lessons).where(eq(schema.lessons.id, id));
    });

    // ファイルは最後。先に消して行の削除が失敗すると、開けない授業が一覧に残る
    await fs.promises.rm(lessonDirPath(id), { recursive: true, force: true });

    req.log.info({ lessonId: id }, '[lessons] 授業を削除しました');
    return { ok: true };
  });

  // ---- コメント・振り返り一覧（先生画面の初期表示・再接続時の復元用） ----
  app.get('/api/lessons/:id/comment-insights', { preHandler: requireTeacher }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const [lesson] = await db
      .select({ id: schema.lessons.id })
      .from(schema.lessons)
      .where(and(eq(schema.lessons.id, id), eq(schema.lessons.teacherId, teacherIdOf(req))));
    if (!lesson) return reply.code(404).send({ error: '授業が見つかりません' });
    return listCommentInsights(id);
  });

  // ---- リアクション一覧（先生画面「リアクション・コメント」の初期表示・復元用） ----
  // 授業開始からのすべての反応・コメントを時系列で返す
  app.get('/api/lessons/:id/reactions', { preHandler: requireTeacher }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const [lesson] = await db
      .select()
      .from(schema.lessons)
      .where(and(eq(schema.lessons.id, id), eq(schema.lessons.teacherId, teacherIdOf(req))));
    if (!lesson) return reply.code(404).send({ error: '授業が見つかりません' });
    if (!lesson.startedAt) return { items: [] };

    const rows = await db
      .select({
        id: schema.reactions.id,
        tMs: schema.reactions.tMs,
        kind: schema.reactions.kind,
        comment: schema.reactions.comment,
        participantName: schema.participants.displayName,
      })
      .from(schema.reactions)
      .innerJoin(schema.participants, eq(schema.reactions.participantId, schema.participants.id))
      .where(eq(schema.reactions.lessonId, id))
      .orderBy(asc(schema.reactions.tMs));
    return { items: rows };
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

    // パストラバーサル防止: レッスンディレクトリ直下の audio_*.webm / audio_*.mp4 のみ許可
    // （録音の形式は先生の環境によってWebMにもMP4にもなる）
    if (!/^audio_\d+\.(webm|mp4)$/.test(file)) {
      return reply.code(400).send({ error: '不正なファイル名です' });
    }
    const filePath = path.join(lessonDir(id), file);
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
