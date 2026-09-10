CREATE TYPE "public"."review_priority" AS ENUM('high', 'urgent');--> statement-breakpoint
CREATE TYPE "public"."review_state" AS ENUM('pending', 'in_review', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."risk_level" AS ENUM('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"actor_type" varchar(32) NOT NULL,
	"actor_id" varchar(128),
	"action" varchar(64) NOT NULL,
	"resource_type" varchar(64) NOT NULL,
	"resource_id" uuid NOT NULL,
	"idempotency_key" varchar(192) NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"safe_metadata" jsonb NOT NULL,
	"retention_until" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "human_review_queue_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"risk_event_id" uuid NOT NULL,
	"priority" "review_priority" NOT NULL,
	"state" "review_state" DEFAULT 'pending' NOT NULL,
	"assigned_reviewer_id" varchar(128),
	"created_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"reviewed_at" timestamp with time zone,
	"resolution_code" varchar(64),
	CONSTRAINT "human_review_queue_state_timestamps_check" CHECK (("human_review_queue_items"."state" = 'pending' AND "human_review_queue_items"."started_at" IS NULL AND "human_review_queue_items"."reviewed_at" IS NULL AND "human_review_queue_items"."resolution_code" IS NULL) OR ("human_review_queue_items"."state" = 'in_review' AND "human_review_queue_items"."started_at" IS NOT NULL AND "human_review_queue_items"."reviewed_at" IS NULL AND "human_review_queue_items"."resolution_code" IS NULL) OR ("human_review_queue_items"."state" = 'resolved' AND "human_review_queue_items"."started_at" IS NOT NULL AND "human_review_queue_items"."reviewed_at" IS NOT NULL AND "human_review_queue_items"."resolution_code" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "risk_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"conversation_id" uuid,
	"ai_turn_id" uuid,
	"trigger_message_id" uuid,
	"client_request_id" uuid NOT NULL,
	"is_incognito" boolean NOT NULL,
	"risk_level" "risk_level" NOT NULL,
	"risk_categories" text[] NOT NULL,
	"reason_codes" text[] NOT NULL,
	"detection_source" varchar(32) NOT NULL,
	"policy_version" varchar(64) NOT NULL,
	"classifier_key" varchar(64),
	"classifier_version" varchar(64),
	"created_at" timestamp with time zone NOT NULL,
	"retention_until" timestamp with time zone NOT NULL,
	CONSTRAINT "risk_events_incognito_refs_check" CHECK ("risk_events"."is_incognito" = false OR ("risk_events"."conversation_id" IS NULL AND "risk_events"."ai_turn_id" IS NULL AND "risk_events"."trigger_message_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "human_review_queue_items" ADD CONSTRAINT "human_review_queue_items_risk_event_id_risk_events_id_fk" FOREIGN KEY ("risk_event_id") REFERENCES "public"."risk_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_events" ADD CONSTRAINT "risk_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_events" ADD CONSTRAINT "risk_events_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_events" ADD CONSTRAINT "risk_events_ai_turn_id_ai_turns_id_fk" FOREIGN KEY ("ai_turn_id") REFERENCES "public"."ai_turns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_events" ADD CONSTRAINT "risk_events_trigger_message_id_messages_id_fk" FOREIGN KEY ("trigger_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "audit_logs_idempotency_key_unique" ON "audit_logs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "audit_logs_resource_idx" ON "audit_logs" USING btree ("resource_type","resource_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_logs_retention_until_idx" ON "audit_logs" USING btree ("retention_until");--> statement-breakpoint
CREATE UNIQUE INDEX "human_review_queue_risk_event_unique" ON "human_review_queue_items" USING btree ("risk_event_id");--> statement-breakpoint
CREATE INDEX "human_review_queue_state_priority_idx" ON "human_review_queue_items" USING btree ("state","priority","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "risk_events_ai_turn_unique" ON "risk_events" USING btree ("ai_turn_id") WHERE "risk_events"."ai_turn_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "risk_events_incognito_request_unique" ON "risk_events" USING btree ("user_id","client_request_id") WHERE "risk_events"."is_incognito" = true AND "risk_events"."user_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "risk_events_user_created_idx" ON "risk_events" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "risk_events_retention_until_idx" ON "risk_events" USING btree ("retention_until");
