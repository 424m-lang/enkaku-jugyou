CREATE TABLE "review_chapters" (
	"id" text PRIMARY KEY NOT NULL,
	"lesson_id" text NOT NULL,
	"position" double precision NOT NULL,
	"start_ms" integer NOT NULL,
	"end_ms" integer NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"included" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lessons" ADD COLUMN "review_share_token" text;--> statement-breakpoint
ALTER TABLE "lessons" ADD COLUMN "review_published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "review_chapters" ADD CONSTRAINT "review_chapters_lesson_id_lessons_id_fk" FOREIGN KEY ("lesson_id") REFERENCES "public"."lessons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "review_chapters_lesson_idx" ON "review_chapters" USING btree ("lesson_id","position");--> statement-breakpoint
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_review_share_token_unique" UNIQUE("review_share_token");