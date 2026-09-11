CREATE TABLE "mood_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"client_request_id" uuid NOT NULL,
	"mood_score" integer NOT NULL,
	"emotion" varchar(32),
	"note" varchar(500),
	"state_revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "mood_entries_score_check" CHECK ("mood_entries"."mood_score" BETWEEN 1 AND 5),
	CONSTRAINT "mood_entries_emotion_check" CHECK ("mood_entries"."emotion" IS NULL OR "mood_entries"."emotion" IN ('joyful', 'calm', 'hopeful', 'neutral', 'tired', 'stressed', 'sad', 'angry', 'overwhelmed')),
	CONSTRAINT "mood_entries_note_length_check" CHECK ("mood_entries"."note" IS NULL OR char_length("mood_entries"."note") <= 500),
	CONSTRAINT "mood_entries_revision_check" CHECK ("mood_entries"."state_revision" > 0),
	CONSTRAINT "mood_entries_timestamps_check" CHECK ("mood_entries"."updated_at" >= "mood_entries"."created_at")
);
--> statement-breakpoint
ALTER TABLE "mood_entries" ADD CONSTRAINT "mood_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mood_entries_user_client_request_unique" ON "mood_entries" USING btree ("user_id","client_request_id");--> statement-breakpoint
CREATE INDEX "mood_entries_user_created_id_idx" ON "mood_entries" USING btree ("user_id","created_at","id");