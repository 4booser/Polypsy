ALTER TABLE "surveys" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "surveys" ADD COLUMN "archived_by" text;--> statement-breakpoint
ALTER TABLE "surveys" ADD CONSTRAINT "surveys_archived_by_users_id_fk" FOREIGN KEY ("archived_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;