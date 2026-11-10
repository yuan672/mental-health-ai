CREATE TABLE "diary_ai_grants" (
	"user_id" uuid NOT NULL,
	"notebook_id" uuid NOT NULL,
	CONSTRAINT "diary_ai_grants_user_id_notebook_id_pk" PRIMARY KEY("user_id","notebook_id")
);
--> statement-breakpoint
CREATE TABLE "diary_ai_policies" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"mode" varchar(16) DEFAULT 'none' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "diary_ai_policy_mode" CHECK ("diary_ai_policies"."mode" IN ('none', 'selected', 'all')),
	CONSTRAINT "diary_ai_policy_revision" CHECK ("diary_ai_policies"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "diary_ai_turn_references" (
	"turn_id" uuid PRIMARY KEY NOT NULL,
	"entries" jsonb NOT NULL,
	CONSTRAINT "diary_ai_references_bounds" CHECK (jsonb_typeof("diary_ai_turn_references"."entries") = 'array' AND jsonb_array_length("diary_ai_turn_references"."entries") BETWEEN 1 AND 5)
);
--> statement-breakpoint
ALTER TABLE "diary_ai_grants" ADD CONSTRAINT "diary_ai_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diary_ai_grants" ADD CONSTRAINT "diary_ai_grants_notebook_id_diary_notebooks_id_fk" FOREIGN KEY ("notebook_id") REFERENCES "public"."diary_notebooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diary_ai_policies" ADD CONSTRAINT "diary_ai_policies_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diary_ai_turn_references" ADD CONSTRAINT "diary_ai_turn_references_turn_id_ai_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."ai_turns"("id") ON DELETE cascade ON UPDATE no action;