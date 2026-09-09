CREATE TYPE "public"."ai_turn_status" AS ENUM('claimed', 'streaming', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "ai_turns" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"client_request_id" uuid NOT NULL,
	"status" "ai_turn_status" NOT NULL,
	"prompt_key" varchar(64) NOT NULL,
	"prompt_version" varchar(64) NOT NULL,
	"user_message_id" uuid,
	"assistant_message_id" uuid,
	"failure_code" varchar(64),
	"lease_expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "ai_turns" ADD CONSTRAINT "ai_turns_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_turns" ADD CONSTRAINT "ai_turns_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_turns" ADD CONSTRAINT "ai_turns_user_message_id_messages_id_fk" FOREIGN KEY ("user_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_turns" ADD CONSTRAINT "ai_turns_assistant_message_id_messages_id_fk" FOREIGN KEY ("assistant_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_turns_user_client_request_unique" ON "ai_turns" USING btree ("user_id","client_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_turns_user_message_unique" ON "ai_turns" USING btree ("user_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_turns_assistant_message_unique" ON "ai_turns" USING btree ("assistant_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_turns_conversation_active_unique" ON "ai_turns" USING btree ("conversation_id") WHERE "ai_turns"."status" IN ('claimed', 'streaming');--> statement-breakpoint
CREATE INDEX "ai_turns_user_status_idx" ON "ai_turns" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "ai_turns_conversation_idx" ON "ai_turns" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "ai_turns_lease_expires_at_idx" ON "ai_turns" USING btree ("lease_expires_at");