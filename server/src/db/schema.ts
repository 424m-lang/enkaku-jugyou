import {
  pgTable,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  doublePrecision,
  index,
} from 'drizzle-orm/pg-core';
import { uniqueIndex } from 'drizzle-orm/pg-core';
import type {
  CommentInsightDetails,
  InsightComment,
  LessonAiSettings,
  LessonTelemetry,
  LessonTask,
  PollOption,
  ReactionButtonDef,
  ReactionCounts,
} from '@shared';

export const teachers = pgTable('teachers', {
  id: text('id').primaryKey(),
  // 個人情報を集めない方針のため、メールアドレスではなく任意のログインIDを使う
  loginId: text('login_id').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  name: text('name').notNull(), // 表示名（ニックネーム可）
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const lessons = pgTable('lessons', {
  id: text('id').primaryKey(),
  teacherId: text('teacher_id')
    .notNull()
    .references(() => teachers.id),
  title: text('title').notNull(),
  joinCode: text('join_code').notNull().unique(),
  status: text('status', { enum: ['draft', 'live', 'ended'] })
    .notNull()
    .default('draft'),
  reactionButtons: jsonb('reaction_buttons').$type<ReactionButtonDef[]>().notNull(),
  // ボタンを使わない授業の設定。タスクとアンケートで生徒の状況が分かるようになったため、
  // 先生の好みで完全に無しにできる。定義そのものは消さないので、戻せば元のボタンが復活する
  reactionsEnabled: boolean('reactions_enabled').notNull().default(true),
  // 授業ごとのAI機能。既存授業の動作を維持するため、移行時の既定値はすべてON
  aiSettings: jsonb('ai_settings').$type<LessonAiSettings>().notNull().default({
    commentAnalysis: true,
    whisperCaptionHistory: true,
    lessonSummary: true,
    reviewChapters: true,
  }),
  // Phase 2（同意管理・匿名化）用のプレースホルダ
  anonymizeMode: boolean('anonymize_mode').notNull().default(false),
  pdfPath: text('pdf_path'),
  pdfPageCount: integer('pdf_page_count'),
  // PDF各ページのテキスト（クライアントで抽出して保存）。ブロック分けのAIに渡す
  pdfPageTexts: jsonb('pdf_page_texts').$type<string[]>(),
  // 生徒端末で先生の音声を鳴らすかの既定。教室モニターから音を出す授業は 'off'
  audioDefault: text('audio_default', { enum: ['on', 'off'] })
    .notNull()
    .default('on'),
  // 授業中に生徒へ出すタスク（事前設定・授業中の追加のどちらも同じ配列に入る）
  tasks: jsonb('tasks').$type<LessonTask[]>().notNull().default([]),
  // タスクの進め方。sequential=順番通り（既定）、free=順不同
  taskMode: text('task_mode', { enum: ['sequential', 'free'] })
    .notNull()
    .default('sequential'),
  // 生徒画面にタスクバーを出しているか（先生が授業中に開始・終了する）
  tasksActive: boolean('tasks_active').notNull().default(false),
  /**
   * 字幕の出し先。作るかどうかはこの2つから決まる（どちらかがONなら作る）。
   * 「作る」を別のスイッチにすると、作っているのに誰にも出ていない状態を作れてしまう
   */
  captionsOnScreen: boolean('captions_on_screen').notNull().default(false),
  captionsForStudents: boolean('captions_for_students').notNull().default(false),
  /** @deprecated 0014以降は captions_on_screen / captions_for_students から導出する */
  captionsEnabled: boolean('captions_enabled').notNull().default(false),
  // 教室モニターを先生のログイン無しで開くためのトークン
  screenToken: text('screen_token').unique(),
  // 教室モニターを開くための短いコード。長いトークン入りURLを入力せずに済むよう、
  // トークン入りの長いURLとは別に用意する（/m/XXXXXX で同じ画面に着く）
  screenCode: text('screen_code').unique(),
  // 復習動画（章立て再生ページ）の公開用トークン。未公開ならnull
  reviewShareToken: text('review_share_token').unique(),
  reviewPublishedAt: timestamp('review_published_at', { withTimezone: true }),
  audioPath: text('audio_path'),
  audioDurationMs: integer('audio_duration_ms'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * 通信品質の授業単位集計。
 * 1授業につき1行のJSONだけを持ち、参加者ID・氏名・IP・User-Agentは保存しない。
 */
export const lessonTelemetry = pgTable('lesson_telemetry', {
  lessonId: text('lesson_id')
    .primaryKey()
    .references(() => lessons.id),
  metrics: jsonb('metrics').$type<LessonTelemetry>().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// 授業内のスライド並び。白紙挿入は kind='blank' の行を追加するだけで、元PDFは不変
export const lessonSlides = pgTable(
  'lesson_slides',
  {
    id: text('id').primaryKey(),
    lessonId: text('lesson_id')
      .notNull()
      .references(() => lessons.id),
    kind: text('kind', { enum: ['pdf_page', 'blank'] }).notNull(),
    pdfPageIndex: integer('pdf_page_index'),
    position: doublePrecision('position').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('lesson_slides_lesson_idx').on(t.lessonId, t.position)]
);

export const participants = pgTable(
  'participants',
  {
    id: text('id').primaryKey(),
    lessonId: text('lesson_id')
      .notNull()
      .references(() => lessons.id),
    displayName: text('display_name').notNull(),
    tokenHash: text('token_hash').notNull(),
    // 音声の個別指定（授業の既定を上書きする。nullなら既定に従う）
    audioOverride: text('audio_override', { enum: ['on', 'off'] }),
    // Phase 2（同意管理）用のプレースホルダ
    consentStatus: text('consent_status').notNull().default('unknown'),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('participants_lesson_idx').on(t.lessonId)]
);

// アンケートの設問。1つの授業に何問でも用意でき、開けるのは同時に1問だけ
export const polls = pgTable(
  'polls',
  {
    id: text('id').primaryKey(),
    lessonId: text('lesson_id')
      .notNull()
      .references(() => lessons.id),
    question: text('question').notNull(),
    // 先生が設問ごとに選ぶ。scale は選択肢が順序を持つ単一選択
    type: text('type', { enum: ['single', 'multiple', 'scale', 'text'] }).notNull(),
    options: jsonb('options').$type<PollOption[]>().notNull().default([]),
    // scale の両端の意味（例: 1=わからない, 5=よくわかった）
    minLabel: text('min_label'),
    maxLabel: text('max_label'),
    status: text('status', { enum: ['draft', 'open', 'closed'] })
      .notNull()
      .default('draft'),
    // 授業開始からの経過ms。授業後に「いつ聞いたか」を音声と突き合わせるのに使う
    openedAtMs: integer('opened_at_ms'),
    closedAtMs: integer('closed_at_ms'),
    position: doublePrecision('position').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('polls_lesson_idx').on(t.lessonId, t.position)]
);

// 回答。1人1行で、締め切りまでは上書きされる（押し直しても票は増えない）
export const pollAnswers = pgTable(
  'poll_answers',
  {
    id: text('id').primaryKey(),
    pollId: text('poll_id')
      .notNull()
      .references(() => polls.id),
    lessonId: text('lesson_id')
      .notNull()
      .references(() => lessons.id),
    participantId: text('participant_id')
      .notNull()
      .references(() => participants.id),
    // 選択式（single/scale は1件、multiple は複数）
    optionIds: jsonb('option_ids').$type<string[]>().notNull().default([]),
    // 自由記述
    text: text('text'),
    answeredAtMs: integer('answered_at_ms').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('poll_answers_unique').on(t.pollId, t.participantId)]
);

// 単一タイムライン: 授業開始からの経過ミリ秒 t_ms を基準に全イベントを記録
export const timelineEvents = pgTable(
  'timeline_events',
  {
    id: text('id').primaryKey(),
    lessonId: text('lesson_id')
      .notNull()
      .references(() => lessons.id),
    tMs: integer('t_ms').notNull(),
    type: text('type').notNull(),
    actor: text('actor').notNull().default('teacher'),
    payload: jsonb('payload').notNull(),
  },
  (t) => [index('timeline_events_lesson_t_idx').on(t.lessonId, t.tMs)]
);

// リアクション = 連続音声ファイルへの軽量なタイムスタンプ参照（音声はコピーしない）
export const reactions = pgTable(
  'reactions',
  {
    id: text('id').primaryKey(),
    lessonId: text('lesson_id')
      .notNull()
      .references(() => lessons.id),
    participantId: text('participant_id')
      .notNull()
      .references(() => participants.id),
    tMs: integer('t_ms').notNull(),
    kind: text('kind').notNull(),
    comment: text('comment'),
    // 反応の対象スライド（コメントは入力開始時のスライド。旧データはnull）
    slideId: text('slide_id'),
    // コメントを入力し始めた時刻（授業開始からのms）。振り返りのクリップ位置に使う
    composeStartMs: integer('compose_start_ms'),
    clipStartMs: integer('clip_start_ms').notNull(),
    clipEndMs: integer('clip_end_ms').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('reactions_lesson_t_idx').on(t.lessonId, t.tMs)]
);

// コメント・振り返り: 生徒コメントを起点に、入力開始時刻周辺の音声のAI分析結果を
// 1枚のカードとして保存する（授業中に生成し、再接続時はここから復元）
export const commentInsights = pgTable(
  'comment_insights',
  {
    id: text('id').primaryKey(),
    lessonId: text('lesson_id')
      .notNull()
      .references(() => lessons.id),
    slideId: text('slide_id'), // 最初のコメントの入力開始時のスライド
    windowStartMs: integer('window_start_ms').notNull(),
    windowEndMs: integer('window_end_ms').notNull(),
    comments: jsonb('comments').$type<InsightComment[]>().notNull(),
    kinds: jsonb('kinds').$type<ReactionCounts>().notNull(),
    summary: text('summary'), // コメントに関連する先生の話の重要ポイント
    // 先生画面に表示する5項目。旧データは summary を「関連する説明」として表示する
    details: jsonb('details').$type<CommentInsightDetails>(),
    status: text('status', { enum: ['pending', 'ready', 'failed'] })
      .notNull()
      .default('pending'),
    /** 先生が拾い終えた印。授業中に「どれをまだ見ていないか」を見失わないために持つ */
    resolved: boolean('resolved').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('comment_insights_lesson_idx').on(t.lessonId, t.windowStartMs)]
);

// 旧・振り返りポイント（スライド滞在クラスタ方式）。過去データ参照用に残置
export const reflectionPoints = pgTable(
  'reflection_points',
  {
    id: text('id').primaryKey(),
    lessonId: text('lesson_id')
      .notNull()
      .references(() => lessons.id),
    slideId: text('slide_id').notNull(),
    startMs: integer('start_ms').notNull(),
    endMs: integer('end_ms').notNull(),
    kinds: jsonb('kinds').$type<ReactionCounts>().notNull(),
    comments: jsonb('comments').$type<string[]>().notNull(),
    summary: text('summary'), // 説明内容の要約（音声から）
    commentSummary: text('comment_summary'), // 生徒コメントの要約
    status: text('status', { enum: ['pending', 'ready', 'failed'] })
      .notNull()
      .default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('reflection_points_lesson_idx').on(t.lessonId, t.startMs)]
);

// 授業後の「コメント」タブ: コメントが向けられた先生の発言をAIが特定した結果。
// 文字起こし＋AI推定はコストがかかるため、一度解析したら保存して再利用する
export const commentClips = pgTable(
  'comment_clips',
  {
    id: text('id').primaryKey(),
    lessonId: text('lesson_id')
      .notNull()
      .references(() => lessons.id),
    reactionId: text('reaction_id')
      .notNull()
      .references(() => reactions.id),
    clipStartMs: integer('clip_start_ms').notNull(),
    clipEndMs: integer('clip_end_ms').notNull(),
    targetText: text('target_text'), // 特定された先生の発言
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('comment_clips_lesson_idx').on(t.lessonId)]
);

// 復習動画のブロック。授業全体を話題の切れ目で区分けした再生区間を保存する
export const reviewChapters = pgTable(
  'review_chapters',
  {
    id: text('id').primaryKey(),
    lessonId: text('lesson_id')
      .notNull()
      .references(() => lessons.id),
    position: doublePrecision('position').notNull(),
    startMs: integer('start_ms').notNull(),
    endMs: integer('end_ms').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    included: boolean('included').notNull().default(true),
    // ブロックの間に説明していたスライド（概要と一緒に表示する）
    slideIds: jsonb('slide_ids').$type<string[]>().notNull().default([]),
    // 先生が映像内に足す補足文章
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('review_chapters_lesson_idx').on(t.lessonId, t.position)]
);

// 文字起こし・要約（授業中のクリップ範囲 / 授業後の全体 の両方を同じ仕組みで保存）
export const transcripts = pgTable(
  'transcripts',
  {
    id: text('id').primaryKey(),
    lessonId: text('lesson_id')
      .notNull()
      .references(() => lessons.id),
    scope: text('scope', { enum: ['clip', 'full'] }).notNull(),
    rangeStartMs: integer('range_start_ms').notNull(),
    rangeEndMs: integer('range_end_ms').notNull(),
    text: text('text').notNull(),
    summary: text('summary'),
    /** 文字起こしのセグメント [{startMs,endMs,text}]（話速計測に使用） */
    segments: jsonb('segments'),
    provider: text('provider').notNull(),
    model: text('model'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('transcripts_lesson_idx').on(t.lessonId)]
);
