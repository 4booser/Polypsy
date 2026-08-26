ALTER TABLE "audit_log" ADD COLUMN "seq" integer;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "prev_hash" text;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "entry_hash" text;--> statement-breakpoint
CREATE UNIQUE INDEX "audit_seq_idx" ON "audit_log" USING btree ("seq");