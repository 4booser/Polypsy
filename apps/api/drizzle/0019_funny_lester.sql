ALTER TABLE "scale_bands" ADD COLUMN "cascade_battery_id" text;--> statement-breakpoint
ALTER TABLE "scale_bands" ADD COLUMN "cascade_due_days" integer;--> statement-breakpoint
ALTER TABLE "scale_bands" ADD COLUMN "follow_up_days" text;--> statement-breakpoint
ALTER TABLE "scale_bands" ADD CONSTRAINT "scale_bands_cascade_battery_id_batteries_id_fk" FOREIGN KEY ("cascade_battery_id") REFERENCES "public"."batteries"("id") ON DELETE set null ON UPDATE no action;