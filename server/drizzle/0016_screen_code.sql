ALTER TABLE "lessons" ADD COLUMN "screen_code" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "lessons_screen_code_unique" ON "lessons" ("screen_code");
