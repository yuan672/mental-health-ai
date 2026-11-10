ALTER TABLE "mood_entries" ALTER COLUMN "mood_score" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "mood_entries" ADD COLUMN "cat_mood" varchar(16);--> statement-breakpoint
ALTER TABLE "mood_entries" ADD CONSTRAINT "mood_entries_selection_check" CHECK ("mood_entries"."mood_score" IS NOT NULL OR "mood_entries"."cat_mood" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "mood_entries" ADD CONSTRAINT "mood_entries_cat_check" CHECK ("mood_entries"."cat_mood" IS NULL OR "mood_entries"."cat_mood" IN ('happy', 'sad', 'angry', 'surprised', 'shy', 'sleepy', 'hopeful', 'relaxed'));