import crypto from 'node:crypto';
import type { Server } from 'socket.io';
import type { ReflectionAlert } from '@shared';
import { config } from '../config';
import { tMs, type LiveSession } from './liveSessions';
import { clusterReactions } from './reactions';
import { generateSuggestionForAlert } from '../ai/suggest';

type AnyServer = Server<any, any>;

const ALERT_COOLDOWN_MS = 90_000; // 通知の最短間隔
const NOTIFIED_CENTER_WINDOW_MS = 60_000; // 同じ山への二重通知を防ぐ

const notifiedCenters = new Map<string, number[]>(); // lessonId → 通知済みクラスタ中心

function teacherRoom(lessonId: string): string {
  return `lesson:${lessonId}:teacher`;
}

function emitAlert(io: AnyServer, s: LiveSession, alert: ReflectionAlert): void {
  s.alertsById.set(alert.alertId, alert);
  s.pendingAlertIds.add(alert.alertId);
  s.lastAlertAtMs = tMs(s);
  io.to(teacherRoom(s.lessonId)).emit('reflection_alert', alert);

  // AIによる「今、力を入れて振り返るべき内容」の提案を非同期生成
  // （クリップのタイムスタンプ参照を再利用し、範囲を絞って文字起こし→要約）
  if (alert.cluster) {
    void generateSuggestionForAlert(s.lessonId, alert)
      .then((suggestion) => {
        if (!suggestion) return;
        alert.suggestion = suggestion;
        io.to(teacherRoom(s.lessonId)).emit('reflection_suggestion', alert.alertId, suggestion);
      })
      .catch((err) => console.error('[reflection] 提案生成に失敗:', err));
  }
}

/** リアクション記録後に呼ばれ、反応集中を検知したら先生に通知する */
export function checkThresholdAlert(io: AnyServer, s: LiveSession): void {
  if (s.status !== 'live' || s.reflectionActive) return;
  const now = tMs(s);
  if (now - s.lastAlertAtMs < ALERT_COOLDOWN_MS) return;

  const clusters = clusterReactions(
    s.recentReactions.map((r, i) => ({
      id: `recent-${i}`,
      tMs: r.tMs,
      kind: r.kind,
      comment: r.comment,
      participantId: r.participantId,
      participantName: r.participantName,
    }))
  );
  const top = clusters[0];
  if (!top || top.participantCount < config.reflectionThreshold) return;

  const centers = notifiedCenters.get(s.lessonId) ?? [];
  if (centers.some((c) => Math.abs(c - top.centerMs) < NOTIFIED_CENTER_WINDOW_MS)) return;
  centers.push(top.centerMs);
  notifiedCenters.set(s.lessonId, centers);

  emitAlert(io, s, {
    alertId: crypto.randomUUID(),
    createdAtMs: now,
    reason: 'threshold',
    cluster: top,
    suggestion: null,
  });
}

/** 一定時間ごとの定期通知（REFLECTION_INTERVAL_MIN） */
export function startIntervalAlerts(io: AnyServer, s: LiveSession): void {
  if (s.intervalTimer || config.reflectionIntervalMin <= 0) return;
  s.intervalTimer = setInterval(() => {
    if (s.status !== 'live' || s.reflectionActive) return;
    const now = tMs(s);
    if (now - s.lastAlertAtMs < ALERT_COOLDOWN_MS) return;

    // 直近インターバル内の反応から最大クラスタを添える（なければクラスタなしで通知）
    const windowStart = now - config.reflectionIntervalMin * 60_000;
    const recent = s.recentReactions.filter((r) => r.tMs >= windowStart);
    const clusters = clusterReactions(
      recent.map((r, i) => ({
        id: `recent-${i}`,
        tMs: r.tMs,
        kind: r.kind,
        comment: r.comment,
        participantId: r.participantId,
        participantName: r.participantName,
      }))
    );
    emitAlert(io, s, {
      alertId: crypto.randomUUID(),
      createdAtMs: now,
      reason: 'interval',
      cluster: clusters[0] ?? null,
      suggestion: null,
    });
  }, config.reflectionIntervalMin * 60_000);
}

/** 先生の再接続時、未確認の通知を再送する（見落としても消えない） */
export function emitPendingAlerts(io: AnyServer, s: LiveSession, socketId: string): void {
  for (const id of s.pendingAlertIds) {
    const alert = s.alertsById.get(id);
    if (alert) io.to(socketId).emit('reflection_alert', alert);
  }
}

export function ackAlert(s: LiveSession, alertId: string): void {
  s.pendingAlertIds.delete(alertId);
}

export function clearPendingAlerts(s: LiveSession): void {
  s.pendingAlertIds.clear();
}
