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

const registerSchema = z.object({
  email: z.string().email('メールアドレスの形式が正しくありません'),
  password: z.string().min(8, 'パスワードは8文字以上にしてください'),
  name: z.string().min(1, '名前を入力してください').max(50),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/auth/register', async (req, reply) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0].message });
    }
    const { email, password, name } = parsed.data;

    const [existing] = await db
      .select({ id: schema.teachers.id })
      .from(schema.teachers)
      .where(eq(schema.teachers.email, email.toLowerCase()));
    if (existing) {
      return reply.code(409).send({ error: 'このメールアドレスは既に登録されています' });
    }

    const id = crypto.randomUUID();
    await db.insert(schema.teachers).values({
      id,
      email: email.toLowerCase(),
      passwordHash: await hashPassword(password),
      name,
    });
    setTeacherSession(reply, id);
    return { id, email: email.toLowerCase(), name };
  });

  app.post('/api/auth/login', async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: '入力内容を確認してください' });
    }
    const { email, password } = parsed.data;
    const [teacher] = await db
      .select()
      .from(schema.teachers)
      .where(eq(schema.teachers.email, email.toLowerCase()));
    if (!teacher || !(await verifyPassword(password, teacher.passwordHash))) {
      return reply.code(401).send({ error: 'メールアドレスまたはパスワードが違います' });
    }
    setTeacherSession(reply, teacher.id);
    return { id: teacher.id, email: teacher.email, name: teacher.name };
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
    return { id: teacher.id, email: teacher.email, name: teacher.name };
  });
}
