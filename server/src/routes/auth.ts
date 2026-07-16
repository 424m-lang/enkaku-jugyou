import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db';
import {
  hashPassword,
  verifyPassword,
  setTeacherSession,
  clearTeacherSession,
  getTeacherId,
} from '../auth';

// 個人情報を集めない方針: メールアドレスではなく任意のログインIDで登録する
const loginIdSchema = z
  .string()
  .min(3, 'ログインIDは3文字以上にしてください')
  .max(30, 'ログインIDは30文字以内にしてください')
  .regex(/^[a-zA-Z0-9_-]+$/, 'ログインIDは半角英数字・ハイフン・アンダースコアのみ使えます')
  .transform((s) => s.toLowerCase());

const registerSchema = z.object({
  loginId: loginIdSchema,
  password: z.string().min(8, 'パスワードは8文字以上にしてください'),
  name: z.string().min(1, '表示名を入力してください').max(50),
});

const loginSchema = z.object({
  loginId: z.string().transform((s) => s.trim().toLowerCase()),
  password: z.string(),
});

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/auth/register', async (req, reply) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0].message });
    }
    const { loginId, password, name } = parsed.data;

    const [existing] = await db
      .select({ id: schema.teachers.id })
      .from(schema.teachers)
      .where(eq(schema.teachers.loginId, loginId));
    if (existing) {
      return reply.code(409).send({ error: 'このログインIDは既に使われています' });
    }

    const id = crypto.randomUUID();
    await db.insert(schema.teachers).values({
      id,
      loginId,
      passwordHash: await hashPassword(password),
      name,
    });
    setTeacherSession(reply, id);
    return { id, loginId, name };
  });

  app.post('/api/auth/login', async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: '入力内容を確認してください' });
    }
    const { loginId, password } = parsed.data;
    const [teacher] = await db
      .select()
      .from(schema.teachers)
      .where(eq(schema.teachers.loginId, loginId));
    if (!teacher || !(await verifyPassword(password, teacher.passwordHash))) {
      return reply.code(401).send({ error: 'ログインIDまたはパスワードが違います' });
    }
    setTeacherSession(reply, teacher.id);
    return { id: teacher.id, loginId: teacher.loginId, name: teacher.name };
  });

  app.post('/api/auth/logout', async (_req, reply) => {
    clearTeacherSession(reply);
    return { ok: true };
  });

  app.get('/api/auth/me', async (req, reply) => {
    const id = getTeacherId(req);
    if (!id) return reply.code(401).send({ error: '未ログイン' });
    const [teacher] = await db.select().from(schema.teachers).where(eq(schema.teachers.id, id));
    if (!teacher) {
      clearTeacherSession(reply);
      return reply.code(401).send({ error: '未ログイン' });
    }
    return { id: teacher.id, loginId: teacher.loginId, name: teacher.name };
  });
}
