CREATE TABLE "consent_texts" (
	"id" text PRIMARY KEY NOT NULL,
	"version" integer NOT NULL,
	"body" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "consents" (
	"user_id" text NOT NULL,
	"consent_text_id" text NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip" text,
	CONSTRAINT "consents_user_id_consent_text_id_pk" PRIMARY KEY("user_id","consent_text_id")
);
--> statement-breakpoint
ALTER TABLE "consent_texts" ADD CONSTRAINT "consent_texts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_consent_text_id_consent_texts_id_fk" FOREIGN KEY ("consent_text_id") REFERENCES "public"."consent_texts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "consent_texts_version_idx" ON "consent_texts" USING btree ("version");