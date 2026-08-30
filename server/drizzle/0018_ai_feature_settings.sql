ALTER TABLE "lessons" ADD COLUMN "ai_settings" jsonb DEFAULT '{"commentAnalysis":true,"whisperCaptionHistory":true,"lessonSummary":true,"reviewChapters":true}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "comment_insights" ADD COLUMN "details" jsonb;
