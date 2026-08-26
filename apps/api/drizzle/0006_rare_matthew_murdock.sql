CREATE TABLE "kiosk_participants" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"user_id" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "kiosk_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"title" text NOT NULL,
	"battery_id" text NOT NULL,
	"created_by" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kiosk_participants" ADD CONSTRAINT "kiosk_participants_session_id_kiosk_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."kiosk_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kiosk_participants" ADD CONSTRAINT "kiosk_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kiosk_sessions" ADD CONSTRAINT "kiosk_sessions_battery_id_batteries_id_fk" FOREIGN KEY ("battery_id") REFERENCES "public"."batteries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kiosk_sessions" ADD CONSTRAINT "kiosk_sessions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "kiosk_participants_session_idx" ON "kiosk_participants" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "kiosk_sessions_hash_idx" ON "kiosk_sessions" USING btree ("token_hash");