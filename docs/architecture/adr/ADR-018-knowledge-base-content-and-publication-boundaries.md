# ADR-018: Knowledge Base Content and Publication Boundaries

- Status: Accepted
- Date: 2026-09-11
- Accepted: 2026-09-11
- Related: ADR-001, ADR-003, ADR-004, ADR-007, ADR-008, ADR-013,
  ADR-014, ADR-015
- Supersedes: None

## Context

Phase 5E introduces a user-facing mental-health Knowledge Base. HANDOFF section 17
permits public, authoritative, traceable source material and requires every article
to retain its sources. V1 has no professional medical review team, so
`source_verified` cannot be represented as expert or clinical approval.

The product currently has an authenticated React App Shell, PostgreSQL/Drizzle,
opaque cursor APIs, and strong AI/Consent/privacy boundaries. It has no Knowledge
schema, publication workflow, content UI, retrieval system, or admin identity.
Phase 6, not Phase 5E, owns Knowledge Management and Admin Authentication.

An article may be updated or withdrawn after users have read it. Overwriting a
single row would erase which body and sources were reviewed. Treating an official
URL as sufficient review would also confuse publisher identity, claim
verification, reuse rights, and professional review.

## Decision

### Bounded user experience

V1 provides authenticated read-only article list and detail routes. The list is
opaque-cursor paginated; detail shows the exact article version, source-verification
date, and ordered source citations. The initial release has no search, category
taxonomy, personalization, bookmarks, comments, ratings, or reading history.

Knowledge reading remains available when AI Chat is disabled, quota is exhausted,
or AI-admission Consent is not current. It requires only a valid session. The
independent read path does not invoke an LLM, classifier, embedding provider, Risk
Detection, or user-content analysis.

### Runtime and editorial sources of truth

PostgreSQL is the runtime source of truth. Use a stable logical article row,
immutable content-version rows after source verification, and ordered source rows.
A version-controlled, schema-validated release manifest feeds a restricted internal
validation/publication command until Phase 6 builds a real management workflow.
Public APIs expose no mutation.

The release artifact is review input and history, not a parallel mutable runtime
store. Published manifests are immutable; a correction creates a new version.
Editorial data does not belong in database migration SQL.

### Review semantics

`source_verified` is an article-version-specific assertion that a real accountable
human checked the exact publisher/source identity, available source version and
locator, material claim support, scope, translation/adaptation, currency, and reuse
basis at the recorded time.

It does not mean professional medical review, clinical validation, legal approval,
publisher endorsement, crisis-resource verification, or perpetual source
availability. A reachable URL alone is insufficient. `reviewedBy` and `reviewedAt`
must describe a real review and remain null otherwise.

`professional_reviewed` is reserved for a future real workflow. Phase 5E cannot set
or display it as achieved.

### Lifecycle and versioning

Publication status is `draft | published | withdrawn`; review status is
`unverified | source_verified | professional_reviewed`.

- Draft content may be edited and is not visible.
- Source verification binds the exact body and ordered source records. They become
  immutable.
- Publication requires curated origin, source verification, a real reviewer/time,
  and at least one source.
- Only one version per logical article may be published. Publication atomically
  withdraws the previous version and publishes the new version under a database
  row lock and partial unique constraint.
- Updating means creating and reviewing the next positive integer version.
- Withdrawal hides the version from new reads without deleting or rewriting its
  evidence.

Controlled publish and withdraw commands always name the exact article key and
version. New versions are sequential: version 1 starts an article and only the
immediate next version may advance it. Commands serialize on the logical article
row, so a later version cannot win before its predecessor merely because of request
scheduling.

Repeating an exact manifest for the same currently published version is a no-op and
preserves body, sources, `reviewedAt`, and `publishedAt`. Reusing a version with
different content, sources, origin, or review evidence is an identity conflict. A
withdrawn/superseded version is retired and cannot be republished. Withdrawal also
targets one exact version; retrying a version-1 withdrawal after version 2 is
published cannot affect version 2, and repeated withdrawal preserves the first
`withdrawnAt`.

Next-version replacement withdraws the current version and publishes the target in
one transaction. Identical concurrent publish commands converge to one state;
conflicting same-version manifests produce an identity conflict; and out-of-order
versions are rejected. These rules use row state, locks, and constraints rather
than a generic operation ledger or distributed publication system.

No automatic content-version retention is selected in Phase 5E. This is not a
promise of permanent retention; a future approved content-lifecycle policy may
remove dependency-closed records. Normal update/withdrawal preserves them.

### Data model

Add:

- `knowledge_articles`: stable UUID, unique lowercase `article_key`, creation time;
- `knowledge_article_versions`: owning article, positive version, plain-text title
  and summary, structured JSON content blocks, publication/review statuses,
  curated/synthetic origin, reviewer/time, publication/withdrawal times; and
- `knowledge_article_sources`: owning version, display order, publisher, source
  title, canonical HTTPS URL, optional publisher-supplied version/date/locator, and
  retrieval time.

Use unique `(article_id, version)`, a partial unique constraint for one published
version per article, and a current-list index on publication status/time. Sources
cascade only with a separately authorized deletion of their version. Normal
lifecycle operations do not hard-delete content.

`content_blocks` is a strict, bounded union of headings, paragraphs, ordered or
unordered string lists, and informational/important callouts. It contains no HTML,
Markdown, script, iframe, media embed, arbitrary link, or executable component.
Only separately validated source records become links.

### Synthetic isolation

Every version is `curated` or `synthetic_fixture`. A separate guarded
Development/Test fixture path may create visibly labelled, `unverified` synthetic
content without `reviewedBy`/`reviewedAt`; it does not pass through or weaken the
curated publisher. Test setup requires a protected `_test` database. The normal
curated path always requires real source verification and has no bypass.
Staging/Production list, detail, and publication policies reject synthetic content;
a configuration switch cannot promote it. Synthetic responses preserve their real
review status and cannot establish source/professional review or production content
approval.

### Read and browser privacy

Expose authenticated GET-only list/detail APIs with `private, no-store` responses.
Missing, draft, withdrawn, and environment-hidden content share one 404 boundary.
Each detail read obtains the version and sources from one short consistent database
view.

React renders content as text nodes without `dangerouslySetInnerHTML`, a Markdown
engine, or HTML sanitizer. External source links use HTTPS, no opener/referrer, and
an explicit external-navigation label. Content and reading state are not persisted
to browser storage. Logout/session expiry aborts reads and clears state. The system
does not create reading histories, analytics profiles, or Mood/chat correlations.

### AI integration boundary

The HANDOFF's LLM-plus-Knowledge direction is retained. This decision establishes
the independent content/read foundation. Bounded AI retrieval is assigned to a
later, independent Phase 5E batch that requires its own design, review, and explicit
implementation authorization. It is not part of Phase 5E-1 and is not permanently
excluded.

Any approved RAG or retrieval batch must be separately reviewed for indexing and
withdrawal consistency, citations, provider/Consent boundaries, safety gates, and
quality evaluation. It may not bypass the existing AI orchestration or Production
Safety Lock. The minimum reader adds no speculative retrieval infrastructure.

## Consequences

### Benefits

- Users can see the exact version and sources behind each article.
- Updates and withdrawals do not rewrite reviewed history.
- Structured blocks make the first renderer small and safe by construction.
- The read feature works independently of unavailable AI.
- A controlled release path supports V1 without prematurely building Phase 6.
- Synthetic fixtures cannot silently become production content.

### Costs and limitations

- Three small tables and a transactional publication service are more work than
  hard-coded pages.
- Real content still requires source, wording, reuse-rights, and human review before
  publication.
- Authentication prevents public indexing/SEO in V1.
- There is no search, taxonomy, professional review workflow, live withdrawal push,
  automatic link monitoring, or Admin UI in the minimum reader. AI retrieval timing
  remains the explicit scope decision above.
- Content already delivered to an open browser cannot be recalled after withdrawal.

## Alternatives considered

### Code-owned pages as the runtime source

Simpler for a prototype, but every update/withdrawal needs a deploy, the future
management system needs a data migration, and runtime status is awkward. Rejected
for the proposed long-lived version/evidence model.

### Mutable single-row articles

Rejected because editing body/source fields in place destroys version-specific
review evidence.

### Markdown or sanitized HTML

Rejected for V1. Both add parsing and sanitization policy while the accepted article
shapes fit a small structured block union.

### Search, taxonomy, and recommendations at launch

Deferred until a real corpus and user need justify the extra content governance,
ranking, state, and tests. Personalized recommendations are specifically excluded
because they would introduce reading profiles and psychological inference.

### RAG in the first Knowledge foundation PR

Deferred from the first PR because it expands provider, privacy, safety, indexing,
evaluation, and deletion boundaries and is not required for independent educational
reading. This does not reject the HANDOFF's overall LLM-plus-Knowledge direction;
the later delivery boundary still requires explicit confirmation.

## Accepted scope

This ADR accepts the bounded article/version/source architecture, authenticated
read-only API, controlled exact-version command semantics, safe structured content,
and guarded synthetic engineering fixtures. It authorizes Phase 5E-1 implementation
but not its merge.

It does not authorize the later AI retrieval batch, Web experience, an article body,
source citation, copyright/reuse basis, reviewer identity, professional-review
claim, production content release, Production AI enablement, or real-model
evaluation.
