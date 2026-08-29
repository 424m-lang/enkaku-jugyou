import crypto from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import type { Poll, PollAnswer, PollOption, PollResults, PollType, PublicPoll } from '@shared';
import { MAX_POLL_OPTIONS, MAX_POLLS, scaleOptions } from '@shared';
import { db, schema } from '../db';
import { tMs, type LiveSession } from './liveSessions';

type PollRow = typeof schema.polls.$inferSelect;

function toPoll(row: PollRow): Poll {
  return {
    id: row.id,
    question: row.question,
    type: row.type,
    options: row.options,
    minLabel: row.minLabel,
    maxLabel: row.maxLabel,
    status: row.status,
    openedAtMs: row.openedAtMs,
    closedAtMs: row.closedAtMs,
    position: row.position,
  };
}

/** 生徒に配る形。設問そのものは公開してよいが、他の設問と集計は含めない */
export function toPublicPoll(p: Poll): PublicPoll {
  return {
    id: p.id,
    question: p.question,
    type: p.type,
    options: p.options,
    minLabel: p.minLabel,
    maxLabel: p.maxLabel,
  };
}

export async function loadPolls(lessonId: string): Promise<Poll[]> {
  const rows = await db
    .select()
    .from(schema.polls)
    .where(eq(schema.polls.lessonId, lessonId))
    .orderBy(asc(schema.polls.position));
  return rows.map(toPoll);
}

/** 授業中の回答をメモリへ読み戻す（サーバ再起動後の復元用） */
export async function loadPollAnswers(
  lessonId: string
): Promise<Map<string, Map<string, PollAnswer>>> {
  const rows = await db
    .select()
    .from(schema.pollAnswers)
    .where(eq(schema.pollAnswers.lessonId, lessonId));
  const out = new Map<string, Map<string, PollAnswer>>();
  for (const r of rows) {
    let byParticipant = out.get(r.pollId);
    if (!byParticipant) {
      byParticipant = new Map();
      out.set(r.pollId, byParticipant);
    }
    byParticipant.set(r.participantId, { optionIds: r.optionIds, text: r.text });
  }
  return out;
}

function normalizeOptions(
  type: PollType,
  input: { id?: string; label: string }[] | undefined,
  existing: PollOption[]
): PollOption[] {
  if (type === 'text') return [];
  if (type === 'scale') {
    // 段階の数だけが意味を持つ。ラベルは 1..N の連番で作り直す
    const n = Math.min(Math.max(input?.length ?? 5, 2), MAX_POLL_OPTIONS);
    return scaleOptions(n);
  }
  const known = new Map(existing.map((o) => [o.id, o]));
  const out: PollOption[] = [];
  for (const item of (input ?? []).slice(0, MAX_POLL_OPTIONS)) {
    const label = String(item.label ?? '').trim().slice(0, 60);
    if (!label) continue;
    const prev = item.id ? known.get(item.id) : undefined;
    out.push(prev ? { ...prev, label } : { id: crypto.randomUUID(), label });
  }
  return out;
}

export async function savePoll(
  s: LiveSession,
  input: {
    id?: string;
    question: string;
    type: PollType;
    options?: { id?: string; label: string }[];
    minLabel?: string | null;
    maxLabel?: string | null;
  }
): Promise<{ poll?: Poll; error?: string }> {
  const question = String(input.question ?? '').trim().slice(0, 200);
  if (!question) return { error: '質問を入力してください' };

  const existing = input.id ? s.polls.find((p) => p.id === input.id) : undefined;
  if (input.id && !existing) return { error: '設問が見つかりません' };
  if (!existing && s.polls.length >= MAX_POLLS) {
    return { error: `設問は${MAX_POLLS}問までです` };
  }
  // 回答が集まった後に選択肢を組み替えると集計の意味が変わるため、開始後は編集させない
  if (existing && existing.status !== 'draft') {
    return { error: '開始したアンケートは編集できません' };
  }

  const options = normalizeOptions(input.type, input.options, existing?.options ?? []);
  if (input.type !== 'text' && options.length < 2) {
    return { error: '選択肢を2つ以上入力してください' };
  }

  const minLabel = input.minLabel?.trim().slice(0, 30) || null;
  const maxLabel = input.maxLabel?.trim().slice(0, 30) || null;

  if (existing) {
    await db
      .update(schema.polls)
      .set({ question, type: input.type, options, minLabel, maxLabel })
      .where(eq(schema.polls.id, existing.id));
  } else {
    const position = s.polls.length > 0 ? Math.max(...s.polls.map((p) => p.position)) + 1 : 0;
    await db.insert(schema.polls).values({
      id: crypto.randomUUID(),
      lessonId: s.lessonId,
      question,
      type: input.type,
      options,
      minLabel,
      maxLabel,
      position,
    });
  }
  s.polls = await loadPolls(s.lessonId);
  const saved = existing
    ? s.polls.find((p) => p.id === existing.id)
    : s.polls[s.polls.length - 1];
  return { poll: saved };
}

export async function deletePoll(s: LiveSession, pollId: string): Promise<void> {
  const poll = s.polls.find((p) => p.id === pollId);
  if (!poll) return;
  await db
    .delete(schema.pollAnswers)
    .where(
      and(
        eq(schema.pollAnswers.pollId, pollId),
        eq(schema.pollAnswers.lessonId, s.lessonId)
      )
    );
  await db
    .delete(schema.polls)
    .where(and(eq(schema.polls.id, pollId), eq(schema.polls.lessonId, s.lessonId)));
  s.polls = await loadPolls(s.lessonId);
  s.pollAnswers.delete(pollId);
  if (s.openPollId === pollId) s.openPollId = null;
}

/** 開始。同時に開けるのは1問だけなので、他が開いていれば先に締め切る */
export async function openPoll(s: LiveSession, pollId: string): Promise<Poll | null> {
  const poll = s.polls.find((p) => p.id === pollId);
  if (!poll) return null;
  if (s.openPollId && s.openPollId !== pollId) await closePoll(s, s.openPollId);

  const openedAtMs = tMs(s);
  await db
    .update(schema.polls)
    .set({ status: 'open', openedAtMs, closedAtMs: null })
    .where(eq(schema.polls.id, pollId));
  s.polls = await loadPolls(s.lessonId);
  s.openPollId = pollId;
  return s.polls.find((p) => p.id === pollId) ?? null;
}

export async function closePoll(s: LiveSession, pollId: string): Promise<void> {
  if (!s.polls.some((p) => p.id === pollId)) return;
  await db
    .update(schema.polls)
    .set({ status: 'closed', closedAtMs: tMs(s) })
    .where(and(eq(schema.polls.id, pollId), eq(schema.polls.lessonId, s.lessonId)));
  s.polls = await loadPolls(s.lessonId);
  if (s.openPollId === pollId) s.openPollId = null;
}

/**
 * 回答の記録。同じ生徒の回答は上書きするので、押し直しても票は増えない。
 * 締め切りまで何度でも変更できるのは、タスクと同じく誤操作を確認ダイアログではなく
 * 「やり直せること」で受けるため。
 */
export async function recordPollAnswer(
  s: LiveSession,
  participantId: string,
  pollId: string,
  input: { optionIds?: string[]; text?: string }
): Promise<PollAnswer | null> {
  const poll = s.polls.find((p) => p.id === pollId);
  if (!poll || poll.status !== 'open') return null;

  let answer: PollAnswer;
  if (poll.type === 'text') {
    const text = String(input.text ?? '').trim().slice(0, 500);
    if (!text) return null;
    answer = { optionIds: [], text };
  } else {
    const valid = new Set(poll.options.map((o) => o.id));
    const ids = (input.optionIds ?? []).filter((id) => valid.has(id));
    // 単一選択・段階評価で複数届いた場合は最初の1つだけを採る
    const optionIds = poll.type === 'multiple' ? [...new Set(ids)] : ids.slice(0, 1);
    if (optionIds.length === 0) return null;
    answer = { optionIds, text: null };
  }

  await db
    .insert(schema.pollAnswers)
    .values({
      id: crypto.randomUUID(),
      pollId,
      lessonId: s.lessonId,
      participantId,
      optionIds: answer.optionIds,
      text: answer.text,
      answeredAtMs: tMs(s),
    })
    .onConflictDoUpdate({
      target: [schema.pollAnswers.pollId, schema.pollAnswers.participantId],
      set: { optionIds: answer.optionIds, text: answer.text, answeredAtMs: tMs(s) },
    });

  let byParticipant = s.pollAnswers.get(pollId);
  if (!byParticipant) {
    byParticipant = new Map();
    s.pollAnswers.set(pollId, byParticipant);
  }
  byParticipant.set(participantId, answer);
  return answer;
}

export function myPollAnswer(
  s: LiveSession,
  participantId: string,
  pollId: string
): PollAnswer | null {
  return s.pollAnswers.get(pollId)?.get(participantId) ?? null;
}

/**
 * 集計。分母には、設問を締め切るまでに参加した生徒だけを含める。
 * 締め切り後に参加した生徒まで「未回答」にすると、回答する機会がなかった人を
 * 未回答者として数えることになるため。選択式では、誰が何を選んだかを返さない。
 */
export async function pollResults(s: LiveSession, pollId: string): Promise<PollResults> {
  const poll = s.polls.find((p) => p.id === pollId);
  const answers = s.pollAnswers.get(pollId) ?? new Map<string, PollAnswer>();
  const allRows = await db
    .select({
      id: schema.participants.id,
      displayName: schema.participants.displayName,
      joinedAt: schema.participants.joinedAt,
    })
    .from(schema.participants)
    .where(eq(schema.participants.lessonId, s.lessonId));
  const cutoffEpochMs =
    poll && s.startedAtEpochMs !== null
      ? s.startedAtEpochMs + (poll.closedAtMs ?? tMs(s))
      : Number.POSITIVE_INFINITY;
  const rows = allRows.filter((p) => p.joinedAt.getTime() <= cutoffEpochMs);

  const counts: Record<string, number> = {};
  for (const o of poll?.options ?? []) counts[o.id] = 0;
  const texts: { participantName: string; text: string }[] = [];
  const pending: string[] = [];

  for (const p of rows) {
    const a = answers.get(p.id);
    if (!a) {
      pending.push(p.displayName);
      continue;
    }
    for (const id of a.optionIds) counts[id] = (counts[id] ?? 0) + 1;
    if (a.text) texts.push({ participantName: p.displayName, text: a.text });
  }

  return {
    pollId,
    counts,
    answered: rows.length - pending.length,
    total: rows.length,
    texts,
    pending,
  };
}

/** 生徒へ見せる集計（誰が書いたかが分かる自由記述は落とす） */
export function publicResults(results: PollResults): PollResults {
  return { ...results, texts: [], pending: [] };
}
