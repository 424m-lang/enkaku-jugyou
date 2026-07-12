CREATE TABLE "lesson_slides" (
	"id" text PRIMARY KEY NOT NULL,
	"lesson_id" text NOT NULL,
	"kind" text NOT NULL,
	"pdf_page_index" integer,
	"position" double precision NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lessons" (
	"id" text PRIMARY KEY NOT NULL,
	"teacher_id" text NOT NULL,
	"title" text NOT NULL,
	"join_code" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"reaction_buttons" jsonb NOT NULL,
	"anonymize_mode" boolean DEFAULT false NOT NULL,
	"pdf_path" text,
	"pdf_page_count" integer,
	"audio_path" text,
	"audio_duration_ms" integer,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lessons_join_code_unique" UNIQUE("join_code")
);
--> statement-breakpoint
CREATE TABLE "participants" (
	"id" text PRIMARY KEY NOT NULL,
	"lesson_id" text NOT NULL,
	"display_name" text NOT NULL,
	"token_hash" text NOT NULL,
	"consent_status" text DEFAULT 'unknown' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reactions" (
	"id" text PRIMARY KEY NOT NULL,
	"lesson_id" text NOT NULL,
	"participant_id" text NOT NULL,
	"t_ms" integer NOT NULL,
	"kind" text NOT NULL,
	"comment" text,
	"clip_start_ms" integer NOT NULL,
	"clip_end_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "teachers" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "teachers_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "timeline_events" (
	"id" text PRIMARY KEY NOT NULL,
	"lesson_id" text NOT NULL,
	"t_ms" integer NOT NULL,
	"type" text NOT NULL,
	"actor" text DEFAULT 'teacher' NOT NULL,
	"payload" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transcripts" (
	"id" text PRIMARY KEY NOT NULL,
	"lesson_id" text NOT NULL,
	"scope" text NOT NULL,
	"range_start_ms" integer NOT NULL,
	"range_end_ms" integer NOT NULL,
	"text" text NOT NULL,
	"summary" text,
	"provider" text NOT NULL,
	"model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lesson_slides" ADD CONSTRAINT "lesson_slides_lesson_id_lessons_id_fk" FOREIGN KEY ("lesson_id") REFERENCES "public"."lessons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_teacher_id_teachers_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "public"."teachers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participants" ADD CONSTRAINT "participants_lesson_id_lessons_id_fk" FOREIGN KEY ("lesson_id") REFERENCES "public"."lessons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reactions" ADD CONSTRAINT "reactions_lesson_id_lessons_id_fk" FOREIGN KEY ("lesson_id") REFERENCES "public"."lessons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reactions" ADD CONSTRAINT "reactions_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timeline_events" ADD CONSTRAINT "timeline_events_lesson_id_lessons_id_fk" FOREIGN KEY ("lesson_id") REFERENCES "public"."lessons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_lesson_id_lessons_id_fk" FOREIGN KEY ("lesson_id") REFERENCES "public"."lessons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lesson_slides_lesson_idx" ON "lesson_slides" USING btree ("lesson_id","position");--> statement-breakpoint
CREATE INDEX "participants_lesson_idx" ON "participants" USING btree ("lesson_id");--> statement-breakpoint
CREATE INDEX "reactions_lesson_t_idx" ON "reactions" USING btree ("lesson_id","t_ms");--> statement-breakpoint
CREATE INDEX "timeline_events_lesson_t_idx" ON "timeline_events" USING btree ("lesson_id","t_ms");--> statement-breakpoint
CREATE INDEX "transcripts_lesson_idx" ON "transcripts" USING btree ("lesson_id");