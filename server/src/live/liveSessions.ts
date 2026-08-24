import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { asc, eq, inArray } from 'drizzle-orm';
import type {
  AudioMode,
  LiveLessonState,
  LessonStatus,
  ParticipantInfo,
  ReactionButtonDef,
  ReactionCounts,
  ScreenLayout,
  SlideInfo,
  TimelineEvent,
  TimelineEventType,
  TranscriptSegment,
} from '@shared';
import { db, schema } from '../db';
import { lessonDir } from '../storage';

/** WebMファイルの先頭マジックナンバー（EBMLヘッダ）。録音パートの先頭チャンク判定に使う */
const EBML_MAGIC = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);

type AudioPart = {
  file: string; // レッスンディレクトリ内のファイル名
  startMs: number;
  stream: fs.WriteStream;
};

export type RecentReaction = {
  participantId: string;
  participantName: string;
  kind: string;
  comment: string | null;
  tMs: number;
};

/**
 * 授業ごとのライブ状態（インメモリ）。
 * 永続化はDB（timeline_events等）が正であり、ここは配信・途中参加者への
 * スナップショット提供のためのキャッシュ。サーバ再起動時はDBから復元する。
 */
export type LiveSession = {
  lessonId: string;
  title: string;
  status: LessonStatus;
  reactionButtons: ReactionButtonDef[];
  startedAtEpochMs: number | null;
  slides: SlideInfo[];
  currentSlideId: string | null;
  /** 途中参加者が描画状態を再構成するための stroke / clear_slide イベント */
  drawingEvents: TimelineEvent[];
  counts: ReactionCounts;

  /**
   * コメント入力中の生徒（participantId → 入力対象スライド・入力開始時刻・最終合図時刻）。
   * startTMs はコメント・振り返りのAI分析対象の音声範囲を決めるのに使う
   */
  composing: Map<string, { slideId: string; startTMs: number; atEpochMs: number }>;

  // 音声（1レッスン=原則1ファイル。先生のリロード時のみ新パートに切替）
  currentAudioPart: AudioPart | null;
  audioSeq: number;
  /** 現在パートの先頭チャンク（WebMヘッダ）。新規参加者のデコーダ初期化用 */
  audioInitSegment: Buffer | null;

  // 生徒端末の音声（教室の大画面から音を出す授業は既定 'off'）
  audioDefault: AudioMode;
  /** 音声の個別指定（participantId → 設定）。既定に従う生徒は入っていない */
  audioOverrides: Map<string, AudioMode>;

  /**
   * カメラ映像（音声込みの1本のストリーム）。
   * 大画面には常に届け、生徒端末へは videoToStudents がONのときだけ届ける。
   * 復習動画には残さないため保存もしない（ライブ配信のみ）。
   */
  cameraOn: boolean;
  /** カメラ映像に音声が入っているか（マイクが使えない環境では映像だけになる） */
  avHasAudio: boolean;
  screenLayout: ScreenLayout;
  /** 遠隔の生徒にも映像を届けるか（通信量が増えるため既定はOFF） */
  videoToStudents: boolean;
  avSeq: number;
  /** 現在のカメラ配信の先頭チャンク（WebMヘッダ）。途中参加のデコーダ初期化用 */
  avInitSegment: Buffer | null;

  // リアクション
  lastReactionAt: Map<string, number>; // key: participantId:kind → tMs（デバウンス用）
  recentReactions: RecentReaction[]; // クリップ集約用（直近数分）

  // 授業中に裏で貯めるローリング文字起こし（コメント要約が全文を参照できるように）
  transcriptSegments: TranscriptSegment[]; // 授業タイムライン基準・startMs昇順
  transcribedUntilMs: number; // ここまで文字起こし済み
  transcribeTimer: ReturnType<typeof setInterval> | null;
};

const sessions = new Map<string, LiveSession>();

export function tMs(s: LiveSession): number {
  return s.startedAtEpochMs ? Date.now() - s.startedAtEpochMs : 0;
}

export async function loadSlides(lessonId: string): Promise<SlideInfo[]> {
  const rows = await db
    .select()
    .from(schema.lessonSlides)
    .where(eq(schema.lessonSlides.lessonId, lessonId))
    .orderBy(asc(schema.lessonSlides.position));
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    pdfPageIndex: r.pdfPageIndex,
    position: r.position,
  }));
}

export async function getSession(lessonId: string): Promise<LiveSession | null> {
  const existing = sessions.get(lessonId);
  if (existing) return existing;

  const [lesson] = await db.select().from(schema.lessons).where(eq(schema.lessons.id, lessonId));
  if (!lesson) return null;

  const slides = await loadSlides(lessonId);

  const s: LiveSession = {
    lessonId,
    title: lesson.title,
    status: lesson.status,
    reactionButtons: lesson.reactionButtons,
    startedAtEpochMs: lesson.startedAt ? lesson.startedAt.getTime() : null,
    slides,
    currentSlideId: slides[0]?.id ?? null,
    drawingEvents: [],
    counts: {},
    composing: new Map(),
    currentAudioPart: null,
    audioSeq: 0,
    audioInitSegment: null,
    audioDefault: lesson.audioDefault,
    audioOverrides: new Map(),
    cameraOn: false,
    avHasAudio: false,
    screenLayout: 'slide',
    videoToStudents: false,
    avSeq: 0,
    avInitSegment: null,
    lastReactionAt: new Map(),
    recentReactions: [],
    transcriptSegments: [],
    transcribedUntilMs: 0,
    transcribeTimer: null,
  };

  // 音声の個別指定を復元（先生が授業前に設定していることもある）
  const overridden = await db
    .select({ id: schema.participants.id, audioOverride: schema.participants.audioOverride })
    .from(schema.participants)
    .where(eq(schema.participants.lessonId, lessonId));
  for (const p of overridden) {
    if (p.audioOverride) s.audioOverrides.set(p.id, p.audioOverride);
  }

  // サーバ再起動後の復元: live中ならタイムラインから描画状態・現在スライドを再構成
  if (lesson.status === 'live') {
    const events = await db
      .select()
      .from(schema.timelineEvents)
      .where(eq(schema.timelineEvents.lessonId, lessonId))
      .orderBy(asc(schema.timelineEvents.tMs));
    let lastAudioPart: { file: string; startMs: number } | null = null;
    for (const ev of events) {
      applyEventToState(s, {
        id: ev.id,
        tMs: ev.tMs,
        type: ev.type as TimelineEventType,
        payload: ev.payload as TimelineEvent['payload'],
      });
      if (ev.type === 'audio_part') {
        lastAudioPart = { file: (ev.payload as { file: string }).file, startMs: ev.tMs };
      }
    }
    // 録音は最後のパートへ追記モードで再開する（先生のMediaRecorderは動き続けており、
    // 切断中のチャンクはSocket.IOクライアント側にバッファされて再送されてくる）
    if (lastAudioPart) {
      s.currentAudioPart = {
        file: lastAudioPart.file,
        startMs: lastAudioPart.startMs,
        stream: fs.createWriteStream(path.join(lessonDir(lessonId), lastAudioPart.file), {
          flags: 'a',
        }),
      };
    }
    const rows = await db
      .select()
      .from(schema.reactions)
      .where(eq(schema.reactions.lessonId, lessonId));
    for (const r of rows) {
      if (r.kind !== 'comment') s.counts[r.kind] = (s.counts[r.kind] ?? 0) + 1;
    }
  }

  sessions.set(lessonId, s);
  return s;
}

/** タイムラインイベントをライブ状態へ反映（復元・受信の両方で使用） */
export function applyEventToState(s: LiveSession, ev: TimelineEvent): void {
  switch (ev.type) {
    case 'slide_change':
      s.currentSlideId = (ev.payload as { slideId: string }).slideId;
      break;
    case 'stroke':
      s.drawingEvents.push(ev);
      break;
    case 'clear_slide': {
      // 消されたストロークをスナップショットから除外する（clear自体は保持不要）
      const p = ev.payload as { slideId: string; strokeIds?: string[] };
      s.drawingEvents = s.drawingEvents.filter((e) => {
        if (e.type !== 'stroke') return true;
        const sp = e.payload as { slideId: string; strokeId: string };
        if (sp.slideId !== p.slideId) return true;
        if (p.strokeIds && p.strokeIds.length > 0) return !p.strokeIds.includes(sp.strokeId);
        return false;
      });
      break;
    }
    // reflection_start / reflection_end は旧機能のイベント（無視して読み飛ばす）
  }
}

/** イベントをDBに永続化しつつライブ状態へ反映 */
export async function recordEvent(
  s: LiveSession,
  type: TimelineEventType,
  payload: unknown,
  eventTMs?: number
): Promise<TimelineEvent> {
  const ev: TimelineEvent = {
    id: crypto.randomUUID(),
    tMs: eventTMs ?? tMs(s),
    type,
    payload: payload as TimelineEvent['payload'],
  };
  applyEventToState(s, ev);
  await db.insert(schema.timelineEvents).values({
    id: ev.id,
    lessonId: s.lessonId,
    tMs: ev.tMs,
    type,
    actor: 'teacher',
    payload: payload as object,
  });
  return ev;
}

// ---- ポインター位置の間引き保存 ----
// 配信は全量・リアルタイム、保存は最大5Hz（再生に十分な密度でDB量を抑える）
const POINTER_STORE_MIN_GAP_MS = 200;
const lastPointerStoreAt = new Map<string, number>();

export async function recordPointerSampled(
  s: LiveSession,
  payload: unknown
): Promise<void> {
  const now = tMs(s);
  const last = lastPointerStoreAt.get(s.lessonId) ?? -Infinity;
  if (now - last < POINTER_STORE_MIN_GAP_MS) return;
  lastPointerStoreAt.set(s.lessonId, now);
  await db.insert(schema.timelineEvents).values({
    id: crypto.randomUUID(),
    lessonId: s.lessonId,
    tMs: now,
    type: 'pointer',
    actor: 'teacher',
    payload: payload as object,
  });
}

export function toLiveState(s: LiveSession): LiveLessonState {
  return {
    lessonId: s.lessonId,
    status: s.status,
    title: s.title,
    reactionButtons: s.reactionButtons,
    slides: s.slides,
    currentSlideId: s.currentSlideId,
    startedAtEpochMs: s.startedAtEpochMs,
    serverNowEpochMs: Date.now(),
    drawingEvents: s.drawingEvents,
    counts: s.counts,
    audioDefault: s.audioDefault,
    cameraOn: s.cameraOn,
    screenLayout: s.screenLayout,
  };
}

// ---- 生徒端末の音声 ----

/** その生徒の端末で音声を鳴らすか（個別指定が優先、無ければ授業の既定） */
export function effectiveAudio(s: LiveSession, participantId: string): AudioMode {
  return s.audioOverrides.get(participantId) ?? s.audioDefault;
}

/** 授業の既定を切り替える。個別指定はすべて解除し、全員を同じ状態に揃える */
export async function setAudioDefault(s: LiveSession, mode: AudioMode): Promise<void> {
  s.audioDefault = mode;
  s.audioOverrides.clear();
  await db
    .update(schema.lessons)
    .set({ audioDefault: mode })
    .where(eq(schema.lessons.id, s.lessonId));
  await db
    .update(schema.participants)
    .set({ audioOverride: null })
    .where(eq(schema.participants.lessonId, s.lessonId));
}

/** 生徒1人の音声を個別に指定する（null で既定へ戻す） */
export async function setParticipantAudio(
  s: LiveSession,
  participantId: string,
  mode: AudioMode | null
): Promise<void> {
  if (mode) s.audioOverrides.set(participantId, mode);
  else s.audioOverrides.delete(participantId);
  await db
    .update(schema.participants)
    .set({ audioOverride: mode })
    .where(eq(schema.participants.id, participantId));
}

/** 先生画面の参加者一覧（onlineIds は現在接続中のparticipantId） */
export async function listParticipants(
  s: LiveSession,
  onlineIds: Set<string>
): Promise<ParticipantInfo[]> {
  const rows = await db
    .select({
      id: schema.participants.id,
      displayName: schema.participants.displayName,
      joinedAt: schema.participants.joinedAt,
    })
    .from(schema.participants)
    .where(eq(schema.participants.lessonId, s.lessonId))
    .orderBy(asc(schema.participants.joinedAt));
  return rows.map((r) => ({
    id: r.id,
    displayName: r.displayName,
    audio: effectiveAudio(s, r.id),
    overridden: s.audioOverrides.has(r.id),
    online: onlineIds.has(r.id),
  }));
}

// ---- カメラ映像 ----

/**
 * 先生からのカメラ映像チャンクを処理する。
 * 音声と違い保存はせず、中継のためのヘッダ保持と連番付けだけを行う
 * （復習動画はPDFと音声から組み立てる設計のため、映像はライブ限定）。
 */
export function handleAvChunk(s: LiveSession, buf: Buffer): { isInit: boolean; seq: number } {
  const isInit = buf.subarray(0, 4).equals(EBML_MAGIC);
  if (isInit) {
    s.avInitSegment = buf;
    s.avSeq = 0;
  }
  return { isInit, seq: s.avSeq++ };
}

// ---- 音声 ----

/**
 * 先生からの音声チャンクを処理する。
 * WebMヘッダ（EBMLマジック）で始まるチャンクは録音（再）開始の先頭とみなし、
 * 新しいパートファイルへ切り替える。通常は1レッスンで1パート=1ファイル。
 */
export async function handleAudioChunk(
  s: LiveSession,
  buf: Buffer
): Promise<{ isInit: boolean; seq: number }> {
  const isHeader = buf.subarray(0, 4).equals(EBML_MAGIC);

  if (isHeader) {
    if (s.currentAudioPart) {
      s.currentAudioPart.stream.end();
    }
    const startMs = tMs(s);
    const file = `audio_${startMs}.webm`;
    const stream = fs.createWriteStream(path.join(lessonDir(s.lessonId), file), { flags: 'w' });
    s.currentAudioPart = { file, startMs, stream };
    s.audioInitSegment = buf;
    s.audioSeq = 0;
    await recordEvent(s, 'audio_part', { file }, startMs);
  }

  if (!s.currentAudioPart) {
    // ヘッダ未受信のままデータが来た場合は破棄（リロード直後の残骸など）
    return { isInit: false, seq: s.audioSeq };
  }

  s.currentAudioPart.stream.write(buf);
  s.audioSeq++;
  return { isInit: isHeader, seq: s.audioSeq };
}

// ---- 授業の開始・終了 ----

export async function startLesson(s: LiveSession): Promise<void> {
  const startedAt = new Date();
  s.status = 'live';
  s.startedAtEpochMs = startedAt.getTime();
  s.drawingEvents = [];
  s.counts = {};
  s.recentReactions = [];
  s.composing.clear();
  s.audioSeq = 0;
  s.audioInitSegment = null;
  s.currentAudioPart = null;
  s.transcriptSegments = [];
  s.transcribedUntilMs = 0;
  await db
    .update(schema.lessons)
    .set({ status: 'live', startedAt })
    .where(eq(schema.lessons.id, s.lessonId));
  if (s.currentSlideId) {
    await recordEvent(s, 'slide_change', { slideId: s.currentSlideId }, 0);
  }
}

export async function endLesson(s: LiveSession): Promise<void> {
  s.status = 'ended';
  const durationMs = tMs(s);
  if (s.transcribeTimer) {
    clearInterval(s.transcribeTimer);
    s.transcribeTimer = null;
  }
  if (s.currentAudioPart) {
    const st = s.currentAudioPart.stream;
    await new Promise<void>((resolve) => st.end(() => resolve()));
    s.currentAudioPart = null;
  }
  await db
    .update(schema.lessons)
    .set({ status: 'ended', endedAt: new Date(), audioDurationMs: durationMs })
    .where(eq(schema.lessons.id, s.lessonId));
}

/** 白紙スライドを指定位置の後ろに挿入（元のPDFデータには影響しない） */
export async function insertBlankSlide(
  s: LiveSession,
  afterPosition: number
): Promise<{ slides: SlideInfo[]; newSlideId: string }> {
  const sorted = [...s.slides].sort((a, b) => a.position - b.position);
  const next = sorted.find((sl) => sl.position > afterPosition);
  const newPosition = next ? (afterPosition + next.position) / 2 : afterPosition + 1;
  const id = crypto.randomUUID();
  await db.insert(schema.lessonSlides).values({
    id,
    lessonId: s.lessonId,
    kind: 'blank',
    pdfPageIndex: null,
    position: newPosition,
  });
  s.slides = await loadSlides(s.lessonId);
  return { slides: s.slides, newSlideId: id };
}

export async function touchParticipants(participantIds: string[]): Promise<void> {
  if (participantIds.length === 0) return;
  await db
    .update(schema.participants)
    .set({ lastSeenAt: new Date() })
    .where(inArray(schema.participants.id, participantIds));
}
