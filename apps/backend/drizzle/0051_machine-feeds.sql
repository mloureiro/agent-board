ALTER TABLE "machine" ADD COLUMN "feeds" text;--> statement-breakpoint
ALTER TABLE "machine" ADD COLUMN "feeds_index" text;--> statement-breakpoint
ALTER TABLE "machine" ADD COLUMN "feeds_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "machine" ADD COLUMN "feed_requests" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "machine" ADD CONSTRAINT "machine_feeds_sealed" CHECK ("machine"."feeds" ~ '^abe1[.][A-Za-z0-9_-]{38,}$');--> statement-breakpoint
ALTER TABLE "machine" ADD CONSTRAINT "machine_feeds_index_blind" CHECK ("machine"."feeds_index" ~ '^abh1[.][A-Za-z0-9_-]{43}$');