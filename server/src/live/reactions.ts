import crypto from 'node:crypto';
import type { ReactionCluster, ReactionFeedItem, ReactionInput } from '@shared';
import { config } from '../config';
import { db, schema } from '../db';
import { tMs, type LiveSession } from './liveSessions';

export type ReactionRow = {
  id: string;
  tMs: number;
  kind: string;
  comment: string | null;
  participantId: string;
  participantName: string;
  clipStartMs: number;
  clipEndMs: number;
};

/**
 * リアクションを記録する。
 * - 音声データはコピーせず、連続音声ファイルへのタイムスタンプ範囲（クリップ参照）のみ持つ
 * - 同一生徒×同一ボタンの5秒未満の連打は誤タップとみなして1回に集約（コメントは対象外）
 * - オフライン再送は delayMs で元の押下時刻を復元する
 */
export async function recordReaction(
  s: LiveSession,
  participant: { id: string; displayName: string },
  input: ReactionInput
): Promise<ReactionFeedItem | null> {
  const now = tMs(s);
  const delay = Math.max(0, Math.min(input.delayMs ?? 0, now));
  const t = Math.max(0, now - delay);

  if (input.kind !== 'comment') {
    const key = `${participant.id}:${input.kind}`;
    const last = s.lastReactionAt.get(key);
    if (last !== undefined && t - last < config.reactionDebounceMs) {
      return null; // デバウンス: 直前の反応に集約
    }
    s.lastReactionAt.set(key, t);
  }

  const id = crypto.randomUUID();
  const clipStartMs = Math.max(0, t - config.clipBeforeMs);
  const clipEndMs = t + config.clipAfterMs;

  await db.insert(schema.reactions).values({
    id,
    lessonId: s.lessonId,
    participantId: participant.id,
    tMs: t,
    kind: input.kind,
    comment: input.comment ?? null,
    clipStartMs,
    clipEndMs,
  });

  if (input.kind !== 'comment') {
    s.counts[input.kind] = (s.counts[input.kind] ?? 0) + 1;
  }

  s.recentReactions.push({
    participantId: participant.id,
    participantName: participant.displayName,
    kind: input.kind,
    comment: input.comment ?? null,
    tMs: t,
  });
  // クラスタ検出用の直近リスト（5分より古いものは捨てる）
  const cutoff = now - 5 * 60_000;
  s.recentReactions = s.recentReactions.filter((r) => r.tMs >= cutoff);

  return {
    id,
    tMs: t,
    kind: input.kind,
    comment: input.comment ?? null,
    participantName: participant.displayName,
  };
}

/**
 * 時間的に近い（clusterGapMs以内の）リアクションを「反応クラスタ」にまとめる。
 * 個別レコードはすべて保持したまま、表示・通知用の集約ビューを作る。
 */
export function clusterReactions(
  rows: Pick<ReactionRow, 'id' | 'tMs' | 'kind' | 'comment' | 'participantId' | 'participantName'>[],
  gapMs: number = config.clusterGapMs
): ReactionCluster[] {
  const sorted = [...rows].sort((a, b) => a.tMs - b.tMs);
  const clusters: ReactionCluster[] = [];
  let group: typeof sorted = [];

  const flush = () => {
    if (group.length === 0) return;
    const first = group[0];
    const last = group[group.length - 1];
    const kinds: Record<string, number> = {};
    const participantIds = new Set<string>();
    for (const r of group) {
      kinds[r.kind] = (kinds[r.kind] ?? 0) + 1;
      participantIds.add(r.participantId);
    }
    clusters.push({
      id: first.id,
      startMs: Math.max(0, first.tMs - config.clipBeforeMs),
      endMs: last.tMs + config.clipAfterMs,
      centerMs: Math.round((first.tMs + last.tMs) / 2),
      kinds,
      participantCount: participantIds.size,
      participants: group.map((r) => ({
        name: r.participantName,
        kind: r.kind,
        comment: r.comment,
        tMs: r.tMs,
      })),
    });
    group = [];
  };

  for (const r of sorted) {
    if (group.length > 0 && r.tMs - group[group.length - 1].tMs > gapMs) flush();
    group.push(r);
  }
  flush();

  // 同時に多くの生徒が反応したクラスタほど重要 → 人数の多い順
  return clusters.sort((a, b) => b.participantCount - a.participantCount);
}
