ALTER TABLE "machine" ADD COLUMN "sources" text;--> statement-breakpoint
ALTER TABLE "machine" ADD COLUMN "sources_index" text;--> statement-breakpoint
ALTER TABLE "machine" ADD COLUMN "sources_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "machine" ADD COLUMN "source_requests" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "machine" ADD CONSTRAINT "machine_sources_sealed" CHECK ("machine"."sources" ~ '^abe1[.][A-Za-z0-9_-]{38,}$');--> statement-breakpoint
ALTER TABLE "machine" ADD CONSTRAINT "machine_sources_index_blind" CHECK ("machine"."sources_index" ~ '^abh1[.][A-Za-z0-9_-]{43}$');