ALTER TABLE "schedule" ADD COLUMN "labels" text;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "labels" text;--> statement-breakpoint
ALTER TABLE "schedule" ADD CONSTRAINT "schedule_labels_sealed" CHECK ("schedule"."labels" ~ '^abe1[.][A-Za-z0-9_-]{38,}$');--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_labels_sealed" CHECK ("task"."labels" ~ '^abe1[.][A-Za-z0-9_-]{38,}$');