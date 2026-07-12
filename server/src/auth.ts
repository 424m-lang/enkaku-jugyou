import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { db, schema } from './db';

const TEACHER_COOKIE = 'teacher_session';

// ---- 先生: パスワード ----
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

// ---- 先生: セッションCookie（署名付き） ----
export function setTeacherSession(reply: FastifyReply, teacherId: string): void {
  reply.setCookie(TEACHER_COOKIE, teacherId, {
    signed: true,
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 30, // 30日
  });
}

export function clearTeacherSession(reply: FastifyReply): void {
  reply.clearCookie(TEACHER_COOKIE, { path: '/' });
}

export function getTeacherId(req: FastifyRequest): string | null {
  const raw = req.cookies[TEACHER_COOKIE];
  if (!raw) return null;
  const result = req.unsignCookie(raw);
  return result.valid ? result.value : null;
}

/** 先生認証が必要なルートの preHandler */
export async function requireTeacher(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const id = getTeacherId(req);
  if (!id) {
    reply.code(401).send({ error: 'ログインが必要です' });
    return;
  }
  (req as FastifyRequest & { teacherId: string }).teacherId = id;
}

export function teacherIdOf(req: FastifyRequest): string {
  return (req as FastifyRequest & { teacherId: string }).teacherId;
}

// ---- 生徒: 参加トークン ----
// 形式: "<participantId>.<secret>"。DBには secret のSHA-256のみ保存
export function generateParticipantToken(participantId: string): {
  token: string;
  tokenHash: string;
} {
  const secret = crypto.randomBytes(24).toString('base64url');
  return {
    token: `${participantId}.${secret}`,
    tokenHash: hashTokenSecret(secret),
  };
}

function hashTokenSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret).digest('hex');
}

export async function verifyParticipantToken(
  token: string | undefined
): Promise<typeof schema.participants.$inferSelect | null> {
  if (!token) return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const participantId = token.slice(0, dot);
  const secret = token.slice(dot + 1);
  const [p] = await db
    .select()
    .from(schema.participants)
    .where(eq(schema.participants.id, participantId));
  if (!p) return null;
  const expected = Buffer.from(p.tokenHash, 'hex');
  const actual = Buffer.from(hashTokenSecret(secret), 'hex');
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    return null;
  }
  return p;
}
