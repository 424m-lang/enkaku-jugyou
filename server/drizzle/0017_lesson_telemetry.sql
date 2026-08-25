CREATE TABLE "lesson_telemetry" (
	"lesson_id" text PRIMARY KEY NOT NULL,
	"metrics" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lesson_telemetry_lesson_id_lessons_id_fk" FOREIGN KEY ("lesson_id") REFERENCES "public"."lessons"("id") ON DELETE no action ON UPDATE no action
);
