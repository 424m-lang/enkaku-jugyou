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
import type { ReactionButtonDef, ReactionCounts } from '@shared';

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
    clipStartMs: integer('clip_start_ms').notNull(),
    clipEndMs: integer('clip_end_ms').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('reactions_lesson_t_idx').on(t.lessonId, t.tMs)]
);

// 振り返りポイント: 先生が一定時間以上滞在したスライドの区間を1クラスタとして、
// 区間内の反応とAIまとめを保存する（授業中に生成し、再接続時はここから復元）
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
