CREATE TABLE "title_rules" (
	"owner" text PRIMARY KEY DEFAULT current_setting('app.owner', true) NOT NULL,
	"version" integer NOT NULL,
	"document" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "title_rules_document_sealed" CHECK ("title_rules"."document" ~ '^abe1[.][A-Za-z0-9_-]{38,}$'),
	CONSTRAINT "title_rules_version_positive" CHECK ("title_rules"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "title_rules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "title_rules" ADD CONSTRAINT "title_rules_owner_app_user_username_fk" FOREIGN KEY ("owner") REFERENCES "public"."app_user"("username") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "tenant" ON "title_rules" AS PERMISSIVE FOR ALL TO "board_app" USING (owner = (select current_setting('app.owner', true))) WITH CHECK (owner = (select current_setting('app.owner', true)));