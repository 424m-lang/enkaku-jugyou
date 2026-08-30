import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type {
  AudioFormat,
  AudioMode,
  LessonTask,
  LessonAiSettings,
  LessonTelemetry,
  LiveLessonState,
  LessonStatus,
  ParticipantInfo,
  PipPos,
  Poll,
  PollAnswer,
  ReactionButtonDef,
  ReactionCounts,
  ScreenLayout,
  SlideInfo,
  TaskMode,
  TaskProgressEntry,
  TaskProgressPayload,
  TimelineEvent,
  TimelineEventType,
  TranscriptSegment,
  VideoFormat,
} from '@shared';
import {
  DEFAULT_LESSON_AI_SETTINGS,
  DEFAULT_PIP_POS,
  MAX_TASKS,
  applyTaskChange,
} from '@shared';
import { db, schema } from '../db';
import { lessonDir } from '../storage';
import { loadPolls, loadPollAnswers, toPublicPoll } from './polls';
import {
  flushLessonTelemetry,
  loadLessonTelemetry,
  scheduleTelemetrySave,
} from './telemetry';

/** WebMファイルの先頭マジックナンバー（EBMLヘッダ）。録音パートの先頭チャンク判定に使う */
const EBML_MAGIC = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);

/**
 * 録音（再）開始の先頭チャンクか。
 * WebMはEBMLマジックで始まり、MP4は先頭4バイトのボックス長に続いて 'ftyp' が来る。
 * 先生の環境によってどちらの形式にもなるため、両方を見る。
 */
function isInitSegment(buf: Buffer): boolean {
  if (buf.subarray(0, 4).equals(EBML_MAGIC)) return true;
  return buf.length >= 8 && buf.subarray(4, 8).toString('latin1') === 'ftyp';
}

/** 保存ファイルの拡張子。形式が分からないときは従来どおりWebMとして扱う */
function extForMime(mime: string | null): string {
  return mime && mime.includes('mp4') ? 'mp4' : 'webm';
}

type AudioPart = {
  file: string; // レッスンディレクトリ内のファイル名
  startMs: number;
  /** 2形式を中継していても、保存するのはこの形式だけ */
  format: AudioFormat;
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
  /** ボタンを使わない授業では false。定義（reactionButtons）は消さずに残す */
  reactionsEnabled: boolean;
  /** 授業前に先生が選んだAI機能。開始後は変更しない */
  aiSettings: LessonAiSettings;
  startedAtEpochMs: number | null;
  slides: SlideInfo[];
  currentSlideId: string | null;
  /** 途中参加者が描画状態を再構成するための stroke / clear_slide イベント */
  drawingEvents: TimelineEvent[];
  counts: ReactionCounts;

  // ---- タスク ----
  tasks: LessonTask[];
  taskMode: TaskMode;
  /** 生徒画面にタスクバーを出しているか */
  tasksActive: boolean;
  /** 教室モニターに字幕の帯を出すか */
  captionsOnScreen: boolean;
  /** 生徒の端末に字幕を出してよいか（出すかどうかは生徒が各自で決める） */
  captionsForStudents: boolean;
  /** 字幕を作っているか。出し先のどちらかがONなら作る（導出値） */
  captionsEnabled: boolean;
  /**
   * いま字幕を出している生徒（socket.id → participantId）。
   *
   * 先生に「生徒の端末に出す」というスイッチは無く、ここが空でなければ
   * 先生の端末で音声認識が始まる。socket.id をキーにしているのは、
   * 端末を閉じた生徒の分まで認識を回し続けないようにするため
   */
  captionWants: Map<string, string>;
  /** 先生の端末で音声認識が動かない。字幕をONにした生徒に理由を返すために持つ */
  captionsUnavailable: boolean;
  /**
   * 先生の映像を「いらない」と閉じた生徒（participantId）。
   * 見ていない相手に映像を送り続けない。授業をまたいで覚えるものではないので保存しない
   */
  videoClosedBy: Set<string>;
  /** participantId → 完了したタスクidの集合。task_progress イベントの畳み込み結果 */
  taskProgress: Map<string, Set<string>>;
  /** participantId → 最後に進捗が動いた tMs（止まっている生徒の検知に使う） */
  taskUpdatedAt: Map<string, number>;

  // ---- アンケート ----
  polls: Poll[];
  /** いま開いている設問（同時に開けるのは1問だけ） */
  openPollId: string | null;
  /** pollId → participantId → 回答 */
  pollAnswers: Map<string, Map<string, PollAnswer>>;

  /**
   * コメント入力中の生徒（participantId → 入力対象スライド・入力開始時刻・最終合図時刻）。
   * startTMsはコメント整理の対象となる音声範囲を決めるために使用する
   */
  composing: Map<string, { slideId: string; startTMs: number; atEpochMs: number }>;

  // 音声（中継は受け手に合わせて2形式、授業後の録音は原則Opusの1形式だけ）
  currentAudioPart: AudioPart | null;
  /** 形式ごとの中継用ヘッダ・連番。途中参加者は自分の形式だけを受け取る */
  audioStreams: Map<AudioFormat, { init: Buffer; mime: string; seq: number }>;

  // 生徒端末の音声（教室モニターから音を出す授業は既定 'off'）
  audioDefault: AudioMode;
  /** 音声の個別指定（participantId → 設定）。既定に従う生徒は入っていない */
  audioOverrides: Map<string, AudioMode>;

  /**
   * カメラ映像（音声込みの1本のストリーム）。
   * 教室モニターには常に届け、生徒端末へは videoToStudents がONのときだけ届ける。
   * 復習動画には残さないため保存もしない（ライブ配信のみ）。
   */
  cameraOn: boolean;
  /**
   * いま映像を送っている先生の接続。
   * 送り手が居なくなったのに cameraOn が立ったままだと、教室モニターは
   * 止まった絵を映し続け、先生の画面も「カメラを止める」のまま戻せなくなる
   */
  cameraSocketId: string | null;
  /** カメラ映像に音声が入っているか（マイクが使えない環境では映像だけになる） */
  avHasAudio: boolean;
  /**
   * 形式ごとのカメラ配信。同じ映像を2形式で同時に送ることがある。
   *
   * 受信端末によって再生できる形式が異なる。
   * どちらか一方に決めると、MediaRecorderのMP4が必要な端末に合わせて全員の遅延が増えるため、
   * **必要な形式だけを並行して流す**。受け手は自分の形式の部屋にだけ入る。
   */
  avStreams: Map<VideoFormat, { init: Buffer; mime: string; seq: number }>;
  screenLayout: ScreenLayout;
  /** 小さい表示またはスライド外の映像枠の位置 */
  pipPos: PipPos;
  /** 遠方の生徒にも映像を届けるか（通信量が増えるため既定はOFF） */
  videoToStudents: boolean;

  // リアクション
  lastReactionAt: Map<string, number>; // key: participantId:kind → tMs（デバウンス用）
  recentReactions: RecentReaction[]; // クリップ集約用（直近数分）

  // 授業中に裏で貯めるローリング文字起こし（コメント要約が全文を参照できるように）
  transcriptSegments: TranscriptSegment[]; // 授業タイムライン基準・startMs昇順
  transcribedUntilMs: number; // ここまで文字起こし済み
  transcribeTimer: ReturnType<typeof setInterval> | null;

  // ---- 匿名の通信集計 ----
  /** DBへ保存するのはこの合計値だけ。個人を識別する値は含まない */
  telemetry: LessonTelemetry;
  /** 同じブラウザタブの再接続を二重計上しないための一時集合（DBには保存しない） */
  telemetrySeenSessions: Set<string>;
  telemetryAudioSeen: Set<string>;
  telemetryVideoSeen: Set<string>;
  /** カメラON区間の開始。保存時には合計時間だけへ変換する */
  telemetryCameraStartedAt: number | null;
};

const sessions = new Map<string, LiveSession>();
/**
 * 最初の接続が同時に複数来ても、同じ授業をDBから二重に組み立てない。
 * Socket.IOの各接続が別々のLiveSessionを握ると、その後の状態更新が分岐してしまうため、
 * 読み込み中のPromiseも授業ごとに共有する。
 */
const sessionLoads = new Map<string, Promise<LiveSession | null>>();

export function tMs(s: LiveSession): number {
  return s.startedAtEpochMs ? Date.now() - s.startedAtEpochMs : 0;
}

/** 合計値を更新し、メディア断片ごとのDB書き込みにならないよう遅延保存する */
export function updateTelemetry(
  s: LiveSession,
  update: (metrics: LessonTelemetry) => void
): void {
  update(s.telemetry);
  scheduleTelemetrySave(s.lessonId, s.telemetry);
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

  const inFlight = sessionLoads.get(lessonId);
  if (inFlight) return inFlight;

  const loading = loadSession(lessonId);
  sessionLoads.set(lessonId, loading);
  try {
    return await loading;
  } finally {
    if (sessionLoads.get(lessonId) === loading) sessionLoads.delete(lessonId);
  }
}

async function loadSession(lessonId: string): Promise<LiveSession | null> {
  const [lesson] = await db.select().from(schema.lessons).where(eq(schema.lessons.id, lessonId));
  if (!lesson) return null;

  const slides = await loadSlides(lessonId);
  const polls = await loadPolls(lessonId);
  const telemetry = await loadLessonTelemetry(lessonId);

  const s: LiveSession = {
    lessonId,
    title: lesson.title,
    status: lesson.status,
    reactionButtons: lesson.reactionButtons,
    reactionsEnabled: lesson.reactionsEnabled,
    aiSettings: lesson.aiSettings ?? DEFAULT_LESSON_AI_SETTINGS,
    startedAtEpochMs: lesson.startedAt ? lesson.startedAt.getTime() : null,
    slides,
    currentSlideId: slides[0]?.id ?? null,
    drawingEvents: [],
    counts: {},
    tasks: lesson.tasks ?? [],
    taskMode: lesson.taskMode,
    tasksActive: lesson.tasksActive,
    captionsOnScreen: lesson.captionsOnScreen,
    captionsForStudents: lesson.captionsForStudents,
    // 生徒の分は接続している生徒から決まるので、読み込み時は必ず0人から始める
    captionsEnabled: lesson.captionsOnScreen,
    captionWants: new Map(),
    captionsUnavailable: false,
    videoClosedBy: new Set(),
    taskProgress: new Map(),
    taskUpdatedAt: new Map(),
    polls,
    openPollId: polls.find((p) => p.status === 'open')?.id ?? null,
    pollAnswers: await loadPollAnswers(lessonId),
    composing: new Map(),
    currentAudioPart: null,
    audioStreams: new Map(),
    audioDefault: lesson.audioDefault,
    audioOverrides: new Map(),
    cameraOn: false,
    cameraSocketId: null,
    avHasAudio: false,
    avStreams: new Map(),
    screenLayout: 'slide',
    pipPos: DEFAULT_PIP_POS,
    videoToStudents: false,
    lastReactionAt: new Map(),
    recentReactions: [],
    transcriptSegments: [],
    transcribedUntilMs: 0,
    transcribeTimer: null,
    telemetry,
    telemetrySeenSessions: new Set(),
    telemetryAudioSeen: new Set(),
    telemetryVideoSeen: new Set(),
    telemetryCameraStartedAt: null,
  };

  // 音声の個別指定を復元（先生が授業前に設定していることもある）
  const overridden = await db
    .select({ id: schema.participants.id, audioOverride: schema.participants.audioOverride })
    .from(schema.participants)
    .where(eq(schema.participants.lessonId, lessonId));
  for (const p of overridden) {
    if (p.audioOverride) s.audioOverrides.set(p.id, p.audioOverride);
  }

  // サーバ再起動後の復元: タイムラインから描画状態・現在スライドを再構成する。
  // 開始前（draft）も対象にするのは、授業前にスライドへ書き込んでおく使い方があるため。
  // 終了した授業はライブ状態を持たない（振り返りはDBから直接読む）
  if (lesson.status !== 'ended') {
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
        format: lastAudioPart.file.endsWith('.mp4') ? 'mp4' : 'webm',
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
    case 'task_progress': {
      // 差分ではなくその時点の完了一覧なので、最後のものがそのまま現在の状態になる
      const p = ev.payload as TaskProgressPayload;
      s.taskProgress.set(p.participantId, new Set(p.taskIds));
      s.taskUpdatedAt.set(p.participantId, ev.tMs);
      break;
    }
    // reflection_start / reflection_end は旧機能のイベント（無視して読み飛ばす）
  }
}

/**
 * イベントをDBに永続化しつつライブ状態へ反映。
 * actor は既定で 'teacher'。生徒が起こしたイベント（タスク進捗）は participantId を渡す
 */
export async function recordEvent(
  s: LiveSession,
  type: TimelineEventType,
  payload: unknown,
  eventTMs?: number,
  actor = 'teacher'
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
    actor,
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
    reactionsEnabled: s.reactionsEnabled,
    aiSettings: s.aiSettings,
    slides: s.slides,
    currentSlideId: s.currentSlideId,
    startedAtEpochMs: s.startedAtEpochMs,
    serverNowEpochMs: Date.now(),
    drawingEvents: s.drawingEvents,
    audioDefault: s.audioDefault,
    cameraOn: s.cameraOn,
    screenLayout: s.screenLayout,
    tasks: s.tasks,
    taskMode: s.taskMode,
    tasksActive: s.tasksActive,
    captionsEnabled: s.captionsEnabled,
    captionsUnavailable: s.captionsUnavailable,
    captionsOnScreen: s.captionsOnScreen,
    captionsForStudents: s.captionsForStudents,
    openPoll: (() => {
      const p = s.polls.find((x) => x.id === s.openPollId);
      return p ? toPublicPoll(p) : null;
    })(),
  };
}

/** 授業で使用するAI機能を保存する。処理条件が途中で変わらないよう、開始前だけ受け付ける */
export async function setAiSettings(
  s: LiveSession,
  settings: LessonAiSettings
): Promise<{ error?: string }> {
  if (s.status !== 'draft') return { error: 'AI機能の設定は授業開始前に変更してください' };
  const next = { ...settings };
  await db
    .update(schema.lessons)
    .set({ aiSettings: next })
    .where(eq(schema.lessons.id, s.lessonId));
  // 保存に成功した設定だけを配信対象の状態へ反映する。
  s.aiSettings = next;
  return {};
}

/**
 * リアクションボタンを使うかどうかの切替。
 * タスク・アンケートで生徒の状況が分かるようになったので、ボタンを完全に無しにできる。
 * ボタンの定義は消さないので、戻せば元の設定がそのまま復活する
 */
/**
 * 字幕の出し先の切り替え。
 *
 * 「字幕を作る」というスイッチは置かない。作ることは目的ではなく、
 * どこかに出すための副作用なので、出し先がひとつでもONなら作り、
 * すべてOFFになったら止める。先生が大元のスイッチを入れ忘れて
 * 「モニターの字幕をONにしたのに出ない」という失敗が起きないようにする。
 *
 * 誤変換が問題になったときにすぐ止められるよう、授業中でも切り替えられる。
 * 記録済みの字幕は消さない（読み返しに使うため）。
 */
function recomputeCaptions(s: LiveSession): void {
  s.captionsForStudents = s.captionWants.size > 0;
  s.captionsEnabled = s.captionsOnScreen || s.captionsForStudents;
  // 誰も字幕を出していない間は「動かない」の表示を持ち越さない。
  // 次にONにした人が、その時点の状況で判断し直せるようにする
  if (!s.captionsEnabled) s.captionsUnavailable = false;
}

/**
 * 教室モニターに字幕を出すか（先生の操作）。
 * 生徒の分はここでは触らない。保存するのも教室モニターの分だけで、
 * 生徒の希望は「いま繋がっている生徒」から毎回決め直す
 */
export async function setCaptionsOnScreen(s: LiveSession, onScreen: boolean): Promise<void> {
  s.captionsOnScreen = onScreen;
  recomputeCaptions(s);
  await db
    .update(schema.lessons)
    .set({ captionsOnScreen: s.captionsOnScreen, captionsEnabled: s.captionsEnabled })
    .where(eq(schema.lessons.id, s.lessonId));
}

/** 生徒1人分の字幕の希望。保存しない（授業をまたいで引き継ぐものではない） */
export function setStudentCaptions(
  s: LiveSession,
  socketId: string,
  participantId: string,
  on: boolean
): void {
  if (on) s.captionWants.set(socketId, participantId);
  else s.captionWants.delete(socketId);
  recomputeCaptions(s);
}

/** 接続が切れた端末の分を外す。変化があったときだけ true */
export function dropCaptionWant(s: LiveSession, socketId: string): boolean {
  if (!s.captionWants.delete(socketId)) return false;
  recomputeCaptions(s);
  return true;
}

/** 字幕を使っている生徒の人数。同じ生徒が2台開いていても1人と数える */
export function captionUserCount(s: LiveSession): number {
  return new Set(s.captionWants.values()).size;
}

/** リアクションボタンの上限（先生画面の1行に収まる数） */
const MAX_REACTION_BUTTONS = 6;

/**
 * リアクションボタンの定義を差し替える（授業中でも変えられる）。
 *
 * key は先生が編集しても保つ。過去の反応は key で記録されているので、
 * 付け替えると授業後の集計でラベルと色を引けなくなるため。
 */
export async function setReactionButtons(
  s: LiveSession,
  input: ReactionButtonDef[]
): Promise<{ error?: string }> {
  const seen = new Set<string>();
  const buttons: ReactionButtonDef[] = [];
  for (const b of input.slice(0, MAX_REACTION_BUTTONS)) {
    const label = String(b?.label ?? '').trim().slice(0, 20);
    if (!label) continue;
    let key = String(b?.key ?? '').trim().slice(0, 40) || `btn_${buttons.length}`;
    while (seen.has(key)) key = `${key}_`;
    seen.add(key);
    const color = /^#[0-9a-fA-F]{6}$/.test(String(b?.color)) ? String(b.color) : '#2563eb';
    buttons.push({ key, label, color, hidden: b?.hidden === true });
  }
  if (buttons.length === 0) return { error: 'ボタンを1つ以上残してください' };
  s.reactionButtons = buttons;
  await db
    .update(schema.lessons)
    .set({ reactionButtons: buttons })
    .where(eq(schema.lessons.id, s.lessonId));
  return {};
}

export async function setReactionsEnabled(s: LiveSession, enabled: boolean): Promise<void> {
  s.reactionsEnabled = enabled;
  await db
    .update(schema.lessons)
    .set({ reactionsEnabled: enabled })
    .where(eq(schema.lessons.id, s.lessonId));
}

// ---- タスク ----

/**
 * タスク一覧を差し替える（授業前の設定も授業中の追加も同じ経路）。
 * id が付いているものは既存タスクとして維持し、id 無しを新規として採番する。
 * 授業中に増えたタスクには追加時刻を記録しておく（0%の意味が「未着手」ではなく
 * 「まだ存在していなかった」であることを、授業後の集計で区別できるように）。
 */
export async function setTasks(
  s: LiveSession,
  input: { id?: string; label: string }[]
): Promise<LessonTask[]> {
  const now = s.startedAtEpochMs ? tMs(s) : null;
  const existing = new Map(s.tasks.map((t) => [t.id, t]));
  const next: LessonTask[] = [];
  for (const item of input.slice(0, MAX_TASKS)) {
    const label = item.label.trim().slice(0, 40);
    if (!label) continue;
    const prev = item.id ? existing.get(item.id) : undefined;
    next.push(
      prev ? { ...prev, label } : { id: crypto.randomUUID(), label, addedAtMs: now }
    );
  }
  s.tasks = next;
  await db.update(schema.lessons).set({ tasks: next }).where(eq(schema.lessons.id, s.lessonId));

  // 消えたタスクの完了記録は畳んだ状態からも外す（残すと達成率の分子がずれる）
  const alive = new Set(next.map((t) => t.id));
  for (const [pid, done] of s.taskProgress) {
    for (const id of done) if (!alive.has(id)) done.delete(id);
    if (done.size === 0) s.taskProgress.delete(pid);
  }
  return next;
}

export async function setTaskConfig(
  s: LiveSession,
  p: { mode?: TaskMode; active?: boolean }
): Promise<void> {
  const patch: { taskMode?: TaskMode; tasksActive?: boolean } = {};
  if (p.mode === 'sequential' || p.mode === 'free') {
    s.taskMode = p.mode;
    patch.taskMode = p.mode;
  }
  if (typeof p.active === 'boolean') {
    s.tasksActive = p.active;
    patch.tasksActive = p.active;
  }
  if (Object.keys(patch).length === 0) return;
  await db.update(schema.lessons).set(patch).where(eq(schema.lessons.id, s.lessonId));
}

/**
 * 生徒1人のタスク完了・取り消しを適用して記録する。
 * 順番通りモードの補完はここ（applyTaskChange）だけで行い、生徒側には持たせない。
 * 変化が無ければ null を返す（同じ状態の再送でイベントを増やさない）。
 */
export async function setTaskProgress(
  s: LiveSession,
  participantId: string,
  taskId: string,
  done: boolean
): Promise<string[] | null> {
  const current = s.tasks
    .filter((t) => s.taskProgress.get(participantId)?.has(t.id))
    .map((t) => t.id);
  const next = applyTaskChange(s.tasks, current, taskId, done, s.taskMode);
  if (next.length === current.length && next.every((id, i) => id === current[i])) return null;

  const payload: TaskProgressPayload = { participantId, taskIds: next };
  await recordEvent(s, 'task_progress', payload, undefined, participantId);
  return next;
}

export function taskProgressOf(s: LiveSession, participantId: string): string[] {
  const done = s.taskProgress.get(participantId);
  if (!done) return [];
  return s.tasks.filter((t) => done.has(t.id)).map((t) => t.id);
}

/** 先生画面に出す全員分の進捗。まだ何もしていない参加者も 0件として含める */
export async function listTaskProgress(s: LiveSession): Promise<TaskProgressEntry[]> {
  const rows = await db
    .select({ id: schema.participants.id, displayName: schema.participants.displayName })
    .from(schema.participants)
    .where(eq(schema.participants.lessonId, s.lessonId));
  return rows.map((r) => ({
    participantId: r.id,
    participantName: r.displayName,
    taskIds: taskProgressOf(s, r.id),
    updatedAtMs: s.taskUpdatedAt.get(r.id) ?? 0,
  }));
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
    .where(
      and(
        eq(schema.participants.id, participantId),
        eq(schema.participants.lessonId, s.lessonId)
      )
    );
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

/** 受け取った映像チャンクがどちらの形式か。実際の mime から判断する */
function videoFormatOfMime(mime: string | undefined): VideoFormat {
  return mime?.startsWith('video/mp4') ? 'mp4' : 'webm';
}

/** 受け取った音声チャンクがどちらの形式か。実際の mime から判断する */
function audioFormatOfMime(mime: string | undefined): AudioFormat {
  return mime?.startsWith('audio/mp4') ? 'mp4' : 'webm';
}

/**
 * 先生からのカメラ映像チャンクを処理する。
 * 音声と違い保存はせず、中継のためのヘッダ保持と連番付けだけを行う
 * （復習動画はPDFと音声から組み立てる設計のため、映像はライブ限定）。
 *
 * 2形式が同時に流れてくるので、形式ごとにヘッダと連番を分けて持つ。
 * ヘッダより前の欠片は受け手がデコードできないため捨てる（null を返す）。
 */
export function handleAvChunk(
  s: LiveSession,
  buf: Buffer,
  mime?: string
): { format: VideoFormat; isInit: boolean; seq: number; mime: string } | null {
  const format = videoFormatOfMime(mime);
  const isInit = isInitSegment(buf);
  if (isInit) {
    s.avStreams.set(format, {
      init: buf,
      mime: mime ?? (format === 'mp4' ? 'video/mp4' : 'video/webm'),
      seq: 0,
    });
  }
  const stream = s.avStreams.get(format);
  if (!stream) return null;
  return { format, isInit, seq: stream.seq++, mime: stream.mime };
}

// ---- 音声 ----

/**
 * 先生からの音声チャンクを処理する。
 * 形式ごとに中継用ヘッダと連番を持つ。授業後の録音は二重保存せず、
 * Opus/WebMを優先し、作れない先生端末でだけAAC/MP4を保存する。
 */
export async function handleAudioChunk(
  s: LiveSession,
  buf: Buffer,
  mime?: string,
  archive = true
): Promise<{ format: AudioFormat; isInit: boolean; seq: number; mime: string } | null> {
  const format = audioFormatOfMime(mime);
  const isInit = isInitSegment(buf);
  if (isInit) {
    s.audioStreams.set(format, {
      init: buf,
      mime: mime ?? (format === 'mp4' ? 'audio/mp4' : 'audio/webm;codecs=opus'),
      seq: 0,
    });

    // 先生側が明示した1形式だけを保存する。旧画面はarchive引数を送らないためtrue扱い。
    if (archive) {
      if (s.currentAudioPart) s.currentAudioPart.stream.end();
      const startMs = tMs(s);
      const actualMime = mime ?? null;
      const file = `audio_${startMs}.${extForMime(actualMime)}`;
      const stream = fs.createWriteStream(path.join(lessonDir(s.lessonId), file), { flags: 'w' });
      s.currentAudioPart = { file, startMs, format, stream };
      await recordEvent(s, 'audio_part', { file }, startMs);
    }
  }

  const liveStream = s.audioStreams.get(format);
  if (!liveStream) {
    // サーバ再起動直後は中継ヘッダだけ失う。保存ファイルは復元済みなので欠片は追記し、
    // 呼び出し元へnullを返して先生の録音器を再起動（init再送）させる。
    if (archive && s.currentAudioPart?.format === format) s.currentAudioPart.stream.write(buf);
    return null;
  }

  if (archive && s.currentAudioPart?.format === format) s.currentAudioPart.stream.write(buf);
  return { format, isInit, seq: liveStream.seq++, mime: liveStream.mime };
}

// ---- 授業の開始・終了 ----

export async function startLesson(s: LiveSession): Promise<void> {
  const startedAt = new Date();
  s.status = 'live';
  s.startedAtEpochMs = startedAt.getTime();
  // 開始前に用意した書き込みはそのまま授業へ引き継ぐ。
  // これらは tMs=0 で保存済みなので、途中参加者も同じ状態を再構成できる。
  s.counts = {};
  s.recentReactions = [];
  s.composing.clear();
  s.audioStreams.clear();
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
  if (s.telemetryCameraStartedAt !== null) {
    s.telemetry.video.activeMs += Math.max(0, Date.now() - s.telemetryCameraStartedAt);
    s.telemetryCameraStartedAt = null;
  }
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
  await flushLessonTelemetry(s.lessonId, s.telemetry);
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

/**
 * サーバを終了するとき、書きかけのものを閉じる。
 *
 * **授業は終了させない。** 先生が止めたのではなくサーバ側の都合なので、
 * 立ち上げ直せば同じ授業の続きから再開できる状態のままにしておく。
 * ここで閉じるのは、閉じないと失われるものだけ:
 * - 録音の書き込みストリーム（end しないと最後の数秒がファイルに残らない）
 * - 5秒ごとにまとめて保存している匿名集計（待機中の分が消える）
 * - 文字起こしのタイマー（残っているとプロセスが終わらない）
 */
export async function flushAllSessions(): Promise<void> {
  for (const s of sessions.values()) {
    if (s.transcribeTimer) {
      clearInterval(s.transcribeTimer);
      s.transcribeTimer = null;
    }
    if (s.currentAudioPart) {
      const stream = s.currentAudioPart.stream;
      s.currentAudioPart = null;
      await new Promise<void>((resolve) => stream.end(() => resolve()));
    }
    try {
      await flushLessonTelemetry(s.lessonId, s.telemetry);
    } catch (err) {
      console.error('[live] 匿名集計の保存に失敗しました', err);
    }
  }
}

/**
 * 授業をメモリから外す（削除したときだけ使う）。
 *
 * DBの行を消しても、その授業のLiveSessionが残っていると、
 * 消えた授業IDに向けて書き込みが走って外部キー違反になる。
 * 読み込み中のPromiseも一緒に外さないと、削除の直後に呼ばれた
 * getSession() が消えた授業を組み立て直してしまう。
 */
export function forgetSession(lessonId: string): void {
  const s = sessions.get(lessonId);
  if (s?.transcribeTimer) clearInterval(s.transcribeTimer);
  sessions.delete(lessonId);
  sessionLoads.delete(lessonId);
}
