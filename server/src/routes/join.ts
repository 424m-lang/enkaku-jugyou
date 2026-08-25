import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db';
import { generateParticipantToken } from '../auth';

const joinSchema = z.object({
  code: z
    .string()
    .min(4)
    .max(12)
    .transform((s) => s.trim().toUpperCase()),
  displayName: z.string().trim().min(1, '表示名を入力してください').max(30),
});

export async function joinRoutes(app: FastifyInstance): Promise<void> {
  // 生徒の参加: 授業コード + 表示名のみ（アカウント不要）
  app.post('/api/join', async (req, reply) => {
    const parsed = joinSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0].message });
    }
    const { code, displayName } = parsed.data;

    const [lesson] = await db
      .select()
      .from(schema.lessons)
      .where(eq(schema.lessons.joinCode, code));
    if (!lesson) {
      return reply.code(404).send({ error: '授業コードが見つかりません' });
    }
    if (lesson.status === 'ended') {
      return reply.code(410).send({ error: 'この授業は終了しています' });
    }

    const participantId = crypto.randomUUID();
    const { token, tokenHash } = generateParticipantToken(participantId);
    await db.insert(schema.participants).values({
      id: participantId,
      lessonId: lesson.id,
      displayName,
      tokenHash,
    });

    return {
      participantToken: token,
      lesson: {
        id: lesson.id,
        title: lesson.title,
        status: lesson.status,
        reactionButtons: lesson.reactionButtons,
      },
    };
  });
}
