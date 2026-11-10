ALTER TABLE "personal_settings" ADD COLUMN "biography" varchar(200) DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "personal_settings" ADD COLUMN "avatar_id" uuid;--> statement-breakpoint
ALTER TABLE "personal_settings" ADD COLUMN "avatar_data" text;--> statement-breakpoint
ALTER TABLE "personal_settings" ADD CONSTRAINT "personal_avatar_consistent" CHECK (("personal_settings"."avatar_id" IS NULL) = ("personal_settings"."avatar_data" IS NULL));