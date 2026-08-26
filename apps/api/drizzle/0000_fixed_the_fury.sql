CREATE TABLE "answer_events" (
	"id" text PRIMARY KEY NOT NULL,
	"response_id" text NOT NULL,
	"question_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"kind" text NOT NULL,
	"elapsed_ms" integer DEFAULT 0 NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"value" jsonb
);
--> statement-breakpoint
CREATE TABLE "answers" (
	"id" text PRIMARY KEY NOT NULL,
	"response_id" text NOT NULL,
	"question_id" text NOT NULL,
	"option_ids" jsonb,
	"text" text,
	"number" double precision,
	"date" text,
	"matrix" jsonb,
	"ranking" jsonb,
	"skipped" boolean DEFAULT false NOT NULL,
	"score" double precision,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"change_count" integer DEFAULT 0 NOT NULL,
	"visit_count" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_id" text,
	"actor_email" text,
	"actor_role" text,
	"action" text NOT NULL,
	"resource_type" text,
	"resource_id" text,
	"subject_user_id" text,
	"outcome" text DEFAULT 'success' NOT NULL,
	"ip" text,
	"user_agent" text,
	"details" jsonb
);
--> statement-breakpoint
CREATE TABLE "group_admins" (
	"group_id" text NOT NULL,
	"user_id" text NOT NULL,
	"added_by" text,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_admins_group_id_user_id_pk" PRIMARY KEY("group_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "options" (
	"id" text PRIMARY KEY NOT NULL,
	"question_id" text NOT NULL,
	"text" jsonb NOT NULL,
	"score" double precision DEFAULT 0 NOT NULL,
	"kind" text DEFAULT 'option' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"key_code" text,
	"risk_flag" boolean DEFAULT false NOT NULL,
	"risk_label" jsonb,
	"risk_severity" text
);
--> statement-breakpoint
CREATE TABLE "question_logic" (
	"id" text PRIMARY KEY NOT NULL,
	"question_id" text NOT NULL,
	"source_question_id" text NOT NULL,
	"operator" text NOT NULL,
	"value" jsonb,
	"action" text DEFAULT 'show' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "questions" (
	"id" text PRIMARY KEY NOT NULL,
	"survey_id" text NOT NULL,
	"version_id" text NOT NULL,
	"section_id" text,
	"type" text NOT NULL,
	"title" jsonb NOT NULL,
	"help" jsonb,
	"required" boolean DEFAULT false NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"scale_id" text,
	"reverse_scored" boolean DEFAULT false NOT NULL,
	"min_value" double precision,
	"max_value" double precision,
	"step" double precision,
	"min_label" text,
	"max_label" text,
	"randomize_options" boolean DEFAULT false NOT NULL,
	"time_limit_sec" integer,
	"risk_threshold" double precision,
	"risk_label" jsonb,
	"risk_severity" text
);
--> statement-breakpoint
CREATE TABLE "response_scores" (
	"id" text PRIMARY KEY NOT NULL,
	"response_id" text NOT NULL,
	"scale_id" text NOT NULL,
	"raw_score" double precision NOT NULL,
	"value" double precision DEFAULT 0 NOT NULL,
	"normalization" text DEFAULT 'raw' NOT NULL,
	"max_score" double precision NOT NULL,
	"percent" double precision NOT NULL,
	"band_label" text,
	"severity" text
);
--> statement-breakpoint
CREATE TABLE "responses" (
	"id" text PRIMARY KEY NOT NULL,
	"survey_id" text NOT NULL,
	"user_id" text,
	"status" text DEFAULT 'completed' NOT NULL,
	"version_id" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_at" timestamp with time zone,
	"last_saved_at" timestamp with time zone,
	"duration_ms" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "risk_alerts" (
	"id" text PRIMARY KEY NOT NULL,
	"response_id" text NOT NULL,
	"survey_id" text NOT NULL,
	"question_id" text NOT NULL,
	"user_id" text,
	"label" text NOT NULL,
	"severity" text DEFAULT 'severe' NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"acknowledged_by" text,
	"acknowledged_at" timestamp with time zone,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "scale_bands" (
	"id" text PRIMARY KEY NOT NULL,
	"scale_id" text NOT NULL,
	"min_score" double precision NOT NULL,
	"max_score" double precision NOT NULL,
	"label" jsonb NOT NULL,
	"severity" text DEFAULT 'none' NOT NULL,
	"description" jsonb,
	"grade" integer,
	"recommendation" jsonb,
	"position" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scale_corrections" (
	"target_scale_id" text NOT NULL,
	"source_scale_id" text NOT NULL,
	"coefficient" double precision NOT NULL,
	CONSTRAINT "scale_corrections_target_scale_id_source_scale_id_pk" PRIMARY KEY("target_scale_id","source_scale_id")
);
--> statement-breakpoint
CREATE TABLE "scale_items" (
	"scale_id" text NOT NULL,
	"question_id" text NOT NULL,
	"match_key" text,
	"weight" double precision DEFAULT 1 NOT NULL,
	CONSTRAINT "scale_items_scale_id_question_id_pk" PRIMARY KEY("scale_id","question_id")
);
--> statement-breakpoint
CREATE TABLE "scale_norms" (
	"id" text PRIMARY KEY NOT NULL,
	"scale_id" text NOT NULL,
	"anonymous" boolean DEFAULT false NOT NULL,
	"pseudonym" text,
	"sex" text,
	"age_min" integer,
	"age_max" integer,
	"mean" double precision NOT NULL,
	"sd" double precision NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scales" (
	"id" text PRIMARY KEY NOT NULL,
	"survey_id" text NOT NULL,
	"version_id" text NOT NULL,
	"code" text NOT NULL,
	"title" jsonb NOT NULL,
	"description" jsonb,
	"aggregation" text DEFAULT 'sum' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"kind" text DEFAULT 'clinical' NOT NULL,
	"normalization" text DEFAULT 'raw' NOT NULL,
	"ratio_denominator" double precision,
	"validity_threshold" double precision,
	"validity_direction" text,
	"validity_message" jsonb
);
--> statement-breakpoint
CREATE TABLE "sections" (
	"id" text PRIMARY KEY NOT NULL,
	"survey_id" text NOT NULL,
	"version_id" text NOT NULL,
	"title" jsonb NOT NULL,
	"description" jsonb,
	"position" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sten_rows" (
	"id" text PRIMARY KEY NOT NULL,
	"scale_id" text NOT NULL,
	"anonymous" boolean DEFAULT false NOT NULL,
	"pseudonym" text,
	"sex" text,
	"age_min" integer,
	"age_max" integer,
	"raw_min" double precision NOT NULL,
	"raw_max" double precision NOT NULL,
	"sten" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "survey_access" (
	"survey_id" text NOT NULL,
	"user_id" text NOT NULL,
	"granted_by" text,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"note" text,
	CONSTRAINT "survey_access_survey_id_user_id_pk" PRIMARY KEY("survey_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "survey_groups" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"color" text,
	"position" integer DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "survey_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"survey_id" text NOT NULL,
	"version" integer NOT NULL,
	"note" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "surveys" (
	"id" text PRIMARY KEY NOT NULL,
	"group_id" text,
	"title" jsonb NOT NULL,
	"description" jsonb,
	"instructions" jsonb,
	"administration" text DEFAULT 'self' NOT NULL,
	"too_fast_ms" integer,
	"alert_escalate_minutes" integer,
	"status" text DEFAULT 'draft' NOT NULL,
	"time_limit_sec" integer,
	"randomize_questions" boolean DEFAULT false NOT NULL,
	"allow_back" boolean DEFAULT true NOT NULL,
	"show_progress" boolean DEFAULT true NOT NULL,
	"anonymous" boolean DEFAULT false NOT NULL,
	"visibility" text DEFAULT 'public' NOT NULL,
	"allow_retake" boolean DEFAULT false NOT NULL,
	"scoring_enabled" boolean DEFAULT false NOT NULL,
	"created_by" text NOT NULL,
	"current_version_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"middle_name" text,
	"anonymous" boolean DEFAULT false NOT NULL,
	"pseudonym" text,
	"sex" text,
	"birth_date" text,
	"unit" text,
	"position" text,
	"specialty" text,
	"rank" text,
	"role" text DEFAULT 'user' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "answer_events" ADD CONSTRAINT "answer_events_response_id_responses_id_fk" FOREIGN KEY ("response_id") REFERENCES "public"."responses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answer_events" ADD CONSTRAINT "answer_events_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answers" ADD CONSTRAINT "answers_response_id_responses_id_fk" FOREIGN KEY ("response_id") REFERENCES "public"."responses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answers" ADD CONSTRAINT "answers_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_admins" ADD CONSTRAINT "group_admins_group_id_survey_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."survey_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_admins" ADD CONSTRAINT "group_admins_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_admins" ADD CONSTRAINT "group_admins_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "options" ADD CONSTRAINT "options_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_logic" ADD CONSTRAINT "question_logic_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_logic" ADD CONSTRAINT "question_logic_source_question_id_questions_id_fk" FOREIGN KEY ("source_question_id") REFERENCES "public"."questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_survey_id_surveys_id_fk" FOREIGN KEY ("survey_id") REFERENCES "public"."surveys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_version_id_survey_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."survey_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_section_id_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."sections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_scale_id_scales_id_fk" FOREIGN KEY ("scale_id") REFERENCES "public"."scales"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "response_scores" ADD CONSTRAINT "response_scores_response_id_responses_id_fk" FOREIGN KEY ("response_id") REFERENCES "public"."responses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "response_scores" ADD CONSTRAINT "response_scores_scale_id_scales_id_fk" FOREIGN KEY ("scale_id") REFERENCES "public"."scales"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "responses" ADD CONSTRAINT "responses_survey_id_surveys_id_fk" FOREIGN KEY ("survey_id") REFERENCES "public"."surveys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "responses" ADD CONSTRAINT "responses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "responses" ADD CONSTRAINT "responses_version_id_survey_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."survey_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_alerts" ADD CONSTRAINT "risk_alerts_response_id_responses_id_fk" FOREIGN KEY ("response_id") REFERENCES "public"."responses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_alerts" ADD CONSTRAINT "risk_alerts_survey_id_surveys_id_fk" FOREIGN KEY ("survey_id") REFERENCES "public"."surveys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_alerts" ADD CONSTRAINT "risk_alerts_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_alerts" ADD CONSTRAINT "risk_alerts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_alerts" ADD CONSTRAINT "risk_alerts_acknowledged_by_users_id_fk" FOREIGN KEY ("acknowledged_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scale_bands" ADD CONSTRAINT "scale_bands_scale_id_scales_id_fk" FOREIGN KEY ("scale_id") REFERENCES "public"."scales"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scale_corrections" ADD CONSTRAINT "scale_corrections_target_scale_id_scales_id_fk" FOREIGN KEY ("target_scale_id") REFERENCES "public"."scales"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scale_corrections" ADD CONSTRAINT "scale_corrections_source_scale_id_scales_id_fk" FOREIGN KEY ("source_scale_id") REFERENCES "public"."scales"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scale_items" ADD CONSTRAINT "scale_items_scale_id_scales_id_fk" FOREIGN KEY ("scale_id") REFERENCES "public"."scales"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scale_items" ADD CONSTRAINT "scale_items_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scale_norms" ADD CONSTRAINT "scale_norms_scale_id_scales_id_fk" FOREIGN KEY ("scale_id") REFERENCES "public"."scales"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scales" ADD CONSTRAINT "scales_survey_id_surveys_id_fk" FOREIGN KEY ("survey_id") REFERENCES "public"."surveys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scales" ADD CONSTRAINT "scales_version_id_survey_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."survey_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sections" ADD CONSTRAINT "sections_survey_id_surveys_id_fk" FOREIGN KEY ("survey_id") REFERENCES "public"."surveys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sections" ADD CONSTRAINT "sections_version_id_survey_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."survey_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sten_rows" ADD CONSTRAINT "sten_rows_scale_id_scales_id_fk" FOREIGN KEY ("scale_id") REFERENCES "public"."scales"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_access" ADD CONSTRAINT "survey_access_survey_id_surveys_id_fk" FOREIGN KEY ("survey_id") REFERENCES "public"."surveys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_access" ADD CONSTRAINT "survey_access_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_access" ADD CONSTRAINT "survey_access_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_groups" ADD CONSTRAINT "survey_groups_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_versions" ADD CONSTRAINT "survey_versions_survey_id_surveys_id_fk" FOREIGN KEY ("survey_id") REFERENCES "public"."surveys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_versions" ADD CONSTRAINT "survey_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "surveys" ADD CONSTRAINT "surveys_group_id_survey_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."survey_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "surveys" ADD CONSTRAINT "surveys_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "events_response_idx" ON "answer_events" USING btree ("response_id");--> statement-breakpoint
CREATE INDEX "events_question_idx" ON "answer_events" USING btree ("question_id");--> statement-breakpoint
CREATE INDEX "answers_response_idx" ON "answers" USING btree ("response_id");--> statement-breakpoint
CREATE INDEX "answers_question_idx" ON "answers" USING btree ("question_id");--> statement-breakpoint
CREATE INDEX "audit_at_idx" ON "audit_log" USING btree ("at");--> statement-breakpoint
CREATE INDEX "audit_actor_idx" ON "audit_log" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "audit_action_idx" ON "audit_log" USING btree ("action");--> statement-breakpoint
CREATE INDEX "audit_subject_idx" ON "audit_log" USING btree ("subject_user_id");--> statement-breakpoint
CREATE INDEX "group_admins_user_idx" ON "group_admins" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "options_question_idx" ON "options" USING btree ("question_id");--> statement-breakpoint
CREATE INDEX "logic_question_idx" ON "question_logic" USING btree ("question_id");--> statement-breakpoint
CREATE INDEX "questions_survey_idx" ON "questions" USING btree ("survey_id");--> statement-breakpoint
CREATE INDEX "questions_section_idx" ON "questions" USING btree ("section_id");--> statement-breakpoint
CREATE INDEX "scores_response_idx" ON "response_scores" USING btree ("response_id");--> statement-breakpoint
CREATE INDEX "scores_scale_idx" ON "response_scores" USING btree ("scale_id");--> statement-breakpoint
CREATE INDEX "responses_survey_idx" ON "responses" USING btree ("survey_id");--> statement-breakpoint
CREATE INDEX "responses_user_idx" ON "responses" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "responses_submitted_idx" ON "responses" USING btree ("submitted_at");--> statement-breakpoint
CREATE INDEX "alerts_survey_idx" ON "risk_alerts" USING btree ("survey_id");--> statement-breakpoint
CREATE INDEX "alerts_open_idx" ON "risk_alerts" USING btree ("acknowledged_at");--> statement-breakpoint
CREATE UNIQUE INDEX "alerts_response_question_idx" ON "risk_alerts" USING btree ("response_id","question_id");--> statement-breakpoint
CREATE INDEX "bands_scale_idx" ON "scale_bands" USING btree ("scale_id");--> statement-breakpoint
CREATE INDEX "scale_items_question_idx" ON "scale_items" USING btree ("question_id");--> statement-breakpoint
CREATE INDEX "norms_scale_idx" ON "scale_norms" USING btree ("scale_id");--> statement-breakpoint
CREATE INDEX "scales_survey_idx" ON "scales" USING btree ("survey_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scales_version_code_idx" ON "scales" USING btree ("version_id","code");--> statement-breakpoint
CREATE INDEX "sections_survey_idx" ON "sections" USING btree ("survey_id");--> statement-breakpoint
CREATE INDEX "sten_scale_idx" ON "sten_rows" USING btree ("scale_id");--> statement-breakpoint
CREATE INDEX "survey_access_user_idx" ON "survey_access" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "groups_position_idx" ON "survey_groups" USING btree ("position");--> statement-breakpoint
CREATE INDEX "versions_survey_idx" ON "survey_versions" USING btree ("survey_id");--> statement-breakpoint
CREATE UNIQUE INDEX "versions_survey_number_idx" ON "survey_versions" USING btree ("survey_id","version");--> statement-breakpoint
CREATE INDEX "surveys_status_idx" ON "surveys" USING btree ("status");--> statement-breakpoint
CREATE INDEX "surveys_group_idx" ON "surveys" USING btree ("group_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_idx" ON "users" USING btree ("email");