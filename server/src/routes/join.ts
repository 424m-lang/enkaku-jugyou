import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db';
import { generateParticipantToken, verifyParticipantToken } from '../auth';
import { generateAnonymousName, noteAnonymousName } from '../anonymousName';

const joinSchema = z.object({
  code: z
    .string()
    .min(4)
    .max(12)
    .transform((s) => s.trim().toUpperCase()),
  // 名前は任意。空で来たら、この授業の中だけで通じる仮名をサーバが付ける。
  // 個人情報を集めない方針を「許す」から「既定」にするための扱い
  displayName: z.string().trim().max(30, '名前は30文字以内にしてください').optional(),
  /**
   * 「続きから参加」で送られてくる、前回この端末が受け取ったトークン。
   * タブを閉じると sessionStorage が消えて別の生徒になってしまうため、
   * 生徒が選んだときだけ同じ参加者へ戻せるようにする
   */
  resumeToken: z.string().max(200).optional(),
});

const resumeCheckSchema = z.object({
  code: z
    .string()
    .min(4)
    .max(12)
    .transform((s) => s.trim().toUpperCase()),
  resumeToken: z.string().max(200),
});

export async function joinRoutes(app: FastifyInstance): Promise<void> {
  /**
   * 「続きから参加できるか」を、参加する前に確かめる。
   *
   * 端末に残っているのは文字列だけで、それがまだ通用するかは端末側では分からない
   * （トークンの照合には参加者テーブルが要る）。控えだけを見て
   * 「前回は青いイヌとして参加していました」と出すと、DBを入れ替えたあとや
   * 授業を作り直したあとに、いま存在しない参加者の名前を見せてしまう。
   * そのため「このトークンがこの授業のものか」は毎回サーバに確かめさせる。
   * 終了した授業でも案内は出さない。
   *
   * トークンをURLに載せないため GET ではなく POST にしている。
   */
  app.post('/api/join/resume-check', async (req) => {
    const parsed = resumeCheckSchema.safeParse(req.body);
    if (!parsed.success) return { canResume: false };

    const [lesson] = await db
      .select()
      .from(schema.lessons)
      .where(eq(schema.lessons.joinCode, parsed.data.code));
    if (!lesson || lesson.status === 'ended') return { canResume: false };

    const prev = await verifyParticipantToken(parsed.data.resumeToken);
    if (!prev || prev.lessonId !== lesson.id) return { canResume: false };

    return { canResume: true, displayName: prev.displayName };
  });

  // 生徒の参加: 授業コードのみで入れる（アカウント不要・名前も任意）
  app.post('/api/join', async (req, reply) => {
    const parsed = joinSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0].message });
    }
    const { code } = parsed.data;

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

    const lessonPayload = {
      id: lesson.id,
      title: lesson.title,
      status: lesson.status,
      reactionButtons: lesson.reactionButtons,
    };

    // 「続きから」: 前回のトークンがこの授業のものなら、同じ参加者として戻す。
    // 期限切れや別授業のものだった場合は、そのまま下の新規参加へ落とす。
    //
    // **仮名を作る前に**確かめる。先に作ってしまうと、ここで戻る生徒の分まで
    // 仮名を1つ使ったことにしてしまい、その授業で配れる名前が読み込み直すたびに減る
    if (parsed.data.resumeToken) {
      const prev = await verifyParticipantToken(parsed.data.resumeToken);
      if (prev && prev.lessonId === lesson.id) {
        await db
          .update(schema.participants)
          .set({ lastSeenAt: new Date() })
          .where(eq(schema.participants.id, prev.id));
        return {
          participantToken: parsed.data.resumeToken,
          displayName: prev.displayName,
          lesson: lessonPayload,
        };
      }
    }

    // 入力があればそれを使い、無ければ「青いネコ」のような仮名を配る
    const displayName =
      parsed.data.displayName || (await generateAnonymousName(lesson.id));
    // 自分で入れた名前も、仮名として配られないように控えておく
    if (parsed.data.displayName) await noteAnonymousName(lesson.id, displayName);

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
      // 仮名を配った場合、生徒は自分がどう呼ばれているかを知る手段がないので返す
      displayName,
      lesson: lessonPayload,
    };
  });
}
