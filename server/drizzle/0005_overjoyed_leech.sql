CREATE TABLE "comment_insights" (
	"id" text PRIMARY KEY NOT NULL,
	"lesson_id" text NOT NULL,
	"slide_id" text,
	"window_start_ms" integer NOT NULL,
	"window_end_ms" integer NOT NULL,
	"comments" jsonb NOT NULL,
	"kinds" jsonb NOT NULL,
	"summary" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "comment_insights" ADD CONSTRAINT "comment_insights_lesson_id_lessons_id_fk" FOREIGN KEY ("lesson_id") REFERENCES "public"."lessons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "comment_insights_lesson_idx" ON "comment_insights" USING btree ("lesson_id","window_start_ms");