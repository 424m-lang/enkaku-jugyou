CREATE TABLE "polls" (
	"id" text PRIMARY KEY NOT NULL,
	"lesson_id" text NOT NULL,
	"question" text NOT NULL,
	"type" text NOT NULL,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"min_label" text,
	"max_label" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"opened_at_ms" integer,
	"closed_at_ms" integer,
	"position" double precision NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "poll_answers" (
	"id" text PRIMARY KEY NOT NULL,
	"poll_id" text NOT NULL,
	"lesson_id" text NOT NULL,
	"participant_id" text NOT NULL,
	"option_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"text" text,
	"answered_at_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "polls" ADD CONSTRAINT "polls_lesson_id_lessons_id_fk" FOREIGN KEY ("lesson_id") REFERENCES "public"."lessons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poll_answers" ADD CONSTRAINT "poll_answers_poll_id_polls_id_fk" FOREIGN KEY ("poll_id") REFERENCES "public"."polls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poll_answers" ADD CONSTRAINT "poll_answers_lesson_id_lessons_id_fk" FOREIGN KEY ("lesson_id") REFERENCES "public"."lessons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poll_answers" ADD CONSTRAINT "poll_answers_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "polls_lesson_idx" ON "polls" USING btree ("lesson_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "poll_answers_unique" ON "poll_answers" USING btree ("poll_id","participant_id");
