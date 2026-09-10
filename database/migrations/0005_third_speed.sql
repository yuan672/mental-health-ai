ALTER TABLE "consents" ADD COLUMN "state_revision" integer;
--> statement-breakpoint
ALTER TABLE "consents" ADD COLUMN "effective_at" timestamp with time zone;
--> statement-breakpoint
CREATE TABLE "consent_decisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"consent_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"consent_type" varchar(64) NOT NULL,
	"consent_version" varchar(64) NOT NULL,
	"operation_id" uuid NOT NULL,
	"decision" varchar(16) NOT NULL,
	"outcome" varchar(16) NOT NULL,
	"prior_revision" integer NOT NULL,
	"resulting_revision" integer NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"document_key" varchar(128),
	"document_revision" varchar(64),
	"target_acceptance_decision_id" uuid,
	"decision_source" varchar(32) NOT NULL,
	CONSTRAINT "consent_decisions_values_check" CHECK ("consent_decisions"."decision" IN ('accepted', 'withdrawn') AND "consent_decisions"."outcome" IN ('applied', 'no_change') AND "consent_decisions"."decision_source" IN ('registration', 'privacy_ui', 'legacy_backfill')),
	CONSTRAINT "consent_decisions_revision_check" CHECK ("consent_decisions"."prior_revision" >= 0 AND (("consent_decisions"."outcome" = 'applied' AND "consent_decisions"."resulting_revision" = "consent_decisions"."prior_revision" + 1) OR ("consent_decisions"."outcome" = 'no_change' AND "consent_decisions"."resulting_revision" = "consent_decisions"."prior_revision"))),
	CONSTRAINT "consent_decisions_document_pair_check" CHECK (("consent_decisions"."document_key" IS NULL) = ("consent_decisions"."document_revision" IS NULL)),
	CONSTRAINT "consent_decisions_target_check" CHECK (("consent_decisions"."decision" = 'accepted' AND "consent_decisions"."target_acceptance_decision_id" IS NULL) OR ("consent_decisions"."decision" = 'withdrawn' AND "consent_decisions"."target_acceptance_decision_id" IS NOT NULL AND "consent_decisions"."document_key" IS NULL AND "consent_decisions"."document_revision" IS NULL)),
	CONSTRAINT "consent_decisions_acceptance_evidence_check" CHECK ("consent_decisions"."decision" <> 'accepted' OR "consent_decisions"."decision_source" = 'legacy_backfill' OR ("consent_decisions"."document_key" IS NOT NULL AND "consent_decisions"."document_revision" IS NOT NULL))
);
--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM "consents"
		WHERE "accepted_at" IS NULL
		   OR ("status" = 'accepted' AND "withdrawn_at" IS NOT NULL)
		   OR ("status" = 'withdrawn' AND "withdrawn_at" IS NULL)
	) THEN
		RAISE EXCEPTION 'Cannot backfill invalid legacy consent lifecycle state';
	END IF;
END $$;
--> statement-breakpoint
INSERT INTO "consent_decisions" (
	"id", "consent_id", "user_id", "consent_type", "consent_version",
	"operation_id", "decision", "outcome", "prior_revision", "resulting_revision",
	"occurred_at", "document_key", "document_revision",
	"target_acceptance_decision_id", "decision_source"
)
SELECT
	gen_random_uuid(), "id", "user_id", "consent_type", "consent_version",
	gen_random_uuid(), 'accepted', 'applied', 0, 1,
	"accepted_at", NULL, NULL, NULL, 'legacy_backfill'
FROM "consents";
--> statement-breakpoint
INSERT INTO "consent_decisions" (
	"id", "consent_id", "user_id", "consent_type", "consent_version",
	"operation_id", "decision", "outcome", "prior_revision", "resulting_revision",
	"occurred_at", "document_key", "document_revision",
	"target_acceptance_decision_id", "decision_source"
)
SELECT
	gen_random_uuid(), c."id", c."user_id", c."consent_type", c."consent_version",
	gen_random_uuid(), 'withdrawn', 'applied', 1, 2,
	c."withdrawn_at", NULL, NULL, accepted."id", 'legacy_backfill'
FROM "consents" c
JOIN "consent_decisions" accepted
	ON accepted."consent_id" = c."id"
	AND accepted."decision" = 'accepted'
	AND accepted."outcome" = 'applied'
	AND accepted."resulting_revision" = 1
WHERE c."status" = 'withdrawn';
--> statement-breakpoint
UPDATE "consents"
SET
	"state_revision" = CASE WHEN "status" = 'accepted' THEN 1 ELSE 2 END,
	"effective_at" = CASE WHEN "status" = 'accepted' THEN "accepted_at" ELSE "withdrawn_at" END;
--> statement-breakpoint
ALTER TABLE "consents" ALTER COLUMN "state_revision" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "consents" ALTER COLUMN "effective_at" SET NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "consents_identity_unique" ON "consents" USING btree ("id","user_id","consent_type","consent_version");
--> statement-breakpoint
CREATE UNIQUE INDEX "consent_decisions_user_operation_unique" ON "consent_decisions" USING btree ("user_id","operation_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "consent_decisions_applied_revision_unique" ON "consent_decisions" USING btree ("consent_id","resulting_revision") WHERE "consent_decisions"."outcome" = 'applied';
--> statement-breakpoint
CREATE UNIQUE INDEX "consent_decisions_identity_unique" ON "consent_decisions" USING btree ("id","consent_id","user_id","consent_type","consent_version");
--> statement-breakpoint
CREATE INDEX "consent_decisions_history_idx" ON "consent_decisions" USING btree ("user_id","occurred_at","id");
--> statement-breakpoint
ALTER TABLE "consent_decisions" ADD CONSTRAINT "consent_decisions_projection_fk" FOREIGN KEY ("consent_id","user_id","consent_type","consent_version") REFERENCES "public"."consents"("id","user_id","consent_type","consent_version") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "consent_decisions" ADD CONSTRAINT "consent_decisions_target_acceptance_fk" FOREIGN KEY ("target_acceptance_decision_id","consent_id","user_id","consent_type","consent_version") REFERENCES "public"."consent_decisions"("id","consent_id","user_id","consent_type","consent_version") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_state_revision_positive_check" CHECK ("consents"."state_revision" > 0);
