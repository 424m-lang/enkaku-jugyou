// サーバ・クライアント共有の型定義

// ---- リアクションボタン ----
export type ReactionButtonDef = {
  key: string;
  label: string;
  color: string;
};

export const DEFAULT_REACTION_BUTTONS: ReactionButtonDef[] = [
  { key: 'understood', label: 'わかった', color: '#16a34a' },
  { key: 'confused', label: 'わからない', color: '#dc2626' },
];

// ---- スライド ----
export type SlideInfo = {
  id: string;
  kind: 'pdf_page' | 'blank';
  pdfPageIndex: number | null; // 0始まり（kind=pdf_page のとき）
  position: number;
};

// ---- タイムラインイベント ----
// 座標はすべてスライド幅・高さに対する 0..1 の正規化値
export type StrokeTool = 'pen' | 'line' | 'rect' | 'ellipse' | 'text' | 'eraser';

export type StrokePayload = {
  strokeId: string;
  slideId: string;
  tool: StrokeTool;
  color: string;
  width: number; // スライド幅に対する比
  points: number[]; // [x0,y0,x1,y1,...] フラット配列（データ量削減）
  text?: string; // tool=text のとき
  fontSize?: number; // スライド高さに対する比（tool=text のとき）
};

export type PointerPayload = {
  slideId: string;
  x: number;
  y: number;
  visible: boolean;
};

export type SlideChangePayload = { slideId: string };
export type ClearSlidePayload = { slideId: string; strokeIds?: string[] }; // strokeIds指定時は部分削除
export type ReflectionPayload = { reason?: string };

export type TimelineEventType =
  | 'slide_change'
  | 'stroke'
  | 'pointer'
  | 'clear_slide'
  | 'reflection_start'
  | 'reflection_end';

export type TimelineEvent = {
  id: string;
  tMs: number; // 授業開始からの経過ミリ秒
  type: TimelineEventType;
  payload:
    | SlideChangePayload
    | StrokePayload
    | PointerPayload
    | ClearSlidePayload
    | ReflectionPayload;
};

// ---- レッスン ----
export type LessonStatus = 'draft' | 'live' | 'ended';

export type LessonSummary = {
  id: string;
  title: string;
  joinCode: string;
  status: LessonStatus;
  reactionButtons: ReactionButtonDef[];
  pdfPageCount: number | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  audioDurationMs: number | null;
};

// ---- リアクション ----
export type ReactionInput = {
  kind: string; // ボタンのkey、コメントは 'comment'
  comment?: string;
  clientTs: number; // 生徒端末での送信時刻(epoch ms)。オフライン再送時に元の時刻を保持
};

export type ReactionFeedItem = {
  id: string;
  tMs: number;
  kind: string;
  comment: string | null;
  participantName: string;
};

export type ReactionCounts = Record<string, number>;

// ---- クリップ / クラスタ ----
export type ReactionCluster = {
  id: string; // クラスタの代表reaction id
  startMs: number;
  endMs: number; // クリップ再生範囲
  centerMs: number;
  kinds: ReactionCounts;
  participantCount: number;
  participants: { name: string; kind: string; comment: string | null; tMs: number }[];
  transcriptText?: string | null;
  summaryText?: string | null;
};

// ---- 振り返りタイム通知 ----
export type ReflectionAlert = {
  alertId: string;
  createdAtMs: number; // 授業タイムライン上の時刻
  reason: 'threshold' | 'interval';
  cluster: ReactionCluster | null;
  suggestion: string | null; // AIによる提案文（生成中はnull→後からsuggestionイベントで届く）
};

// ---- Socket.IO イベント型 ----
export interface ServerToClientEvents {
  // 授業状態
  lesson_state: (state: LiveLessonState) => void;
  lesson_started: () => void;
  lesson_ended: () => void;
  participant_count: (count: number) => void;
  slides_updated: (slides: SlideInfo[]) => void;

  // タイムライン系のブロードキャスト
  slide_change: (p: SlideChangePayload & { tMs: number }) => void;
  stroke: (p: StrokePayload & { tMs: number }) => void;
  pointer: (p: PointerPayload) => void;
  clear_slide: (p: ClearSlidePayload & { tMs: number }) => void;

  // 音声
  audio_chunk: (chunk: ArrayBuffer, seq: number) => void;
  audio_init: (header: ArrayBuffer, seq: number) => void;

  // リアクション（先生向け）
  reaction_feed: (item: ReactionFeedItem, counts: ReactionCounts) => void;
  reaction_counts: (counts: ReactionCounts) => void;

  // 振り返りタイム
  reflection_alert: (alert: ReflectionAlert) => void;
  reflection_suggestion: (alertId: string, suggestion: string) => void;
  reflection_started: () => void;
  reflection_ended: () => void;
}

export interface ClientToServerEvents {
  // 先生
  start_lesson: (cb: (res: { ok: boolean; error?: string }) => void) => void;
  end_lesson: (cb: (res: { ok: boolean; error?: string }) => void) => void;
  audio_chunk: (chunk: ArrayBuffer) => void;
  slide_change: (p: SlideChangePayload) => void;
  stroke: (p: StrokePayload) => void;
  pointer: (p: PointerPayload) => void;
  clear_slide: (p: ClearSlidePayload) => void;
  insert_blank_slide: (
    afterPosition: number,
    cb: (res: { ok: boolean; slides?: SlideInfo[]; newSlideId?: string }) => void
  ) => void;
  reflection_start: () => void;
  reflection_end: () => void;
  reflection_ack: (alertId: string) => void;

  // 生徒
  reaction: (r: ReactionInput, cb: (res: { ok: boolean }) => void) => void;
}

// 参加時にサーバから送る、授業のライブ状態スナップショット
export type LiveLessonState = {
  lessonId: string;
  status: LessonStatus;
  title: string;
  reactionButtons: ReactionButtonDef[];
  slides: SlideInfo[];
  currentSlideId: string | null;
  startedAtEpochMs: number | null; // 授業開始時刻
  serverNowEpochMs: number;
  // 現時点までの描画状態を再構成するためのイベント（stroke/clearのみ）
  drawingEvents: TimelineEvent[];
  reflectionActive: boolean;
  counts: ReactionCounts;
};

// ---- 統計 ----
export type LessonStats = {
  totalParticipants: number;
  totalReactions: number;
  countsByKind: ReactionCounts;
  // 1分ごとの反応数推移
  timeline: { minute: number; counts: ReactionCounts; total: number }[];
  // 生徒別
  perParticipant: {
    participantId: string;
    name: string;
    total: number;
    counts: ReactionCounts;
    reactions: { tMs: number; kind: string; comment: string | null }[];
  }[];
  // 話速（文字/分）と反応の相関（文字起こし済みの場合）
  speechRate: { minute: number; charsPerMin: number }[] | null;
};
