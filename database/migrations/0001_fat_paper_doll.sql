CREATE TYPE "public"."message_role" AS ENUM('user', 'assistant');--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"is_saved" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "conversations_saved_expiry_check" CHECK (("conversations"."is_saved" = true AND "conversations"."expires_at" IS NULL) OR ("conversations"."is_saved" = false AND "conversations"."expires_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "daily_usage_quotas" (
	"user_id" uuid NOT NULL,
	"usage_date" date NOT NULL,
	"daily_limit" integer NOT NULL,
	"used_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_usage_quotas_user_date_pk" PRIMARY KEY("user_id","usage_date"),
	CONSTRAINT "daily_usage_quotas_limit_check" CHECK ("daily_usage_quotas"."daily_limit" > 0),
	CONSTRAINT "daily_usage_quotas_used_count_check" CHECK ("daily_usage_quotas"."used_count" >= 0 AND "daily_usage_quotas"."used_count" <= "daily_usage_quotas"."daily_limit")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"role" "message_role" NOT NULL,
	"sequence_number" integer NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "messages_sequence_positive_check" CHECK ("messages"."sequence_number" > 0)
);
--> statement-breakpoint
CREATE TABLE "quota_consumptions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"usage_date" date NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_usage_quotas" ADD CONSTRAINT "daily_usage_quotas_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quota_consumptions" ADD CONSTRAINT "quota_consumptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversations_user_created_id_idx" ON "conversations" USING btree ("user_id","created_at","id");--> statement-breakpoint
CREATE INDEX "conversations_expires_at_idx" ON "conversations" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_conversation_sequence_unique" ON "messages" USING btree ("conversation_id","sequence_number");--> statement-breakpoint
CREATE UNIQUE INDEX "quota_consumptions_user_date_key_unique" ON "quota_consumptions" USING btree ("user_id","usage_date","idempotency_key");--> statement-breakpoint
CREATE INDEX "quota_consumptions_user_date_idx" ON "quota_consumptions" USING btree ("user_id","usage_date");