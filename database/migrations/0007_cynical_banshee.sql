CREATE TYPE "public"."knowledge_content_origin" AS ENUM('curated', 'synthetic_fixture');--> statement-breakpoint
CREATE TYPE "public"."knowledge_publication_status" AS ENUM('draft', 'published', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."knowledge_review_status" AS ENUM('unverified', 'source_verified', 'professional_reviewed');--> statement-breakpoint
CREATE TABLE "knowledge_article_sources" (
	"id" uuid PRIMARY KEY NOT NULL,
	"article_version_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"publisher_name" varchar(160) NOT NULL,
	"source_title" varchar(320) NOT NULL,
	"source_url" text NOT NULL,
	"source_published_at" timestamp with time zone,
	"source_version_label" varchar(120),
	"source_locator" varchar(160),
	"retrieved_at" timestamp with time zone NOT NULL,
	CONSTRAINT "knowledge_article_sources_ordinal_check" CHECK ("knowledge_article_sources"."ordinal" > 0),
	CONSTRAINT "knowledge_article_sources_https_check" CHECK ("knowledge_article_sources"."source_url" ~ '^https://')
);
--> statement-breakpoint
CREATE TABLE "knowledge_article_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"article_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"title" varchar(160) NOT NULL,
	"summary" varchar(320) NOT NULL,
	"content_blocks" jsonb NOT NULL,
	"publication_status" "knowledge_publication_status" NOT NULL,
	"review_status" "knowledge_review_status" NOT NULL,
	"content_origin" "knowledge_content_origin" NOT NULL,
	"reviewed_by" varchar(128),
	"reviewed_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"withdrawn_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "knowledge_article_versions_version_check" CHECK ("knowledge_article_versions"."version" > 0),
	CONSTRAINT "knowledge_article_versions_content_blocks_check" CHECK (jsonb_typeof("knowledge_article_versions"."content_blocks") = 'array' AND jsonb_array_length("knowledge_article_versions"."content_blocks") BETWEEN 1 AND 100),
	CONSTRAINT "knowledge_article_versions_status_timestamps_check" CHECK (("knowledge_article_versions"."publication_status" = 'draft' AND "knowledge_article_versions"."published_at" IS NULL AND "knowledge_article_versions"."withdrawn_at" IS NULL) OR ("knowledge_article_versions"."publication_status" = 'published' AND "knowledge_article_versions"."published_at" IS NOT NULL AND "knowledge_article_versions"."withdrawn_at" IS NULL) OR ("knowledge_article_versions"."publication_status" = 'withdrawn' AND "knowledge_article_versions"."published_at" IS NOT NULL AND "knowledge_article_versions"."withdrawn_at" IS NOT NULL AND "knowledge_article_versions"."withdrawn_at" >= "knowledge_article_versions"."published_at")),
	CONSTRAINT "knowledge_article_versions_review_evidence_check" CHECK (("knowledge_article_versions"."review_status" = 'unverified' AND "knowledge_article_versions"."reviewed_by" IS NULL AND "knowledge_article_versions"."reviewed_at" IS NULL) OR ("knowledge_article_versions"."review_status" IN ('source_verified', 'professional_reviewed') AND "knowledge_article_versions"."reviewed_by" IS NOT NULL AND "knowledge_article_versions"."reviewed_at" IS NOT NULL)),
	CONSTRAINT "knowledge_article_versions_origin_review_check" CHECK (("knowledge_article_versions"."content_origin" = 'synthetic_fixture' AND "knowledge_article_versions"."review_status" = 'unverified') OR "knowledge_article_versions"."content_origin" = 'curated'),
	CONSTRAINT "knowledge_article_versions_curated_publication_check" CHECK ("knowledge_article_versions"."publication_status" = 'draft' OR "knowledge_article_versions"."content_origin" = 'synthetic_fixture' OR "knowledge_article_versions"."review_status" IN ('source_verified', 'professional_reviewed'))
);
--> statement-breakpoint
CREATE TABLE "knowledge_articles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"article_key" varchar(100) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "knowledge_articles_key_check" CHECK ("knowledge_articles"."article_key" ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);
--> statement-breakpoint
ALTER TABLE "knowledge_article_sources" ADD CONSTRAINT "knowledge_article_sources_article_version_id_knowledge_article_versions_id_fk" FOREIGN KEY ("article_version_id") REFERENCES "public"."knowledge_article_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_article_versions" ADD CONSTRAINT "knowledge_article_versions_article_id_knowledge_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."knowledge_articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_article_sources_version_ordinal_unique" ON "knowledge_article_sources" USING btree ("article_version_id","ordinal");--> statement-breakpoint
CREATE INDEX "knowledge_article_sources_version_idx" ON "knowledge_article_sources" USING btree ("article_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_article_versions_article_version_unique" ON "knowledge_article_versions" USING btree ("article_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_article_versions_current_unique" ON "knowledge_article_versions" USING btree ("article_id") WHERE "knowledge_article_versions"."publication_status" = 'published';--> statement-breakpoint
CREATE INDEX "knowledge_article_versions_current_list_idx" ON "knowledge_article_versions" USING btree ("publication_status","published_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_articles_article_key_unique" ON "knowledge_articles" USING btree ("article_key");
--> statement-breakpoint
CREATE FUNCTION prevent_knowledge_version_evidence_mutation() RETURNS trigger AS $$
BEGIN
	IF OLD.review_status <> 'unverified' OR OLD.publication_status <> 'draft' THEN
		IF NEW.article_id IS DISTINCT FROM OLD.article_id
			OR NEW.version IS DISTINCT FROM OLD.version
			OR NEW.title IS DISTINCT FROM OLD.title
			OR NEW.summary IS DISTINCT FROM OLD.summary
			OR NEW.content_blocks IS DISTINCT FROM OLD.content_blocks
			OR NEW.review_status IS DISTINCT FROM OLD.review_status
			OR NEW.content_origin IS DISTINCT FROM OLD.content_origin
			OR NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by
			OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at
			OR (OLD.publication_status <> 'draft' AND NEW.published_at IS DISTINCT FROM OLD.published_at)
			OR (OLD.publication_status = 'withdrawn' AND NEW.withdrawn_at IS DISTINCT FROM OLD.withdrawn_at)
			OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
			RAISE EXCEPTION 'verified or published knowledge evidence is immutable';
		END IF;
	END IF;

	IF OLD.publication_status = 'withdrawn' AND NEW.publication_status <> 'withdrawn' THEN
		RAISE EXCEPTION 'withdrawn knowledge versions cannot be reactivated';
	END IF;
	IF OLD.publication_status = 'published' AND NEW.publication_status NOT IN ('published', 'withdrawn') THEN
		RAISE EXCEPTION 'published knowledge versions can only be withdrawn';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER knowledge_version_evidence_immutable
BEFORE UPDATE ON "knowledge_article_versions"
FOR EACH ROW EXECUTE FUNCTION prevent_knowledge_version_evidence_mutation();
--> statement-breakpoint
CREATE FUNCTION prevent_frozen_knowledge_source_mutation() RETURNS trigger AS $$
DECLARE
	parent_status knowledge_publication_status;
	parent_review knowledge_review_status;
	parent_version_id uuid;
BEGIN
	IF TG_OP = 'UPDATE' AND NEW.article_version_id IS DISTINCT FROM OLD.article_version_id THEN
		RAISE EXCEPTION 'knowledge sources cannot be moved between versions';
	END IF;

	IF TG_OP IN ('UPDATE', 'DELETE') THEN
		parent_version_id := OLD.article_version_id;
	ELSE
		parent_version_id := NEW.article_version_id;
	END IF;
	SELECT publication_status, review_status
	INTO parent_status, parent_review
	FROM knowledge_article_versions
	WHERE id = parent_version_id
	FOR UPDATE;

	IF parent_status <> 'draft' OR parent_review <> 'unverified' THEN
		RAISE EXCEPTION 'verified or published knowledge sources are immutable';
	END IF;
	IF TG_OP = 'DELETE' THEN
		RETURN OLD;
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER knowledge_source_evidence_immutable
BEFORE INSERT OR UPDATE OR DELETE ON "knowledge_article_sources"
FOR EACH ROW EXECUTE FUNCTION prevent_frozen_knowledge_source_mutation();
--> statement-breakpoint
CREATE FUNCTION require_sources_for_published_knowledge_version() RETURNS trigger AS $$
BEGIN
	IF NEW.publication_status = 'published' AND NOT EXISTS (
		SELECT 1 FROM knowledge_article_sources WHERE article_version_id = NEW.id
	) THEN
		RAISE EXCEPTION 'published knowledge versions require at least one source';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER knowledge_published_version_requires_source
AFTER INSERT OR UPDATE ON "knowledge_article_versions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION require_sources_for_published_knowledge_version();
