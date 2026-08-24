ALTER TABLE "lessons" ADD COLUMN "audio_default" text DEFAULT 'on' NOT NULL;--> statement-breakpoint
ALTER TABLE "lessons" ADD COLUMN "screen_token" text;--> statement-breakpoint
ALTER TABLE "participants" ADD COLUMN "audio_override" text;--> statement-breakpoint
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_screen_token_unique" UNIQUE("screen_token");
