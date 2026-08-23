ALTER TABLE "lessons" ADD COLUMN "pdf_page_texts" jsonb;--> statement-breakpoint
ALTER TABLE "review_chapters" ADD COLUMN "slide_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "review_chapters" ADD COLUMN "note" text;