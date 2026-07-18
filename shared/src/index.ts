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
export type ReflectionPayload = { reason?: string }; // 旧「振り返りタイム」イベントのペイロード（過去データ再生用に残置）
// 録音は通常1レッスン=1ファイルだが、先生の画面リロード等で録音が再開された場合は
// 新しいパートファイルに切り替わる。その境界もタイムラインイベントとして記録する
export type AudioPartPayload = { file: string };

export type TimelineEventType =
  | 'slide_change'
  | 'stroke'
  | 'pointer'
  | 'clear_slide'
  | 'reflection_start' // 旧機能（過去データ用）
  | 'reflection_end' // 旧機能（過去データ用）
  | 'audio_part';

export type TimelineEvent = {
  id: string;
  tMs: number; // 授業開始からの経過ミリ秒
  type: TimelineEventType;
  payload:
    | SlideChangePayload
    | StrokePayload
    | PointerPayload
    | ClearSlidePayload
    | ReflectionPayload
    | AudioPartPayload;
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
  /**
   * ボタンを押してから送信されるまでの経過ミリ秒。
   * オフラインキューからの再送時に、元の押下時刻をタイムライン上で復元するために使う
   * （端末の時計ズレの影響を受けない相対値）
   */
  delayMs: number;
  /**
   * 反応の対象スライド。コメントは「入力を始めたときのスライド」を入れることで、
   * 送信がページ切替の後になっても本来のスライドの振り返りポイントに紐づく
   */
  slideId?: string;
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

// ---- 振り返りポイント ----
// 先生が1分以上滞在したスライド（の滞在区間）を1つのクラスタとして扱う。
// 1分以内に元のスライドへ戻った場合は連続した説明とみなして切替と判定しない。
// 反応もコメントも無かった区間はポイントにしない。
export type ReflectionPoint = {
  id: string;
  slideId: string;
  startMs: number; // 滞在開始（授業タイムライン）
  endMs: number; // 滞在終了
  kinds: ReactionCounts; // 区間内のボタン反応数（コメントは含まない）
  comments: string[]; // 区間に対する生徒コメント本文
  summary: string | null; // 説明内容の要約（音声から。録音なしはnull）
  commentSummary: string | null; // 生徒コメントの要約（コメントなしはnull）
  status: 'pending' | 'ready' | 'failed';
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
  stroke_progress: (p: StrokePayload) => void; // 描画途中のプレビュー（記録されない）
  pointer: (p: PointerPayload) => void;
  clear_slide: (p: ClearSlidePayload & { tMs: number }) => void;

  // 音声
  audio_chunk: (chunk: ArrayBuffer, seq: number) => void;
  audio_init: (header: ArrayBuffer, seq: number) => void;

  // リアクション（先生向け）
  reaction_feed: (item: ReactionFeedItem, counts: ReactionCounts) => void;
  reaction_counts: (counts: ReactionCounts) => void;

  // 振り返りポイント（先生向け。新規作成時とAIまとめ完成時に同じイベントで届く）
  reflection_point: (point: ReflectionPoint) => void;
}

export interface ClientToServerEvents {
  // 先生
  start_lesson: (cb: (res: { ok: boolean; error?: string }) => void) => void;
  end_lesson: (cb: (res: { ok: boolean; error?: string }) => void) => void;
  audio_chunk: (chunk: ArrayBuffer) => void;
  slide_change: (p: SlideChangePayload) => void;
  stroke: (p: StrokePayload) => void;
  stroke_progress: (p: StrokePayload) => void;
  pointer: (p: PointerPayload) => void;
  clear_slide: (p: ClearSlidePayload) => void;
  insert_blank_slide: (
    afterPosition: number,
    cb: (res: { ok: boolean; slides?: SlideInfo[]; newSlideId?: string }) => void
  ) => void;

  // 生徒
  reaction: (r: ReactionInput, cb: (res: { ok: boolean }) => void) => void;
  /**
   * コメント入力中の合図（入力中は数秒おきに active:true、送信/クリアで active:false）。
   * サーバはこの合図がある間、そのスライドの振り返りポイントの要約を待つ
   */
  comment_composing: (p: { slideId: string; active: boolean }) => void;
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
  counts: ReactionCounts;
};

// ---- 文字起こし ----
export type TranscriptSegment = { startMs: number; endMs: number; text: string };

export type FullTranscriptSummary = {
  text: string;
  summary: string | null;
  segments: TranscriptSegment[] | null;
  provider: string;
  model: string | null;
  createdAt: string;
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
