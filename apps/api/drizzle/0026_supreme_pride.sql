CREATE TABLE "alert_cases" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"survey_id" text NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_alert_at" timestamp with time zone DEFAULT now() NOT NULL,
	"severity" text DEFAULT 'severe' NOT NULL,
	"assigned_to" text,
	"assigned_at" timestamp with time zone,
	"acknowledged_by" text,
	"acknowledged_at" timestamp with time zone,
	"note" text,
	"outcome" text,
	"merged_from_legacy" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "risk_alerts" ADD COLUMN "case_id" text;--> statement-breakpoint
ALTER TABLE "surveys" ADD COLUMN "alert_case_window_hours" integer;--> statement-breakpoint
ALTER TABLE "alert_cases" ADD CONSTRAINT "alert_cases_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_cases" ADD CONSTRAINT "alert_cases_survey_id_surveys_id_fk" FOREIGN KEY ("survey_id") REFERENCES "public"."surveys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_cases" ADD CONSTRAINT "alert_cases_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_cases" ADD CONSTRAINT "alert_cases_acknowledged_by_users_id_fk" FOREIGN KEY ("acknowledged_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alert_cases_user_idx" ON "alert_cases" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "alert_cases_open_idx" ON "alert_cases" USING btree ("acknowledged_at","last_alert_at");--> statement-breakpoint
CREATE INDEX "alert_cases_survey_idx" ON "alert_cases" USING btree ("survey_id");--> statement-breakpoint
ALTER TABLE "risk_alerts" ADD CONSTRAINT "risk_alerts_case_id_alert_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."alert_cases"("id") ON DELETE cascade ON UPDATE no action;