ALTER TABLE "teachers" RENAME COLUMN "email" TO "login_id";--> statement-breakpoint
ALTER TABLE "teachers" RENAME CONSTRAINT "teachers_email_unique" TO "teachers_login_id_unique";