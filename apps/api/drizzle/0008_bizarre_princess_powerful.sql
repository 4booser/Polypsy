CREATE TABLE "alert_notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"alert_id" text NOT NULL,
	"kind" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"recipients" text NOT NULL,
	"channel" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "alert_notifications" ADD CONSTRAINT "alert_notifications_alert_id_risk_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."risk_alerts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "alert_notifications_alert_kind_idx" ON "alert_notifications" USING btree ("alert_id","kind");