ALTER TABLE "responses" ADD COLUMN "client_request_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "responses_client_request_idx" ON "responses" USING btree ("client_request_id");