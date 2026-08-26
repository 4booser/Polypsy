CREATE TABLE "batteries" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"group_id" text,
	"strict_order" boolean DEFAULT true NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "battery_assignments" (
	"id" text PRIMARY KEY NOT NULL,
	"battery_id" text NOT NULL,
	"user_id" text NOT NULL,
	"assigned_by" text,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"due_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "battery_items" (
	"battery_id" text NOT NULL,
	"survey_id" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"required" boolean DEFAULT true NOT NULL,
	CONSTRAINT "battery_items_battery_id_survey_id_pk" PRIMARY KEY("battery_id","survey_id")
);
--> statement-breakpoint
ALTER TABLE "batteries" ADD CONSTRAINT "batteries_group_id_survey_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."survey_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batteries" ADD CONSTRAINT "batteries_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "battery_assignments" ADD CONSTRAINT "battery_assignments_battery_id_batteries_id_fk" FOREIGN KEY ("battery_id") REFERENCES "public"."batteries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "battery_assignments" ADD CONSTRAINT "battery_assignments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "battery_assignments" ADD CONSTRAINT "battery_assignments_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "battery_items" ADD CONSTRAINT "battery_items_battery_id_batteries_id_fk" FOREIGN KEY ("battery_id") REFERENCES "public"."batteries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "battery_items" ADD CONSTRAINT "battery_items_survey_id_surveys_id_fk" FOREIGN KEY ("survey_id") REFERENCES "public"."surveys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "batteries_group_idx" ON "batteries" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "battery_assignments_user_idx" ON "battery_assignments" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "battery_assignments_battery_idx" ON "battery_assignments" USING btree ("battery_id");--> statement-breakpoint
CREATE UNIQUE INDEX "battery_assignments_active_idx" ON "battery_assignments" USING btree ("battery_id","user_id") WHERE completed_at is null and cancelled_at is null;--> statement-breakpoint
CREATE INDEX "battery_items_order_idx" ON "battery_items" USING btree ("battery_id","position");