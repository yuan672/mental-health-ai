CREATE TYPE "public"."staff_principal_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TABLE "staff_password_credentials" (
	"staff_principal_id" uuid PRIMARY KEY NOT NULL,
	"email" varchar(320) NOT NULL,
	"password_hash" varchar(512) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff_principals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"status" "staff_principal_status" DEFAULT 'active' NOT NULL,
	"authorization_revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone,
	CONSTRAINT "staff_principals_revision_positive" CHECK ("staff_principals"."authorization_revision" > 0),
	CONSTRAINT "staff_principals_status_timestamp_check" CHECK (("staff_principals"."status" = 'active' AND "staff_principals"."disabled_at" IS NULL) OR ("staff_principals"."status" = 'disabled' AND "staff_principals"."disabled_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "staff_role_grants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"staff_principal_id" uuid NOT NULL,
	"role_key" varchar(64) NOT NULL,
	"grant_source" varchar(16) NOT NULL,
	"granted_by_principal_id" uuid,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_by_principal_id" uuid,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "staff_role_grants_source_check" CHECK ("staff_role_grants"."grant_source" IN ('bootstrap', 'staff')),
	CONSTRAINT "staff_role_grants_bootstrap_check" CHECK ("staff_role_grants"."grant_source" <> 'bootstrap' OR ("staff_role_grants"."role_key" = 'access_administrator' AND "staff_role_grants"."granted_by_principal_id" IS NULL)),
	CONSTRAINT "staff_role_grants_revocation_check" CHECK (("staff_role_grants"."revoked_at" IS NULL AND "staff_role_grants"."revoked_by_principal_id" IS NULL) OR "staff_role_grants"."revoked_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "staff_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"staff_principal_id" uuid NOT NULL,
	"token_hash" char(64) NOT NULL,
	"issued_authorization_revision" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "staff_sessions_revision_positive" CHECK ("staff_sessions"."issued_authorization_revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "staff_password_credentials" ADD CONSTRAINT "staff_password_credentials_staff_principal_id_staff_principals_id_fk" FOREIGN KEY ("staff_principal_id") REFERENCES "public"."staff_principals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_role_grants" ADD CONSTRAINT "staff_role_grants_staff_principal_id_staff_principals_id_fk" FOREIGN KEY ("staff_principal_id") REFERENCES "public"."staff_principals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_role_grants" ADD CONSTRAINT "staff_role_grants_granted_by_fk" FOREIGN KEY ("granted_by_principal_id") REFERENCES "public"."staff_principals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_role_grants" ADD CONSTRAINT "staff_role_grants_revoked_by_fk" FOREIGN KEY ("revoked_by_principal_id") REFERENCES "public"."staff_principals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_sessions" ADD CONSTRAINT "staff_sessions_staff_principal_id_staff_principals_id_fk" FOREIGN KEY ("staff_principal_id") REFERENCES "public"."staff_principals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "staff_password_credentials_email_unique" ON "staff_password_credentials" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_role_grants_active_unique" ON "staff_role_grants" USING btree ("staff_principal_id","role_key") WHERE "staff_role_grants"."revoked_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "staff_role_grants_bootstrap_unique" ON "staff_role_grants" USING btree ("grant_source") WHERE "staff_role_grants"."grant_source" = 'bootstrap';--> statement-breakpoint
CREATE INDEX "staff_role_grants_principal_idx" ON "staff_role_grants" USING btree ("staff_principal_id","granted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_sessions_token_hash_unique" ON "staff_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "staff_sessions_principal_idx" ON "staff_sessions" USING btree ("staff_principal_id");--> statement-breakpoint
CREATE INDEX "staff_sessions_expires_at_idx" ON "staff_sessions" USING btree ("expires_at");
--> statement-breakpoint
CREATE FUNCTION prevent_staff_role_grant_evidence_mutation() RETURNS trigger AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.staff_principal_id IS DISTINCT FROM OLD.staff_principal_id
    OR NEW.role_key IS DISTINCT FROM OLD.role_key
    OR NEW.grant_source IS DISTINCT FROM OLD.grant_source
    OR (NEW.granted_by_principal_id IS DISTINCT FROM OLD.granted_by_principal_id
        AND NEW.granted_by_principal_id IS NOT NULL)
    OR NEW.granted_at IS DISTINCT FROM OLD.granted_at THEN
    RAISE EXCEPTION 'staff role grant evidence is immutable';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND (
    NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
    OR (NEW.revoked_by_principal_id IS DISTINCT FROM OLD.revoked_by_principal_id
        AND NEW.revoked_by_principal_id IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'staff role grant revocation evidence is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER staff_role_grants_evidence_immutable
BEFORE UPDATE ON "staff_role_grants"
FOR EACH ROW EXECUTE FUNCTION prevent_staff_role_grant_evidence_mutation();
