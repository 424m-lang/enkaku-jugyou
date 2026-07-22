CREATE TABLE "comment_clips" (
	"id" text PRIMARY KEY NOT NULL,
	"lesson_id" text NOT NULL,
	"reaction_id" text NOT NULL,
	"clip_start_ms" integer NOT NULL,
	"clip_end_ms" integer NOT NULL,
	"target_text" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "reactions" ADD COLUMN "compose_start_ms" integer;--> statement-breakpoint
ALTER TABLE "comment_clips" ADD CONSTRAINT "comment_clips_lesson_id_lessons_id_fk" FOREIGN KEY ("lesson_id") REFERENCES "public"."lessons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_clips" ADD CONSTRAINT "comment_clips_reaction_id_reactions_id_fk" FOREIGN KEY ("reaction_id") REFERENCES "public"."reactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "comment_clips_lesson_idx" ON "comment_clips" USING btree ("lesson_id");