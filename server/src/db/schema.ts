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
import type { InsightComment, LessonTask, ReactionButtonDef, ReactionCounts } from '@shared';

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
  // Phase 2（同意管理・匿名化）用のプレースホルダ
  anonymizeMode: boolean('anonymize_mode').notNull().default(false),
  pdfPath: text('pdf_path'),
  pdfPageCount: integer('pdf_page_count'),
  // PDF各ページのテキスト（クライアントで抽出して保存）。ブロック分けのAIに渡す
  pdfPageTexts: jsonb('pdf_page_texts').$type<string[]>(),
  // 生徒端末で先生の音声を鳴らすかの既定。教室の大画面から音を出す授業は 'off'
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
  // 教室スクリーン（大画面）を先生のログイン無しで開くためのトークン
  screenToken: text('screen_token').unique(),
  // 復習動画（章立て再生ページ）の公開用トークン。未公開ならnull
  reviewShareToken: text('review_share_token').unique(),
  reviewPublishedAt: timestamp('review_published_at', { withTimezone: true }),
  audioPath: text('audio_path'),
  audioDurationMs: integer('audio_duration_ms'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
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
    status: text('status', { enum: ['pending', 'ready', 'failed'] })
      .notNull()
      .default('pending'),
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
