ALTER TABLE "lessons" ADD COLUMN "captions_on_screen" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "lessons" ADD COLUMN "captions_for_students" boolean DEFAULT false NOT NULL;
