CREATE TABLE "reflection_points" (
	"id" text PRIMARY KEY NOT NULL,
	"lesson_id" text NOT NULL,
	"slide_id" text NOT NULL,
	"start_ms" integer NOT NULL,
	"end_ms" integer NOT NULL,
	"kinds" jsonb NOT NULL,
	"comments" jsonb NOT NULL,
	"summary" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "reflection_points" ADD CONSTRAINT "reflection_points_lesson_id_lessons_id_fk" FOREIGN KEY ("lesson_id") REFERENCES "public"."lessons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reflection_points_lesson_idx" ON "reflection_points" USING btree ("lesson_id","start_ms");