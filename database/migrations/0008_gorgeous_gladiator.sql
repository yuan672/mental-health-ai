CREATE TABLE "assistant_message_knowledge_references" (
	"assistant_message_id" uuid NOT NULL,
	"article_version_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	CONSTRAINT "assistant_message_knowledge_references_pk" PRIMARY KEY("assistant_message_id","article_version_id"),
	CONSTRAINT "assistant_message_knowledge_references_ordinal_check" CHECK ("assistant_message_knowledge_references"."ordinal" BETWEEN 1 AND 2)
);
--> statement-breakpoint
ALTER TABLE "assistant_message_knowledge_references" ADD CONSTRAINT "assistant_message_knowledge_references_assistant_message_id_messages_id_fk" FOREIGN KEY ("assistant_message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_message_knowledge_references" ADD CONSTRAINT "assistant_message_knowledge_references_article_version_id_knowledge_article_versions_id_fk" FOREIGN KEY ("article_version_id") REFERENCES "public"."knowledge_article_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "assistant_message_knowledge_references_message_ordinal_unique" ON "assistant_message_knowledge_references" USING btree ("assistant_message_id","ordinal");--> statement-breakpoint
CREATE INDEX "assistant_message_knowledge_references_version_idx" ON "assistant_message_knowledge_references" USING btree ("article_version_id");
--> statement-breakpoint
CREATE FUNCTION enforce_assistant_message_knowledge_reference() RETURNS trigger AS $$
DECLARE
	referenced_role message_role;
BEGIN
	IF TG_OP = 'UPDATE' THEN
		RAISE EXCEPTION 'assistant message knowledge references are immutable';
	END IF;

	SELECT role INTO referenced_role
	FROM messages
	WHERE id = NEW.assistant_message_id;

	IF referenced_role IS DISTINCT FROM 'assistant'::message_role THEN
		RAISE EXCEPTION 'knowledge references require an assistant message';
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER assistant_message_knowledge_references_guard
BEFORE INSERT OR UPDATE ON assistant_message_knowledge_references
FOR EACH ROW EXECUTE FUNCTION enforce_assistant_message_knowledge_reference();
--> statement-breakpoint
CREATE FUNCTION prevent_referenced_message_role_change() RETURNS trigger AS $$
BEGIN
	IF NEW.role IS DISTINCT FROM OLD.role
		AND EXISTS (
			SELECT 1 FROM assistant_message_knowledge_references
			WHERE assistant_message_id = OLD.id
		) THEN
		RAISE EXCEPTION 'referenced assistant message role is immutable';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER referenced_message_role_guard
BEFORE UPDATE OF role ON messages
FOR EACH ROW EXECUTE FUNCTION prevent_referenced_message_role_change();
