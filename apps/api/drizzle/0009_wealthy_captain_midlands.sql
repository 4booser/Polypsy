CREATE TABLE "conclusions" (
	"id" text PRIMARY KEY NOT NULL,
	"response_id" text NOT NULL,
	"version" integer NOT NULL,
	"text" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"signed_at" timestamp with time zone,
	"signed_by" text
);
--> statement-breakpoint
ALTER TABLE "conclusions" ADD CONSTRAINT "conclusions_response_id_responses_id_fk" FOREIGN KEY ("response_id") REFERENCES "public"."responses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conclusions" ADD CONSTRAINT "conclusions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conclusions" ADD CONSTRAINT "conclusions_signed_by_users_id_fk" FOREIGN KEY ("signed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conclusions_response_version_idx" ON "conclusions" USING btree ("response_id","version");