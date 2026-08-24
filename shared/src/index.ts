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

// ---- タスク（授業中の進捗確認） ----
export type LessonTask = {
  id: string;
  label: string;
  /**
   * 授業中に追加された場合の追加時刻（授業開始からのms）。事前に設定したものは null。
   * 「途中で追加したタスクの0%」を「誰もやっていない」と読み違えないために持つ
   */
  addedAtMs: number | null;
};

/**
 * タスクの進め方。
 * - sequential（既定）: タスクNを完了にすると、それより前も完了になる（取り消すと後ろが外れる）。
 *   進捗が必ず「先頭からの連続」になるので「どのタスクまで進んだか」として集計できる
 * - free: 各タスクを個別にオン/オフする。完了が累積しないので、集計はタスクごとの達成率になる
 */
export type TaskMode = 'sequential' | 'free';

export const MAX_TASKS = 12;

/** 先生画面に届く、生徒1人分の進捗 */
export type TaskProgressEntry = {
  participantId: string;
  participantName: string;
  taskIds: string[];
  /** 最後に進捗が動いた時刻（授業開始からのms）。止まっている生徒の検知に使う */
  updatedAtMs: number;
};

/**
 * 完了タスクの集合に1回の操作を適用する。順番通りと順不同の違いはこの関数だけに閉じている。
 * サーバの結果が正だが、生徒画面で押した瞬間に反映するためクライアントでも同じ関数を使う。
 * 返り値は tasks の並び順に整列された配列。
 */
export function applyTaskChange(
  tasks: LessonTask[],
  current: string[],
  taskId: string,
  done: boolean,
  mode: TaskMode
): string[] {
  const index = tasks.findIndex((t) => t.id === taskId);
  if (index < 0) return current;
  const next = new Set(current);
  if (mode === 'sequential') {
    // 押したタスクまで一気に完了 / 押したタスク以降をまとめて取り消し。
    // これによって「押し忘れたぶんを一覧から選んで取り戻す」動作が自然に成立する
    tasks.forEach((t, i) => {
      if (done ? i <= index : i >= index) {
        if (done) next.add(t.id);
        else next.delete(t.id);
      }
    });
  } else if (done) {
    next.add(taskId);
  } else {
    next.delete(taskId);
  }
  return tasks.filter((t) => next.has(t.id)).map((t) => t.id);
}

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
/**
 * 生徒1人の、その時点での完了タスク一覧（差分ではなくスナップショット）。
 * 取り消しも同じ形で記録されるので、畳み込むだけで現在の状態が復元できる。
 * 授業後に「タスクNを最初に完了した時刻」を出すときは、時系列順に見て
 * taskIds に初めて現れたイベントの tMs を採る。
 * そのとき、直後（数秒以内）に取り消されている完了は誤操作なので除外すること
 */
export type TaskProgressPayload = { participantId: string; taskIds: string[] };

export type TimelineEventType =
  | 'slide_change'
  | 'stroke'
  | 'pointer'
  | 'clear_slide'
  | 'reflection_start' // 旧機能（過去データ用）
  | 'reflection_end' // 旧機能（過去データ用）
  | 'audio_part'
  | 'task_progress';

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
    | AudioPartPayload
    | TaskProgressPayload;
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
   * 送信がページ切替の後になっても本来のスライドに対する反応として扱える
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

// ---- 授業後の振り返り: 「ボタン」クリップ ----
// ボタン反応1件につき「反応の30秒前〜15秒後」の45秒をクリップとし、
// 同じ事柄への反応とみなせる（時間が近く同じスライド）ものはひとつにまとめる。
export type ButtonClip = {
  id: string;
  startMs: number;
  endMs: number;
  kinds: ReactionCounts;
  participantCount: number;
  /** まとめられた個々の反応（薄字で反応時刻を出すために使う） */
  reactions: { name: string; kind: string; tMs: number }[];
  slideId: string | null;
};

// ---- 授業後の振り返り: 「コメント」クリップ ----
// コメントと、その数分前の文字起こしから「先生のどの発言に向けたコメントか」を
// AIが推定し、その位置にクリップを作る。未解析の間は入力開始時刻を基準にした暫定範囲。
export type CommentClip = {
  /** コメント（reaction）のid */
  id: string;
  text: string;
  participantName: string;
  /** 送信時刻（薄字で表示する） */
  tMs: number;
  /** 入力開始時刻（分からない場合は送信時刻と同じ） */
  composeStartMs: number;
  slideId: string | null;
  clipStartMs: number;
  clipEndMs: number;
  /** AIが特定した「このコメントが向けられた先生の発言」 */
  targetText: string | null;
  analyzed: boolean;
};

// ---- 復習動画（ブロック単位の再生ページ） ----
// 先生の発言（文字起こし）とPDFの内容をAIが読み、授業全体を話題の切れ目で
// 「ブロック」に区分けする。各ブロックはそれだけを見ても内容が分かる単位で、
// 先生は復習させたいブロックだけを選んで公開する。
// 動画ファイルは作らず、録音とスライド・書き込みを同期再生することで動画として機能する。
export type ReviewChapter = {
  id: string;
  position: number;
  startMs: number;
  endMs: number;
  title: string;
  description: string | null;
  /** 先生が復習動画に入れる・入れないを選べる */
  included: boolean;
  /** このブロックの間に説明していたスライド（概要と一緒に表示する。複数可） */
  slideIds: string[];
  /** 先生が映像内に足す補足文章（生徒の復習ページに表示される） */
  note: string | null;
};

// ---- スライド一覧タブ ----
// コメント・ボタン反応を「最も関連するであろうスライド」に振り分けた集計。
// コメントはAIが特定した対象発言の時刻、未解析なら入力開始時のスライドに振り分ける。
export type SlideStat = {
  slideId: string;
  /** 1始まりの通し番号（白紙挿入を含む授業内での並び） */
  slideNo: number;
  kind: 'pdf_page' | 'blank';
  pdfPageIndex: number | null;
  /** 表示していた時間の合計と回数（行ったり来たりした場合は合算される） */
  shownMs: number;
  showCount: number;
  firstShownMs: number | null;
  /** このスライドを説明していたブロック */
  chapterIds: string[];
  commentCount: number;
  buttonCount: number;
  kinds: ReactionCounts;
};

export type ReviewVideo = {
  chapters: ReviewChapter[];
  /** 公開URL用のトークン（未公開ならnull） */
  shareToken: string | null;
  publishedAt: string | null;
};

/** 生徒向け公開ページのデータ（誰が何を反応したかは一切含めない） */
export type WatchPage = {
  title: string;
  chapters: ReviewChapter[];
  slides: SlideInfo[];
  /** スライド送り・書き込み・ポインターの再現用 */
  events: TimelineEvent[];
  audioParts: { file: string; startMs: number }[];
  durationMs: number;
};

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

// ---- コメント・振り返り ----
// 生徒のコメントを起点に、入力開始時刻の周辺の先生の音声をAIで分析し、
// 「生徒が何についてコメントしようとしたのか（関連する説明の重要ポイント）」を
// 要約して表示するカード。届いた直後はコメント原文のみ（status=pending）で配信し、
// 分析が終わると同じidで要約・周辺反応数つきのカードに更新される。
// 同じ事柄への言及と判定されたコメントは1枚のカードに統合される。
export type InsightComment = {
  reactionId: string;
  text: string;
  participantName: string;
  tMs: number; // 送信時刻
  composeStartMs: number; // 入力開始時刻（この周辺の音声を分析する）
};

export type CommentInsight = {
  id: string;
  slideId: string | null; // 最初のコメントの入力開始時のスライド
  windowStartMs: number; // AI分析の対象になる音声範囲
  windowEndMs: number;
  comments: InsightComment[]; // 統合された場合は複数（原文はすべて表示する）
  kinds: ReactionCounts; // コメント周辺に届いた全生徒のボタン反応数
  summary: string | null; // コメントに関連する先生の話の重要ポイント（録音なしはnull）
  status: 'pending' | 'ready' | 'failed';
};

// ---- 教室スクリーン（大画面投影） ----

/**
 * 生徒端末で先生の音声を鳴らすかどうか。
 * 教室の大画面から音を出す授業では、各端末が同じ音を鳴らすと反響してしまうため
 * 既定を 'off' にし、遠隔で受けている生徒だけ 'on' に切り替える。
 */
export type AudioMode = 'on' | 'off';

/** 大画面のレイアウト（先生が切り替える） */
export type ScreenLayout =
  | 'slide' // スライド主体・カメラ映像は小窓
  | 'video' // カメラ映像主体・スライドは小窓（実演を見せるとき）
  | 'slide-only'; // スライドのみ

export const SCREEN_LAYOUT_LABELS: Record<ScreenLayout, string> = {
  slide: 'スライド主体',
  video: '映像主体',
  'slide-only': 'スライドのみ',
};

/** 先生画面の参加者一覧の1行 */
export type ParticipantInfo = {
  id: string;
  displayName: string;
  /** 実際に適用されている設定（個別指定があればそれ、無ければ授業の既定） */
  audio: AudioMode;
  /** 授業の既定ではなく個別に指定されているか */
  overridden: boolean;
  online: boolean;
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

  // カメラ映像（音声込みの1本のストリーム。大画面と遠隔の生徒にだけ届く）
  av_chunk: (chunk: ArrayBuffer, seq: number) => void;
  av_init: (header: ArrayBuffer, seq: number) => void;
  /** カメラのON/OFF、大画面のレイアウト、遠隔の生徒へ映像を送るか */
  av_state: (p: {
    cameraOn: boolean;
    layout: ScreenLayout;
    videoToStudents: boolean;
    /** カメラ映像に音声が入っているか（マイクが使えないと映像だけになる） */
    avHasAudio: boolean;
  }) => void;

  /** その端末で音声を鳴らしてよいか（生徒ごとに異なるため個別に届く） */
  audio_permission: (p: { audio: AudioMode }) => void;

  // 教室スクリーンの接続台数（先生向け。0なら大画面が映っていない）
  screen_count: (count: number) => void;
  // 参加者一覧（先生向け。音声の個別切替に使う）
  participants: (list: ParticipantInfo[]) => void;

  // リアクション（先生向け）
  reaction_feed: (item: ReactionFeedItem, counts: ReactionCounts) => void;
  reaction_counts: (counts: ReactionCounts) => void;

  // コメント・振り返り（先生向け。コメント到着時とAI分析完成時に同じidで届く → 上書き）
  comment_insight: (insight: CommentInsight) => void;
  // コメントが既存カードへ統合されて不要になったカードの削除通知
  comment_insight_removed: (insightId: string) => void;

  // ---- タスク ----
  /**
   * 自分の進捗（生徒向け）。他の生徒の進捗は生徒には一切届けない。
   * 進んでいる人が見えると、遅れている生徒への圧力になってしまうため
   */
  my_task_progress: (p: { taskIds: string[] }) => void;
  /** 参加者全員の進捗（先生向け。接続直後のスナップショット） */
  task_progress_all: (list: TaskProgressEntry[]) => void;
  /** 進捗の更新（先生向け。1人分ずつ届く） */
  task_progress: (entry: TaskProgressEntry) => void;

}

export interface ClientToServerEvents {
  // 先生
  start_lesson: (cb: (res: { ok: boolean; error?: string }) => void) => void;
  end_lesson: (cb: (res: { ok: boolean; error?: string }) => void) => void;
  audio_chunk: (chunk: ArrayBuffer) => void;
  /** カメラ映像（音声込み）。文字起こしには使わず、保存もしない */
  av_chunk: (chunk: ArrayBuffer) => void;
  camera_state: (p: { on: boolean; hasAudio?: boolean }) => void;
  /**
   * 大画面のレイアウトと、遠隔の生徒へ映像を送るかの切り替え。
   * 映像は通信量が大きいため生徒への配信は既定でOFFにし、実演を見せるときだけONにする
   */
  set_av_config: (p: { layout?: ScreenLayout; videoToStudents?: boolean }) => void;
  /** 全生徒の音声の既定を切り替える（個別指定は解除される） */
  set_audio_default: (p: { mode: AudioMode }, cb: (res: { ok: boolean }) => void) => void;
  /** 生徒1人の音声を個別に切り替える（mode:null で既定へ戻す） */
  set_participant_audio: (
    p: { participantId: string; mode: AudioMode | null },
    cb: (res: { ok: boolean }) => void
  ) => void;
  slide_change: (p: SlideChangePayload) => void;
  stroke: (p: StrokePayload) => void;
  stroke_progress: (p: StrokePayload) => void;
  pointer: (p: PointerPayload) => void;
  clear_slide: (p: ClearSlidePayload) => void;
  insert_blank_slide: (
    afterPosition: number,
    cb: (res: { ok: boolean; slides?: SlideInfo[]; newSlideId?: string }) => void
  ) => void;

  /**
   * タスク一覧の設定（授業前の事前設定と、授業中の追加の両方で使う）。
   * 既存タスクは id を付けて送ることで維持される（id 無し = 新規追加）
   */
  set_tasks: (
    p: { tasks: { id?: string; label: string }[] },
    cb: (res: { ok: boolean; tasks?: LessonTask[]; error?: string }) => void
  ) => void;
  /** タスクの進め方の切替と、生徒画面にタスクバーを出すかどうか */
  set_task_config: (
    p: { mode?: TaskMode; active?: boolean },
    cb: (res: { ok: boolean }) => void
  ) => void;


  // 生徒
  reaction: (r: ReactionInput, cb: (res: { ok: boolean }) => void) => void;
  /**
   * タスクの完了・取り消し。
   * 順番通りモードでの「前のタスクもまとめて完了にする」補完はサーバ側で行うので、
   * 生徒側は押されたタスク1つだけを送る
   */
  task_set: (p: { taskId: string; done: boolean }, cb: (res: { ok: boolean }) => void) => void;
  /**
   * コメント入力中の合図（入力中は数秒おきに active:true、送信/クリアで active:false）。
   * サーバは最初の合図の時刻を「入力開始時刻」として記録し、
   * コメント・振り返りのAI分析対象の音声範囲を決めるのに使う
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
  /** 生徒端末の音声の既定（教室の大画面から音を出す授業では 'off'） */
  audioDefault: AudioMode;
  cameraOn: boolean;
  screenLayout: ScreenLayout;
  // ---- タスク ----
  // 誰がどこまで進んだかは含めない（生徒にも届くため）。進捗は別イベントで配る
  tasks: LessonTask[];
  taskMode: TaskMode;
  /** 生徒画面にタスクバーを出すか（先生が開始・終了を切り替える） */
  tasksActive: boolean;
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
};
