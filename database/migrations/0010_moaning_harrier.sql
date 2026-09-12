ALTER TABLE "knowledge_article_versions" DROP CONSTRAINT "knowledge_article_versions_status_timestamps_check";--> statement-breakpoint
ALTER TABLE "knowledge_article_versions" ADD COLUMN "draft_revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_article_versions" ADD CONSTRAINT "knowledge_article_versions_draft_revision_check" CHECK ("knowledge_article_versions"."draft_revision" > 0);--> statement-breakpoint
ALTER TABLE "knowledge_article_versions" ADD CONSTRAINT "knowledge_article_versions_status_timestamps_check" CHECK (("knowledge_article_versions"."publication_status" = 'draft' AND "knowledge_article_versions"."published_at" IS NULL AND "knowledge_article_versions"."withdrawn_at" IS NULL) OR ("knowledge_article_versions"."publication_status" = 'published' AND "knowledge_article_versions"."published_at" IS NOT NULL AND "knowledge_article_versions"."withdrawn_at" IS NULL) OR ("knowledge_article_versions"."publication_status" = 'withdrawn' AND "knowledge_article_versions"."withdrawn_at" IS NOT NULL AND (("knowledge_article_versions"."published_at" IS NOT NULL AND "knowledge_article_versions"."withdrawn_at" >= "knowledge_article_versions"."published_at") OR ("knowledge_article_versions"."published_at" IS NULL AND "knowledge_article_versions"."content_origin" = 'curated' AND "knowledge_article_versions"."review_status" = 'source_verified'))));--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_knowledge_version_evidence_mutation() RETURNS trigger AS $$
DECLARE
	content_changed boolean;
	revision_only_change boolean;
BEGIN
	IF NEW.id IS DISTINCT FROM OLD.id
		OR NEW.article_id IS DISTINCT FROM OLD.article_id
		OR NEW.version IS DISTINCT FROM OLD.version
		OR NEW.content_origin IS DISTINCT FROM OLD.content_origin
		OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
		RAISE EXCEPTION 'knowledge version identity is immutable';
	END IF;

	content_changed := NEW.title IS DISTINCT FROM OLD.title
		OR NEW.summary IS DISTINCT FROM OLD.summary
		OR NEW.content_blocks IS DISTINCT FROM OLD.content_blocks;
	revision_only_change := NOT content_changed
		AND NEW.review_status IS NOT DISTINCT FROM OLD.review_status
		AND NEW.reviewed_by IS NOT DISTINCT FROM OLD.reviewed_by
		AND NEW.reviewed_at IS NOT DISTINCT FROM OLD.reviewed_at
		AND NEW.publication_status IS NOT DISTINCT FROM OLD.publication_status
		AND NEW.published_at IS NOT DISTINCT FROM OLD.published_at
		AND NEW.withdrawn_at IS NOT DISTINCT FROM OLD.withdrawn_at;

	IF NEW.draft_revision IS DISTINCT FROM OLD.draft_revision THEN
		IF pg_trigger_depth() <= 1
			OR NOT revision_only_change
			OR OLD.publication_status <> 'draft'
			OR OLD.review_status <> 'unverified'
			OR NEW.draft_revision <> OLD.draft_revision + 1 THEN
			RAISE EXCEPTION 'knowledge draft revision is server controlled';
		END IF;
	ELSIF content_changed THEN
		IF OLD.publication_status <> 'draft' OR OLD.review_status <> 'unverified' THEN
			RAISE EXCEPTION 'verified or published knowledge evidence is immutable';
		END IF;
		NEW.draft_revision := OLD.draft_revision + 1;
	END IF;

	IF OLD.review_status <> 'unverified' OR OLD.publication_status <> 'draft' THEN
		IF content_changed
			OR NEW.review_status IS DISTINCT FROM OLD.review_status
			OR NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by
			OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at
			OR (OLD.publication_status <> 'draft' AND NEW.published_at IS DISTINCT FROM OLD.published_at)
			OR (OLD.publication_status = 'withdrawn' AND NEW.withdrawn_at IS DISTINCT FROM OLD.withdrawn_at) THEN
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
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_frozen_knowledge_source_mutation() RETURNS trigger AS $$
DECLARE
	parent_status knowledge_publication_status;
	parent_review knowledge_review_status;
	parent_version_id uuid;
	material_change boolean := true;
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

	IF TG_OP = 'UPDATE' THEN
		material_change := ROW(
			NEW.ordinal,
			NEW.publisher_name,
			NEW.source_title,
			NEW.source_url,
			NEW.source_published_at,
			NEW.source_version_label,
			NEW.source_locator,
			NEW.retrieved_at
		) IS DISTINCT FROM ROW(
			OLD.ordinal,
			OLD.publisher_name,
			OLD.source_title,
			OLD.source_url,
			OLD.source_published_at,
			OLD.source_version_label,
			OLD.source_locator,
			OLD.retrieved_at
		);
	END IF;

	IF material_change THEN
		UPDATE knowledge_article_versions
		SET draft_revision = draft_revision + 1
		WHERE id = parent_version_id;
	END IF;

	IF TG_OP = 'DELETE' THEN
		RETURN OLD;
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
