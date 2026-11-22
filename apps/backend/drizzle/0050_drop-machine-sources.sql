ALTER TABLE "machine" DROP CONSTRAINT "machine_sources_sealed";--> statement-breakpoint
ALTER TABLE "machine" DROP CONSTRAINT "machine_sources_index_blind";--> statement-breakpoint
ALTER TABLE "machine" DROP COLUMN "sources";--> statement-breakpoint
ALTER TABLE "machine" DROP COLUMN "sources_index";--> statement-breakpoint
ALTER TABLE "machine" DROP COLUMN "sources_updated_at";--> statement-breakpoint
ALTER TABLE "machine" DROP COLUMN "source_requests";