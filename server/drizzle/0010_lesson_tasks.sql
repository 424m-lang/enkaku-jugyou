ALTER TABLE "lessons" ADD COLUMN "tasks" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "lessons" ADD COLUMN "task_mode" text DEFAULT 'sequential' NOT NULL;--> statement-breakpoint
ALTER TABLE "lessons" ADD COLUMN "tasks_active" boolean DEFAULT false NOT NULL;
