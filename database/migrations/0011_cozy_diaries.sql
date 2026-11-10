CREATE TABLE "diary_notebooks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"name" varchar(24) NOT NULL,
	"cat" varchar(16) DEFAULT 'relaxed' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "diary_notebook_revision_positive" CHECK ("diary_notebooks"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "diary_pages" (
	"notebook_id" uuid NOT NULL,
	"day" date NOT NULL,
	"saved" jsonb,
	"draft" jsonb,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "diary_pages_notebook_id_day_pk" PRIMARY KEY("notebook_id","day"),
	CONSTRAINT "diary_page_revision_positive" CHECK ("diary_pages"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "diary_photos" (
	"id" uuid PRIMARY KEY NOT NULL,
	"notebook_id" uuid NOT NULL,
	"day" date NOT NULL,
	"name" varchar(180) NOT NULL,
	"mime" varchar(24) NOT NULL,
	"size" integer NOT NULL,
	"data" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "diary_photo_size_bounds" CHECK ("diary_photos"."size" > 0 AND "diary_photos"."size" <= 10485760)
);
--> statement-breakpoint
CREATE TABLE "personal_settings" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"display_name" varchar(24) DEFAULT '' NOT NULL,
	"cat" varchar(16) DEFAULT 'relaxed' NOT NULL,
	"reading_size" integer DEFAULT 18 NOT NULL,
	"bookmarks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "personal_reading_size_valid" CHECK ("personal_settings"."reading_size" IN (16, 18, 20)),
	CONSTRAINT "personal_settings_revision_positive" CHECK ("personal_settings"."revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "diary_notebooks" ADD CONSTRAINT "diary_notebooks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diary_pages" ADD CONSTRAINT "diary_pages_notebook_id_diary_notebooks_id_fk" FOREIGN KEY ("notebook_id") REFERENCES "public"."diary_notebooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diary_photos" ADD CONSTRAINT "diary_photos_notebook_id_diary_notebooks_id_fk" FOREIGN KEY ("notebook_id") REFERENCES "public"."diary_notebooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_settings" ADD CONSTRAINT "personal_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "diary_notebooks_owner_idx" ON "diary_notebooks" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "diary_photos_page_idx" ON "diary_photos" USING btree ("notebook_id","day");