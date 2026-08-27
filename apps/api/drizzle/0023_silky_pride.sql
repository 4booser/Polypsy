ALTER TABLE "batteries" DROP CONSTRAINT "batteries_created_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "invites" DROP CONSTRAINT "invites_created_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "kiosk_sessions" DROP CONSTRAINT "kiosk_sessions_created_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "schedules" DROP CONSTRAINT "schedules_created_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "survey_groups" DROP CONSTRAINT "survey_groups_created_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "surveys" DROP CONSTRAINT "surveys_created_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "batteries" ADD CONSTRAINT "batteries_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kiosk_sessions" ADD CONSTRAINT "kiosk_sessions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_groups" ADD CONSTRAINT "survey_groups_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "surveys" ADD CONSTRAINT "surveys_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;