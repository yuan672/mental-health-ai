# Phase 5E — Knowledge Base Design Review

- Status: Accepted design; Phase 5E-1 implementation authorized
- Baseline: `develop` at `ff84227061aed2c8f081d913767343af3b4d7ed5`
- Architecture: Accepted ADR-018
- Implementation status: Phase 5E-1 backend is merged; Phase 5E-2 Web reader is
  implemented in Draft PR #23 and awaits review
- Source reconnaissance date: 2026-09-11

This document defines the accepted Phase 5E boundary. Phase 5E-1 now has an
independent implementation under Draft PR review; this document itself does not
publish curated content, implement the Phase 5E-2 Web experience, Phase 6 Knowledge
Management, or any AI retrieval feature.

## 1. Existing capabilities and constraints

Phase 5E can reuse:

- opaque-session authentication and protected React routes;
- the authenticated App Shell, responsive navigation, unified API client, and
  centralized session-expiry cleanup;
- private/no-store API responses, Zod response parsing, the AppError envelope, and
  versioned opaque cursors;
- PostgreSQL, Drizzle, forward-only migrations, and protected test databases;
- plain-text React rendering, accessible dialogs/status messages, RTL tests, API
  integration tests, and Chromium P0 coverage.

There is no Knowledge module, article table, source table, read API, Web route,
content publishing workflow, embedding pipeline, or retrieval integration today.
`LLMProvider.embed()` remains an unsupported capability and is not needed for the
independent reading foundation. The HANDOFF's wider `LLM + Knowledge` direction is
retained and is assigned to a later independent Phase 5E batch with separate design
and implementation authorization.

`docs/HANDOFF.md` section 17 is the controlling content boundary: V1 may use only
public, authoritative, traceable material; every article must preserve its source;
and `source_verified` must not be presented as professional or clinical review.

## 2. Recommended V1 product scope

| Decision               | Recommendation                                                                                                               | Alternative considered                        | Reason and impact                                                                                                                                       |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Audience               | Authenticated users in `/app/knowledge`                                                                                      | Public/SEO pages                              | Matches the current age-verified account product and avoids adding a second public delivery/cache policy. Public access can be reconsidered separately. |
| List                   | Paginated published articles, newest publication first                                                                       | Categories and featured collections           | A small curated launch corpus does not justify taxonomy management.                                                                                     |
| Detail                 | Title, summary, structured body, article version, verification date, and source citations                                    | Historical-version browser                    | Users need the version they read, not a Phase 6 editorial history UI.                                                                                   |
| Search                 | Do not build in first release                                                                                                | Database title/full-text search               | A small corpus is scannable; search quality, no-result language, indexing, and ranking are unproven requirements.                                       |
| Categories             | Do not build in first release                                                                                                | Fixed topic enum                              | No accepted taxonomy exists. Adding categories now would create content and navigation policy before demand is known.                                   |
| Personalization        | None                                                                                                                         | Recommendations based on Mood/chat/history    | Avoids creating reading profiles or inferring psychological interests.                                                                                  |
| AI integration         | Keep the overall direction; start with an independent reader and confirm a separate integration batch before implementing it | Bundle retrieval into the first foundation PR | Retrieval changes provider, safety, Consent, indexing, and evaluation scope. Deferring that code from the first PR is not a permanent exclusion.        |
| Content administration | Version-controlled release manifest plus a restricted internal command                                                       | Phase 6 admin UI or SQL/manual row edits      | Gives a reviewable V1 release path without building admin authentication or a CMS.                                                                      |

Search or categories should be reconsidered only after a real curated corpus makes
linear browsing measurably inadequate. An indicative article count is not made a
product constant; the decision should use observed content volume and usability.

## 3. User experience

### Routes and navigation

- Add an authenticated App Shell navigation item, “知识中心”.
- `/app/knowledge` shows the article list.
- `/app/knowledge/:articleKey` resolves the currently published version for one
  stable, server-owned article key.
- No knowledge route is added to the unauthenticated landing page in V1.

An article key is a non-sensitive, lowercase ASCII identifier suitable for a URL.
Database UUIDs, draft IDs, reviewer IDs, and unpublished version identities are not
exposed in routes.

### Article list

Each card shows only:

- title;
- short plain-text summary;
- article version;
- publication and source-verification dates;
- source publisher names; and
- a visible “测试内容” label in Development/Test when a synthetic fixture is
  intentionally served.

The first page loads automatically. “加载更多” uses an opaque server cursor. No
infinite scroll is required. An empty list says that no reviewed material is
currently available; it does not imply a network problem or that the user has no
support options.

### Article detail

The detail page renders ordered headings, paragraphs, lists, and callouts from the
server's bounded content-block union. It shows:

- article version and publication date;
- `source_verified` with a plain-language definition;
- the date that the exact article version was source-checked;
- every source's publisher, title, URL, publication/version details when known,
  retrieval date, and optional page/section locator; and
- a standing statement that educational content is not a diagnosis, individual
  treatment plan, emergency monitoring service, or substitute for qualified care.

The user-facing label should be “来源已核对”, not “专家审核” or “临床验证”. The
definition explains that the cited sources and the article's faithful use of them
were checked at a stated time. It does not claim that a psychologist or clinician
reviewed the content.

### Loading, errors, and withdrawal

| State                                      | User-visible behavior                                                              |
| ------------------------------------------ | ---------------------------------------------------------------------------------- |
| Initial loading                            | Semantic heading plus `aria-busy`; no empty-state flash.                           |
| Empty list                                 | Neutral message and retry control.                                                 |
| List/detail failure                        | Keep navigation available, show a bounded error and an explicit retry.             |
| Missing, unpublished, or withdrawn article | One neutral “内容当前不可用” state; do not reveal draft or review state.           |
| Session expiry                             | Use the existing centralized invalidation path and clear Knowledge response state. |
| Route switch during load                   | Abort or ignore the stale response by request-generation identity.                 |

A withdrawal makes the version unavailable to subsequent reads immediately after
its transaction commits. Content already delivered to an open browser cannot be
recalled; it remains memory-only until navigation, refresh, logout, or session
invalidation. V1 adds no WebSocket/push channel for editorial withdrawal.

### Mobile and keyboard baseline

- Use the existing responsive App Shell; list and detail are single-column at
  narrow widths and bounded in the desktop content area.
- Cards and links have visible focus, adequate touch targets, semantic headings,
  and no hover-only action.
- “加载更多” and retry are real buttons; source links state that they open an
  external site.
- Long titles, URLs, source labels, and body text wrap without horizontal overflow.
- Status changes use a restrained live region; the full article body is not an
  `aria-live` region and focus is not stolen after loading.

## 4. Access and dependency boundaries

Knowledge reading requires a valid session but is independent of:

- Production AI availability;
- AI quota;
- AI-admission Consent status;
- Conversation, Incognito, Mood, Profile, Risk Event, and Human Review state; and
- LLM provider or classifier health.

Therefore an authenticated user may read Knowledge content while AI Chat is
disabled, quota is exhausted, or an AI-related required Consent is absent or
withdrawn. Phase 5E makes only authenticated GET requests, so it adds no new CSRF-
protected user mutation.

The read path records no article-reading history, dwell time, inferred interest,
Mood linkage, chat linkage, personalization profile, or recommendation signal.

## 5. Source and review semantics

### Exact meaning of `source_verified`

For one immutable article version, `source_verified` means that an accountable
human verifier, at `reviewedAt`:

1. confirmed the publisher and exact cited source identity;
2. recorded the source title, canonical HTTPS URL, retrieval date, and available
   publication/version locator;
3. checked that each material article statement is supported by a cited source and
   is not presented outside the source's scope;
4. checked any translation or adaptation against the cited source;
5. checked that jurisdiction and publication age are disclosed where they limit
   applicability; and
6. recorded an approved reuse basis before copying or adapting protected material.

It does **not** mean professional medical review, clinical validation, diagnostic
accuracy, legal approval, publisher endorsement, crisis-resource verification, or
that an external page will remain unchanged or available. A source URL merely
opening does not satisfy this status.

`reviewedBy` and `reviewedAt` are null when this verification has not happened.
They must identify a real approved review event; fixtures, Codex, and release
automation must not invent a person or timestamp. The public read response exposes
the status and date but not an internal reviewer principal.

`professional_reviewed` is a reserved future status from the HANDOFF. Phase 5E has
no real professional review team or workflow and must not assign or display it.

### Candidate official sources checked on 2026-09-11

These are candidates for a later human-authored content release, not approved
Knowledge articles:

| Candidate                                                                                                                           | Verified identity and possible scope                                                                                               | Limits before publication                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [国家卫生健康委“精神卫生宣传教育核心信息和知识要点”](https://www.nhc.gov.cn/wjw/xlws/200707/97d9ae0571a444179e46cfa2c5262c79.shtml) | Official NHC page; possible source for general public mental-health literacy and help-seeking principles.                          | Published in 2007 and contains dated terminology/classification references. Every proposed claim needs a currency check against newer official material.           |
| [国家卫生健康委健康科普辟谣平台](https://www.nhc.gov.cn/kppypt/index.shtml)                                                         | Official discovery index with a “心理健康和精神卫生” area.                                                                         | An index and an official domain are not article-level verification. Each selected item needs its own identity, date, scope, and reuse review.                      |
| [WHO 中文“精神卫生”事实清单](https://www.who.int/zh/news-room/fact-sheets/detail/mental-health-strengthening-our-response)          | WHO Chinese fact sheet, shown as updated 2025-10-08; possible source for broad mental-health concepts and non-diagnostic framing.  | Global material is not automatically China-specific service guidance. Translation/adaptation and reuse terms still require review.                                 |
| [WHO 中文“压力”问答](https://www.who.int/zh/news-room/questions-and-answers/item/stress)                                            | WHO Chinese Q&A, shown as updated 2026-03-30; possible source for basic stress education and non-individualized self-care context. | Must not be transformed into individualized treatment claims or crisis advice; reuse terms and article wording require review.                                     |
| [WHO “Doing What Matters in Times of Stress” publication](https://www.who.int/publications/b/53604)                                 | Official WHO publication page identifies the 2020 guide, citation, and CC BY-NC-SA 3.0 IGO terms.                                  | Commercial use requires permission under the page's stated terms. Link-only use, quotation, translation, or adaptation must be reviewed separately before release. |

No page above is imported, copied, or published by this design. Live-source checks
must not run in CI; tests use local synthetic source fixtures.

## 6. Content lifecycle and command semantics

The workflow has two independent axes:

- publication status: `draft | published | withdrawn`;
- review status: `unverified | source_verified | professional_reviewed`.

The V1 transitions are:

1. **Draft:** create a new version from a version-controlled release manifest.
   Drafts are not user-visible and may be edited.
2. **Source verification:** bind all sources and a real verifier/date to the exact
   title, summary, and body. After this transition, body and sources are immutable.
3. **Publish:** in one transaction, require curated origin and
   `source_verified`, withdraw the currently published version if any, and publish
   the reviewed version.
4. **Update:** create the next version as a new draft. Never overwrite the body,
   source evidence, version, or review identity of a verified/published version.
5. **Withdraw:** make a published version unavailable and record `withdrawnAt`.
   Withdrawal does not delete or rewrite the record.

Only one version of a logical article may be published at once. Publication uses a
database transaction, an article-row lock, and a partial unique constraint. A
failed transaction leaves the previous publication state intact.

Both controlled mutation commands name the exact `articleKey` and positive integer
`version`; neither accepts “latest” as a target.

### Publish

The publish command validates and canonicalizes the full manifest before opening a
transaction. The immutable comparison fields are the article key/version, title,
summary, ordered content blocks, ordered source evidence, content origin,
`reviewStatus`, `reviewedBy`, and `reviewedAt`. Comparison is against those bounded
fields directly; the service does not persist a content hash or generic operation
receipt.

Inside the transaction the service locks the logical article, then applies these
rules:

1. Version 1 is the first publishable version. A new later version must be exactly
   one greater than the highest version already recorded for that article; gaps and
   publishing out of order are rejected.
2. An absent valid target is inserted with its sources and published atomically. An
   exact source-verified draft may be published only when it is the next version and
   no higher version exists.
3. If the exact target is already the current published version and every immutable
   field matches, the command is a no-op. It returns the existing state without
   rewriting `publishedAt`, `reviewedAt`, body, or sources.
4. If an existing target differs in any immutable content, source, origin, or review
   field, the command rejects it as a version-identity conflict. First-write success
   is not permission to mutate that version.
5. A withdrawn/superseded target is retired and cannot be republished. A target
   older than the highest/current version is stale and cannot replace a newer
   version.
6. Publishing the next version withdraws the current version and publishes the new
   version in the same transaction. Any insert, source, status, or commit failure
   rolls back the entire replacement.

Concurrent commands serialize on the article row. Two identical commands for the
same next version converge to one publication plus one no-op. Conflicting manifests
for the same version produce one possible winner and one identity conflict. Two
different future versions do not race to arbitrary final state: only the immediate
next version may advance. For example, version 3 submitted before version 2 is
committed is rejected; it may be explicitly invoked again after version 2 succeeds.

### Withdraw

The withdrawal command locks the article and targets only the supplied version:

- a currently published target becomes withdrawn and receives its first
  `withdrawnAt`;
- an already withdrawn/superseded target is an idempotent no-op that preserves the
  original `withdrawnAt`;
- a draft cannot be withdrawn through the publication command surface; and
- a missing article/version returns a definite not-found result.

The command never resolves “current version” on behalf of the caller. Therefore a
retry for old version 1 after version 2 is published observes version 1 as already
withdrawn and cannot affect version 2. Concurrent publication/withdrawal follows the
same article lock: withdrawing version 1 before publishing version 2 leaves version
2 eligible; publishing version 2 first retires version 1, so the exact version-1
withdrawal becomes a no-op.

These guarantees use the existing article/version rows, immutable fields, row lock,
and constraints. Phase 5E does not add a generic operation ledger, distributed
publisher, or cross-process lock service. A command that returned a definite
validation/not-found result is complete; repeating it later is a new operator
invocation. A commit acknowledgement whose result is unknown is resolved by reading
the exact article/version state and re-running the exact same manifest/target.

Published and withdrawn content versions have no automatic retention policy in
this phase because their traceable editorial history is needed. This is not a
promise of permanent retention or a legal conclusion. A future approved content-
lifecycle policy may delete a dependency-closed article/version/source set; normal
update and withdrawal do not.

## 7. Synthetic content isolation

Every version has a bounded origin: `curated` or `synthetic_fixture`. Synthetic
creation is an explicit exception to the normal curated publishing path:

- A separate Development/Test fixture entry point may insert an `unverified`
  synthetic version with no `reviewedBy` or `reviewedAt`. It does not call or weaken
  the curated publisher.
- Test fixture setup additionally requires a protected `_test` database. Development
  fixtures require the explicit development-only fixture command and remain visibly
  labelled.
- The normal curated publisher always requires real source verification, a real
  reviewer identity/time, and sources; it has no environment/configuration bypass.
- Staging/Production read policies return only `curated` versions.
- Staging/Production publication rejects `synthetic_fixture` before writing.
- An environment flag cannot promote a synthetic row into curated content.
- Synthetic fixture responses preserve their actual `reviewStatus` (`unverified` in
  the first fixture path). The API/UI must not label them `source_verified` merely
  because a test inserted them.
- Synthetic fixtures have no invented reviewer or verification timestamp, cannot
  carry/display `professional_reviewed`, and do not satisfy production content
  approval.
- CI uses only local synthetic sources and performs no network publication check.

The origin remains stored with the version; changing it is not a publication
workflow. A curated article requires a new reviewed release artifact rather than
relabeling test content.

## 8. Architecture choice

### Recommended: database read model with controlled release artifacts

PostgreSQL is the runtime source of truth for visible article versions and sources.
A version-controlled, schema-validated release manifest is the review input for a
restricted internal validate/publish/withdraw command until Phase 6 supplies a
real editor/reviewer identity and management UI.

This choice is preferable because it:

- preserves immutable versions and per-version source evidence;
- supports transactional publish/withdraw without an application deployment;
- gives the future Phase 6 management layer a stable model;
- keeps public APIs read-only; and
- avoids putting editorial content into database migrations.

The release manifest is an auditable input, not a second mutable runtime source.
Once a version is published, changing its manifest is prohibited; a correction is
a new version. The command records the release-automation actor separately from the
human `reviewedBy` evidence and never claims that automation performed the review.

### Alternative: code-owned article modules

Code-owned JSON/TypeScript would be faster for a handful of pages and naturally
version-controlled, but publication and withdrawal would require deploys, runtime
status would be split across code and configuration, and Phase 6 would need a data
migration. It is acceptable for prototypes but not recommended for the committed
KnowledgeArticle lifecycle.

### Alternative: mutable single-row `KnowledgeArticle`

Rejected because updating the body or source in place would erase what a user read
under an earlier version and make `source_verified` evidence ambiguous.

## 9. Accepted data model

### `knowledge_articles`

| Column        | Type         | Rule                                                                 |
| ------------- | ------------ | -------------------------------------------------------------------- |
| `id`          | uuid         | Server-generated primary key.                                        |
| `article_key` | varchar(100) | Stable lowercase key; unique and never reused for unrelated content. |
| `created_at`  | timestamptz  | UTC, server-owned.                                                   |

This table is the stable logical article identity. It contains no user data,
content, review claim, or publication pointer.

### `knowledge_article_versions`

| Column               | Type                  | Rule                                                             |
| -------------------- | --------------------- | ---------------------------------------------------------------- |
| `id`                 | uuid                  | Server-generated primary key.                                    |
| `article_id`         | uuid                  | FK to `knowledge_articles.id`, `ON DELETE CASCADE`.              |
| `version`            | integer               | Positive, user-visible version number.                           |
| `title`              | varchar(160)          | Required plain text.                                             |
| `summary`            | varchar(320)          | Required plain text.                                             |
| `content_blocks`     | jsonb                 | Strictly validated bounded block union.                          |
| `publication_status` | enum                  | `draft`, `published`, or `withdrawn`.                            |
| `review_status`      | enum                  | `unverified`, `source_verified`, or `professional_reviewed`.     |
| `content_origin`     | enum                  | `curated` or `synthetic_fixture`.                                |
| `reviewed_by`        | varchar(128) nullable | Opaque accountable content-review identity; no ordinary-user FK. |
| `reviewed_at`        | timestamptz nullable  | Actual completion of review.                                     |
| `published_at`       | timestamptz nullable  | Set only by publish transition.                                  |
| `withdrawn_at`       | timestamptz nullable  | Set only by withdrawal/supersession.                             |
| `created_at`         | timestamptz           | UTC, server-owned.                                               |

Constraints and indexes:

- unique `(article_id, version)`;
- partial unique `(article_id)` where `publication_status = 'published'`;
- index `(publication_status, published_at desc, id desc)` for current list reads;
- status/timestamp consistency checks;
- curated publication requires a verified review identity and timestamp in the
  application transaction;
- publication requires at least one verified source; and
- verified/published content and source fields are immutable through the service
  boundary. A correction creates a new version.

The known future `professional_reviewed` value may be represented, but Phase 5E's
publisher rejects it until a real workflow and reviewer authority are approved.

### `knowledge_article_sources`

| Column                 | Type                  | Rule                                                         |
| ---------------------- | --------------------- | ------------------------------------------------------------ |
| `id`                   | uuid                  | Server-generated primary key.                                |
| `article_version_id`   | uuid                  | FK to the version, `ON DELETE CASCADE`.                      |
| `ordinal`              | integer               | Positive display order; unique per version.                  |
| `publisher_name`       | varchar(160)          | Exact source publisher.                                      |
| `source_title`         | varchar(320)          | Exact cited title.                                           |
| `source_url`           | text                  | Canonical absolute HTTPS URL validated before verification.  |
| `source_published_at`  | timestamptz nullable  | Null means the source did not provide a reliable date.       |
| `source_version_label` | varchar(120) nullable | Document/version identifier when the publisher supplies one. |
| `source_locator`       | varchar(160) nullable | Page, section, or paragraph locator; not a copied excerpt.   |
| `retrieved_at`         | timestamptz           | When the exact source identity was inspected.                |

Sources cascade only if a separately authorized lifecycle deletes their owning
version. Normal update, supersession, and withdrawal preserve them. The model does
not copy whole external pages, arbitrary reviewer notes, or source HTML.

### Structured body contract

`content_blocks` is a strict, size-bounded discriminated union:

- `{ type: "heading", level: 2 | 3, text }`;
- `{ type: "paragraph", text }`;
- `{ type: "list", style: "unordered" | "ordered", items: string[] }`; and
- `{ type: "callout", tone: "information" | "important", text }`.

There is no arbitrary HTML, script, iframe, embedded media, inline style, Markdown,
user-supplied URL, or executable component. Source links come only from validated
source records. Counts and lengths are bounded in shared/API Zod schemas and again
at the release command.

## 10. Accepted read API

All endpoints require authentication and respond with
`Cache-Control: private, no-store`.

| Method | Path                                 | Purpose                                    |
| ------ | ------------------------------------ | ------------------------------------------ |
| `GET`  | `/knowledge/articles?limit=&cursor=` | Current published article summaries.       |
| `GET`  | `/knowledge/articles/:articleKey`    | Current published version and its sources. |

List pagination defaults to 20 and is bounded to 1–50. The opaque cursor contains a
schema version, kind, `publishedAt`, and internal version ID. Ordering is
`(published_at desc, id desc)`. Pagination is not a cross-request snapshot: a
publish or withdrawal can change later pages, so users can explicitly refresh.

The list response contains:

```json
{
  "items": [
    {
      "articleKey": "understanding-everyday-stress",
      "title": "认识日常压力",
      "summary": "合成示例摘要。",
      "version": 1,
      "contentOrigin": "synthetic_fixture",
      "reviewStatus": "unverified",
      "reviewedAt": null,
      "publishedAt": "2026-09-11T08:00:00.000Z",
      "sourcePublishers": ["合成测试来源"]
    }
  ],
  "nextCursor": null
}
```

The example is explicitly synthetic and is not a production article. Staging and
Production never return that origin.

The detail response adds `contentBlocks` and ordered `sources`. It does not expose
internal IDs, `reviewedBy`, drafts, withdrawn versions, release-operator identity,
or editorial notes. Missing, unpublished, withdrawn, and non-visible synthetic
content share `404 KNOWLEDGE_ARTICLE_NOT_FOUND`. Cursor/shape errors use 400;
authentication uses 401; storage failures use the existing safe 5xx envelope.

One short read-only repeatable-read transaction loads the selected published
version and its sources consistently. No transaction remains open while the user
reads or across pagination requests.

There is no public create/update/publish/withdraw API in Phase 5E. Those mutations
belong to the restricted release command now and Phase 6 management later.

## 11. Rendering, link, and privacy security

- React renders block text as text nodes; no `dangerouslySetInnerHTML`.
- Do not add a Markdown/HTML renderer or sanitizer in V1.
- Source URLs must use `https:`. The Web never concatenates content into markup.
- External links identify the publisher, open with `rel="noopener noreferrer"`,
  and use `referrerPolicy="no-referrer"`; the UI makes the external navigation
  apparent.
- Article bodies, sources, and responses are not written to `localStorage`,
  `sessionStorage`, or IndexedDB. The route contains only the public article key.
- Logout/session invalidation aborts pending requests and clears list/detail state;
  stale results cannot repopulate another session.
- The application logger does not accept article body/source payloads or arbitrary
  release manifests. Operational logs may use fixed events, article ID/version,
  duration, and fixed failure categories.
- No reading-history table, analytics event, browser telemetry, or referrer to the
  source site is introduced.

Knowledge content is not user-generated psychological text, but minimizing copies
still reduces stale, copyrighted, and unreviewed material in caches and logs.

## 12. Version and source consistency

- A verified version binds exact body blocks and exact ordered source records.
- A source page changing does not mutate stored article evidence. A reviewer must
  create/review a new article version or withdraw the old one.
- A source becoming unreachable does not automatically prove the article false,
  but it triggers human re-evaluation before any update. An urgent withdrawal can
  hide the version without deleting evidence.
- Publication atomically swaps the current version. A user sees either the old or
  new complete version, never a body from one version with sources from another.
- Direct reads always resolve the currently published version. The response's
  version and timestamps describe the exact returned body.
- A URL check alone never advances review status.

Phase 5E does not implement automated link monitoring, source archiving, or a
professional-review expiry scheduler. These may be considered after a real content
operation exists.

## 13. AI integration boundary

The HANDOFF's wider `LLM + Knowledge` direction remains part of the product
direction. Bounded AI retrieval is assigned to a later, independent Phase 5E batch
after the read model and curated publication contract exist. That batch requires
separate design, review, and explicit implementation authorization. This preserves
the overall direction without coupling the first reversible reader delivery to
unapproved provider and evaluation work, and it does not exclude Knowledge from AI
permanently.

If that batch is approved, its narrow design must decide:

- embedding/retrieval provider and data boundary;
- whether only currently published versions are indexable;
- index invalidation on withdraw/update;
- citation fidelity and provenance in generated answers;
- Consent and third-party processing implications;
- pre/post safety gates and crisis behavior; and
- evaluation of retrieval quality and harmful omission.

It must continue through the existing AI orchestration and safety chain. Until the
batch is explicitly approved, the initial implementation must not enable `embed()`,
a vector database, RAG, direct provider endpoints, or a Knowledge-to-chat shortcut.

## 14. Minimal implementation split

### Phase 5E-1 — Content read foundation

Independent PR scope:

- shared schemas;
- the three-table Drizzle schema and forward-only migration;
- visibility/review policies, repositories, and authenticated read APIs;
- guarded manifest validation and internal publication/withdrawal command;
- synthetic fixtures plus API/migration/concurrency/security tests; and
- API/release documentation.

No curated production article is bundled. Rollback removes the module/routes while
leaving the unused forward-only schema intact; any test data exists only in guarded
test databases. A published mistake is withdrawn, not overwritten or hidden by
rewriting migration history.

### Phase 5E-2 — User Web experience

Independent PR scope:

- App Shell navigation, list/detail routes, safe block renderer, source/version
  presentation, responsive/accessibility states, and session cleanup;
- RTL/API-client tests; and
- one Chromium P0 using only synthetic local fixtures.

Rollback removes the Web route/navigation without changing persisted content or
other Phase 5 features.

### Phase 5E-3 — Curated content release

A separate content-only PR occurs only after named human source review, reuse-
rights review, and product wording approval. It contains immutable release manifests
for a deliberately small initial corpus and the recorded review evidence. Runtime
publication uses the controlled command. Rollback is an explicit withdrawal of the
affected version; it never edits old evidence or publishes a replacement silently.

This release is not Phase 6 Knowledge Management and creates no Admin UI or admin
authentication.

### Conditional Phase 5E AI integration batch

The accepted scope keeps AI retrieval inside Phase 5E as a later independent
design/implementation batch after the read foundation and content contract are
stable. Its acceptance, tests, and rollback boundary must cover indexing/version
invalidation, provider/Consent privacy, AI safety, citations, and quality
evaluation. Phase 5E-1 adds no infrastructure for that later batch.

## 15. Acceptance and test plan

### Schema, migration, and release workflow

- apply all migrations to an empty protected `_test` database;
- upgrade a non-empty current schema without altering existing identity, chat,
  Consent, Mood, safety, or Audit data;
- reject invalid article/version/source relations atomically;
- enforce one published version per article under concurrent publish attempts;
- prove failed atomic replacement leaves the old version visible;
- preserve old body/source evidence across new-version publication and withdrawal;
- reject publish without sources, exact review evidence, or allowed content origin;
- reject synthetic publication in Staging/Production policy tests; and
- prove publication commands refuse non-test destructive setup targets.

### API and lifecycle

- valid session required; invalid/expired session returns 401 and no data;
- AI disabled, quota exhausted, and AI Consent withdrawn do not block reads;
- drafts, unreviewed curated versions, withdrawn versions, and production-hidden
  synthetic versions are never listed or returned;
- list/detail version and sources come from one consistent view;
- update creates a new version; old evidence remains unchanged;
- source URL identity and HTTPS validation;
- cursor ordering, invalid cursor, changed publication set, empty list, 404, and
  storage failure; and
- no public mutation route, provider call, embedding, Risk Detection, or reading
  event is invoked.

### Safe rendering and Web behavior

- every block variant and bounded response schema;
- literal `<script>`, event-handler text, URLs, and long strings render as text and
  create no executable DOM;
- only source records become anchors; non-HTTPS source responses are rejected;
- synthetic badge in Development/Test and no synthetic response in production
  policy tests;
- loading, empty, retry, missing/withdrawn, pagination, and stale-response behavior;
- logout/session expiry and cross-account memory cleanup;
- keyboard navigation, visible focus, heading hierarchy, non-color status, and
  320/390px plus desktop layout; and
- no sensitive/user reading state in URL parameters or browser persistence.

### Browser P0

Use the existing authenticated synthetic account and protected test database:
login → Knowledge list → open synthetic article → verify version/source label →
return to list → logout. The source target is local/synthetic; CI performs no live
third-party request. Component/API tests keep detailed withdrawal/error cases.

## 16. Accepted implementation boundary

The minimum reader implementation uses these ordinary V1 recommendations without
turning them into permanent product exclusions:

- authenticated-only read access;
- no initial search or category taxonomy;
- the database article/version/source model and controlled manifest release path;
- restricted structured blocks rather than Markdown/HTML; and
- separate backend, Web, and curated-content PRs.

These choices can be revisited from usage evidence through normal reviewed changes.
They do not need separate product decisions before the synthetic Phase 5E-1/5E-2
engineering work.

The AI scope decision is now resolved: bounded LLM-plus-Knowledge integration remains
a later, independent Phase 5E batch with its own design, review, and implementation
authorization. It is not part of Phase 5E-1, is not permanently excluded, and is not
authorized by acceptance of this document.

## 17. Production publication prerequisites

These do not block synthetic engineering implementation, but they block publishing
real Knowledge content:

- select the initial article subjects and approve the exact Simplified Chinese
  body, title, summary, and disclaimer;
- identify real accountable source verifier(s) and approve the review procedure;
- verify every exact source version, jurisdiction, currency, citation locator, and
  claim mapping;
- approve copyright/licensing, quotation, translation, and adaptation use;
- decide whether any article has actually received professional review before ever
  using that label;
- approve production privacy wording and retention/backup treatment for content
  release records; and
- complete the existing production database, backup, deployment, abuse-prevention,
  and security readiness work applicable to the whole service.

The previously recorded AI, crisis-resource, provider, Consent, reviewer, SSE, and
real-model blockers remain separate. A working Knowledge reader does not satisfy
or weaken them.

## 18. Explicitly deferred scope

The minimum reading delivery does not include:

- full-text search, taxonomy, recommendations, bookmarks, reading history, ratings,
  comments, or sharing analytics;
- RAG, embeddings, vector databases, retrieval evaluation, or LLM calls unless the
  separate Phase 5E AI integration batch is explicitly approved; this is not a
  permanent exclusion from the product direction;
- Phase 6 Admin/Knowledge Management, editor authentication, reviewer RBAC,
  dashboards, bulk import UI, or approval workflow UI;
- clinician/expert claims, medical diagnosis, individualized treatment, or crisis
  resource publication without the separate Phase 4 verification process; or
- changes to Conversation, Incognito, Mood/Profile, Consent, Quota, or AI Safety
  contracts.

Project production state remains:

- Production Safety Lock: Enforced
- Production AI Chat: Disabled
- `productionSafe=false`
- Real Model Safety Evaluation: Not Evaluated
