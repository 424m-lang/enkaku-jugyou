import { eq } from 'drizzle-orm';
import type { LessonTelemetry } from '@shared';
import { db, schema } from '../db';

const SAVE_DELAY_MS = 5_000;
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
const saveChains = new Map<string, Promise<void>>();

export function emptyLessonTelemetry(): LessonTelemetry {
  return {
    version: 1,
    connectionSessions: { teacher: 0, student: 0, screen: 0 },
    reconnects: 0,
    disconnects: 0,
    maxConcurrentStudents: 0,
    maxConcurrentScreens: 0,
    platforms: { 'apple-mobile': 0, android: 0, desktop: 0, other: 0 },
    browsers: { safari: 0, chromium: 0, firefox: 0, other: 0 },
    audio: {
      receiverSessions: { webm: 0, mp4: 0 },
      startup: { count: 0, totalMs: 0, maxMs: 0 },
      stalls: 0,
      recoveries: 0,
      unsupported: 0,
      sourceBytes: { webm: 0, mp4: 0 },
      deliveredBytes: { webm: 0, mp4: 0 },
    },
    video: {
      receiverSessions: { webm: 0, mp4: 0 },
      cameraStarts: 0,
      activeMs: 0,
      closedByStudents: 0,
      unsupported: 0,
      sourceBytes: { webm: 0, mp4: 0 },
      deliveredBytes: { webm: 0, mp4: 0 },
    },
  };
}

/** 将来項目を増やしても、古いJSONを安全に読み込めるよう既定値へ重ねる */
function normalize(value: LessonTelemetry | null | undefined): LessonTelemetry {
  const base = emptyLessonTelemetry();
  if (!value) return base;
  return {
    ...base,
    ...value,
    connectionSessions: { ...base.connectionSessions, ...value.connectionSessions },
    platforms: { ...base.platforms, ...value.platforms },
    browsers: { ...base.browsers, ...value.browsers },
    audio: {
      ...base.audio,
      ...value.audio,
      receiverSessions: { ...base.audio.receiverSessions, ...value.audio?.receiverSessions },
      startup: { ...base.audio.startup, ...value.audio?.startup },
      sourceBytes: { ...base.audio.sourceBytes, ...value.audio?.sourceBytes },
      deliveredBytes: { ...base.audio.deliveredBytes, ...value.audio?.deliveredBytes },
    },
    video: {
      ...base.video,
      ...value.video,
      receiverSessions: { ...base.video.receiverSessions, ...value.video?.receiverSessions },
      sourceBytes: { ...base.video.sourceBytes, ...value.video?.sourceBytes },
      deliveredBytes: { ...base.video.deliveredBytes, ...value.video?.deliveredBytes },
    },
  };
}

export async function loadLessonTelemetry(lessonId: string): Promise<LessonTelemetry> {
  const [row] = await db
    .select({ metrics: schema.lessonTelemetry.metrics })
    .from(schema.lessonTelemetry)
    .where(eq(schema.lessonTelemetry.lessonId, lessonId));
  return normalize(row?.metrics);
}

async function saveLessonTelemetry(lessonId: string, snapshot: LessonTelemetry): Promise<void> {
  await db
    .insert(schema.lessonTelemetry)
    .values({ lessonId, metrics: snapshot, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: schema.lessonTelemetry.lessonId,
      set: { metrics: snapshot, updatedAt: new Date() },
    });
}

/** 古い保存が後から完了して新しい値を上書きしないよう、授業ごとに直列化する */
function enqueueSave(lessonId: string, metrics: LessonTelemetry): Promise<void> {
  const snapshot = structuredClone(metrics);
  const previous = saveChains.get(lessonId) ?? Promise.resolve();
  const current = previous
    .catch(() => {
      /* 前回の失敗で以後の保存まで止めない */
    })
    .then(() => saveLessonTelemetry(lessonId, snapshot));
  saveChains.set(lessonId, current);
  const cleanup = () => {
    if (saveChains.get(lessonId) === current) saveChains.delete(lessonId);
  };
  void current.then(cleanup, cleanup);
  return current;
}

/** メディア断片ごとにDBへ書かず、最後の値を5秒ごとにまとめて保存する */
export function scheduleTelemetrySave(lessonId: string, metrics: LessonTelemetry): void {
  if (saveTimers.has(lessonId)) return;
  const timer = setTimeout(() => {
    saveTimers.delete(lessonId);
    void enqueueSave(lessonId, metrics).catch((err) => {
      console.error('[telemetry] 匿名集計の保存に失敗しました', err);
    });
  }, SAVE_DELAY_MS);
  timer.unref?.();
  saveTimers.set(lessonId, timer);
}

/** 授業終了時は待機中の保存を取り消し、終了時点の値を確実に書く */
export async function flushLessonTelemetry(
  lessonId: string,
  metrics: LessonTelemetry
): Promise<void> {
  const timer = saveTimers.get(lessonId);
  if (timer) clearTimeout(timer);
  saveTimers.delete(lessonId);
  await enqueueSave(lessonId, metrics);
}
