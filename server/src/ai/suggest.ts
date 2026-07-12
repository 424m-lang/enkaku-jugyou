import crypto from 'node:crypto';
import type { ReflectionAlert } from '@shared';
import { db, schema } from '../db';
import { transcribeRange } from './transcribe';
import { suggestReflectionFocus } from './summarize';

/**
 * 振り返りタイム通知に添えるAI提案を生成する。
 * 既存のクリップ（タイムスタンプ参照）の仕組みを再利用し、反応が集中した
 * 時間帯の音声だけを文字起こし→要約する（授業全体の常時文字起こしはしない）。
 */
export async function generateSuggestionForAlert(
  lessonId: string,
  alert: ReflectionAlert
): Promise<string | null> {
  const cluster = alert.cluster;
  if (!cluster) return null;

  const t = await transcribeRange(lessonId, cluster.startMs, cluster.endMs);
  if (!t) return null;

  const suggestion = await suggestReflectionFocus(t.text, {
    participantCount: cluster.participantCount,
    kinds: cluster.kinds,
    comments: cluster.participants.map((p) => p.comment).filter((c): c is string => !!c),
  });

  // 授業中に生成した文字起こし・提案も transcripts に保存（授業後に再利用できる）
  await db.insert(schema.transcripts).values({
    id: crypto.randomUUID(),
    lessonId,
    scope: 'clip',
    rangeStartMs: cluster.startMs,
    rangeEndMs: cluster.endMs,
    text: t.text,
    summary: suggestion.text,
    provider: t.provider,
    model: suggestion.provider,
  });

  return suggestion.text;
}
