# Phase 6 Admin Knowledge Management Backend Design

- Status: Proposed for Batch 3 implementation review
- Date: 2026-09-12
- Scope: staff-only Knowledge editorial, source-review, publication, withdrawal,
  authorization, and Audit contracts; no management UI
- Related: HANDOFF sections 17 and 45, ADR-007, ADR-018, ADR-019, and ADR-020

## 1. Outcome and scope

This design turns the Knowledge roles accepted in ADR-020 into a small HTTP and
application-service contract. It does not change the public Knowledge reader, the
Knowledge-grounded AI contract, or the restricted offline publication command.

The batch provides:

- a bounded staff directory of article/version workflow state;
- exact-version draft creation and atomic candidate replacement;
- exact-revision source verification with server-owned evidence;
- exact-version publish and withdraw operations;
- least-privilege authorization and transaction-bound Audit; and
- read-after-unknown-result recovery without a general operation ledger.

It does not provide a management page, search, category taxonomy, bulk import,
workflow comments, assignments, notifications, professional-review workflow,
content analytics, or a universal administrator.

## 2. Existing boundaries reused unchanged

- Staff identity, `mh_staff_session`, Staff CSRF, current authorization revision,
  finite roles, and session invalidation are already implemented by Admin Batch 1.
- Metadata-only Risk Event and Human Review Queue APIs are already implemented by
  Admin Batch 2 and remain independent from Knowledge permissions.
- `knowledge_articles`, `knowledge_article_versions`, and
  `knowledge_article_sources` already preserve exact versions, ordered sources,
  source freeze, one currently published version, and withdrawn-version
  non-reactivation.
- The restricted CLI manifest workflow already serializes on the article row and
  validates exact manifests. It remains an operational path, not a staff HTTP
  credential substitute.
- Public `GET /knowledge/articles` and detail reads remain session-only and expose
  only environment-visible published content.
- ADR-019 exact-version citations, v2 delivery/history, withdrawal behavior, and
  stored citation evidence remain unchanged. Editing or withdrawing Knowledge must
  never rewrite an Assistant Message reference.

All Admin routes remain under the separate Staff Session, Admin Origin/CORS, Staff
CSRF, `private, no-store`, Zod, and safe AppError boundaries. An ordinary user
session cannot authorize them.

## 3. Role and data-access matrix

No new role or wildcard permission is needed. Directory metadata is available to
a staff principal possessing at least one of the three existing Knowledge
permissions; exact content reads remain role-specific.

| Capability                                  | Required permission                                                            | Readable fields                                                                                                                 | Explicitly excluded                                                     |
| ------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Bounded directory and exact workflow status | any of `knowledge:draft_write`, `knowledge:source_review`, `knowledge:publish` | article/version IDs, key, version, opaque draft revision, origin, review/publication states and lifecycle timestamps            | article body, full sources, reviewer email, Audit history               |
| Create/replace editable candidate           | `knowledge:draft_write`                                                        | exact editable title, summary, content blocks, and complete ordered sources                                                     | review assertion, reviewer identity/time, publish/withdraw transition   |
| Read and verify review candidate            | `knowledge:source_review`                                                      | exact candidate body, ordered sources, origin, and draft revision                                                               | editing, publication, professional-review claim                         |
| Read publication state and publish/withdraw | `knowledge:publish`                                                            | exact version status, opaque draft revision, review evidence identity/time, published/withdrawn time, bounded source identities | candidate editing, creation of review evidence, psychological/user data |

Role combination is allowed only through explicit existing grants. Combining roles
does not bypass endpoint-specific checks or allow one transaction to manufacture
both edited content and its review evidence.

## 4. Candidate identity and revision

### 4.1 Minimal schema refinement

A future forward-only migration adds this field to
`knowledge_article_versions`:

```text
draft_revision integer not null default 1 check (draft_revision > 0)
```

Existing rows are backfilled with `1` without changing their body, sources,
states, review evidence, or timestamps. The value is an opaque positive monotonic
candidate token, not a count of human edits and not a content hash.

For an unverified draft, the token covers one candidate consisting of:

- title;
- summary;
- every content block in order; and
- every complete source record in ordinal order.

Any real change to one of those fields advances the token. A no-op does not.
Content fields and the complete source set are replaced in one short transaction
after locking the article and version; clients cannot perform field-by-field or
source-row CRUD.

The database trigger boundary is extended so every supported writer observes the
same monotonic token:

- a change to draft title, summary, or blocks advances the version token;
- an insert, material update, or delete of a source belonging to an unverified
  draft advances its parent token;
- a source move remains forbidden;
- candidate and source mutations remain forbidden once the version is verified,
  published, or withdrawn; and
- a client or repository cannot set an arbitrary revision value.

A full source replacement may advance the opaque token more than once. Callers
compare equality only and must not infer an edit count. All increments roll back if
the surrounding transaction fails.

### 4.2 Draft coexistence and version order

Version numbers are positive, sequential, and gap-free per article.

- An article has at most one **editable** unverified draft, always at the highest
  allocated version.
- A next version cannot be created while that highest version remains unverified;
  the editor can atomically replace that draft instead.
- Once the highest draft is `source_verified`, a next unverified version may be
  created. The immutable reviewed-but-unpublished version remains historical
  evidence rather than being deleted or edited.
- A publish target must be the highest `source_verified` candidate, must be newer
  than the current published version, and must still match its expected revision.
  A higher unverified draft does not block publishing the latest verified
  candidate. Once a higher candidate is verified, an older unpublished candidate
  is no longer publication-eligible.
- Publishing a newer eligible version withdraws the current older published
  version atomically. A withdrawn version never becomes active again.

This permits editorial work to continue after a candidate is frozen, while making
the publication order deterministic without adding a fourth lifecycle state.

## 5. Workflow transitions

| Current state                     | Command                     | Required condition                                                      | Result                                                             |
| --------------------------------- | --------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------ |
| no exact version                  | create version `N`          | `N = highest + 1`; no highest unverified draft                          | `draft/unverified/curated`, current candidate revision             |
| exact unverified draft            | create same exact candidate | normalized candidate matches                                            | `no_change`; return current state                                  |
| unverified draft                  | replace candidate           | exact current `expectedDraftRevision`; target is highest editable draft | atomically replace full candidate and advance revision             |
| unverified draft                  | source verify               | exact current revision; complete valid curated candidate                | `draft/source_verified`; server sets reviewer and time             |
| source-verified draft             | source verify again         | exact candidate revision is unchanged                                   | `no_change`; preserve original reviewer/time                       |
| eligible source-verified draft    | publish                     | target is latest verified candidate and newer than current              | `published`; lower current version becomes `withdrawn`             |
| exact currently published version | publish again               | no later publication has replaced it                                    | `no_change`; preserve original publish/review evidence             |
| published version                 | withdraw                    | exact version is current published target                               | `withdrawn`; set server time once                                  |
| already withdrawn version         | withdraw again              | exact target still exists                                               | `no_change`; preserve original withdrawal time and current version |

All other transitions return a typed conflict. A create retry with changed body or
sources, an edit against a stale revision, review after editing, publication of a
stale/older candidate, publication of synthetic content, and reactivation of a
withdrawn version are rejected.

`professional_reviewed` remains unsupported by this batch. Staff source review can
produce only `source_verified`, whose meaning remains the narrow ADR-018 source
check and not professional, clinical, legal, or product approval.

## 6. HTTP and application-service boundary

The exact request and response shapes are specified in
`docs/api/admin-knowledge-management.md`. The minimum routes are:

| Method | Path                                                                        | Purpose                                  |
| ------ | --------------------------------------------------------------------------- | ---------------------------------------- |
| `GET`  | `/admin/knowledge/articles?limit=&cursor=`                                  | bounded workflow directory               |
| `GET`  | `/admin/knowledge/articles/:articleKey/versions/:version/status`            | authoritative exact-version state        |
| `POST` | `/admin/knowledge/articles/:articleKey/versions/:version`                   | create the exact next draft candidate    |
| `PUT`  | `/admin/knowledge/articles/:articleKey/versions/:version/draft`             | atomically replace an editable candidate |
| `GET`  | `/admin/knowledge/articles/:articleKey/versions/:version/review-candidate`  | exact reviewer candidate                 |
| `POST` | `/admin/knowledge/articles/:articleKey/versions/:version/source-review`     | verify exact revision                    |
| `GET`  | `/admin/knowledge/articles/:articleKey/versions/:version/publication-state` | publisher projection                     |
| `POST` | `/admin/knowledge/articles/:articleKey/versions/:version/publish`           | publish exact frozen version             |
| `POST` | `/admin/knowledge/articles/:articleKey/versions/:version/withdraw`          | withdraw exact published version         |

`articleKey` and `version` are always explicit. There is no “publish latest” or
“withdraw current” mutation, because those phrases can target a different version
after a concurrent transition.

Mutation bodies do not accept `contentOrigin`, `reviewStatus`, `reviewedBy`,
`reviewedAt`, `publishedAt`, or `withdrawnAt`. The Admin HTTP path always creates
`curated` candidates, and the service derives actors and timestamps from the
authenticated Staff context and server clock.

## 7. Transaction contracts

Authorization is rechecked at the application-service boundary and inside the
same request before database work. Controllers do not call repositories directly.

### 7.1 Directory and sensitive candidate reads

```text
validate request
authenticate current Staff Session and current authorization revision
authorize exact Knowledge permission(s)
BEGIN short repeatable-read transaction
  read bounded projection
  append allowlisted read Audit
COMMIT
return only after Audit commits
```

If Audit fails, no candidate/body/source response is returned.

### 7.2 Create or replace draft

```text
validate exact path and full bounded candidate
authenticate + authorize knowledge:draft_write
BEGIN
  lock article identity (create then lock for first version)
  load versions and exact target
  enforce origin, next-version, editable-draft, and expected-revision rules
  if exact normalized state already exists: derive no_change
  else insert or atomically replace body plus complete ordered sources
  read resulting opaque revision and authoritative state
  append allowlisted staff Audit
COMMIT
return current state
```

### 7.3 Verify sources

```text
authenticate + authorize knowledge:source_review
BEGIN
  lock article then exact version
  require curated + draft + unverified + exact expected revision
  load body and ordered sources in the same transaction
  validate the complete candidate
  set source_verified, reviewedBy=Staff principal ID, reviewedAt=server clock
  freeze candidate/source evidence
  append Audit
COMMIT
```

If the exact version is already verified at that same revision, return
`no_change` with the original evidence and append a bounded no-change Audit. It
does not assert that the retrying principal performed the original review.

### 7.4 Publish or withdraw

```text
authenticate + authorize knowledge:publish
BEGIN
  lock article then exact version
  hydrate exact review/source state and enforce sequence/currentness
  apply exact publish or withdrawal transition, or derive no_change
  append Audit in this same transaction
COMMIT
return current state
```

The HTTP service must not call the current `publishCurated()` wrapper from inside
another transaction. Implementation extracts shared within-transaction locking and
state-policy operations. The CLI facade keeps its accepted manifest trust model
and owns one transaction; the HTTP facade owns one transaction and supplies
server-derived staff evidence plus Audit. Both serialize on the same article row
and obey the same freeze/order triggers.

The two trust paths do not blend evidence. If the CLI targets an existing HTTP
unverified draft with a `source_verified` manifest, its changed review evidence is
not treated as an exact manifest replay and the command conflicts. The operator
must finish that candidate through the reviewed Admin workflow, or use a valid
later version after resolving the open candidate. Conversely, Admin HTTP cannot
edit, re-review, or relabel a version already created and verified by the CLI.

There is no state where publication commits but the required HTTP Audit rolls back,
or Audit commits while publication rolls back.

## 8. Retry, conflict, and unknown results

This batch intentionally adds no permanent operation ledger, candidate snapshot,
content fingerprint, or generic workflow engine.

- Exact same create or replacement against a still matching current candidate can
  return `no_change`, even if that exact candidate has since been reviewed or
  published; changed input never overwrites first/current state silently.
- A no-change response is current state, not an immutable receipt proving which
  request originally created it.
- Review, publish, and withdraw retries preserve the original reviewer, review
  time, publish time, or withdrawal time.
- A stale candidate revision or a different exact candidate returns 409 and the
  caller must fetch authoritative exact state before a new deliberate action.
- A database-confirmed rollback returns the corresponding safe error; the service
  does not claim an applied transition.
- If the server cannot determine whether commit acknowledgement was lost, it
  returns `ADMIN_KNOWLEDGE_RESULT_UNKNOWN` (503). The caller performs the exact
  status/candidate/publication read and does not automatically invent a new
  version or different command.
- “Not found” in a later read means no row is visible in that read. It does not
  prove that an earlier in-flight transaction rolled back or can never commit.
- Without an operation ledger, a later edit can make an earlier update
  indistinguishable from a request whose result was subsequently changed. The
  authoritative current state and Audit trail are the bounded guarantee.

No automatic retry follows a 409. Reads may be retried with normal bounded network
policy; mutations are retried only as the same exact target and payload after a
human chooses to resolve an uncertain result.

## 9. Audit contract

Audit action/resource codes stay application/Zod allowlists rather than PostgreSQL
enums. Implementation adds only:

- actions: `knowledge_directory_accessed`, `knowledge_version_status_viewed`,
  `knowledge_draft_viewed`, `knowledge_review_candidate_viewed`,
  `knowledge_publication_state_viewed`, `knowledge_draft_created`,
  `knowledge_draft_updated`, `knowledge_source_verified`,
  `knowledge_version_published`, and `knowledge_version_withdrawn`;
- resources: `knowledge_article_query`, `knowledge_article`, and
  `knowledge_article_version`.

Mutation metadata is strictly one of:

```ts
type KnowledgeMutationAuditMetadata = Readonly<{
  disposition: 'applied' | 'no_change';
  version: number;
  resultingDraftRevision: number;
}>;
```

Publish/withdraw metadata may additionally contain the bounded resulting
publication state. Directory/read metadata contains only a fixed filter category
and returned count, or exact version and access category. `resourceId` is the
database article/version ID; directory reads use a fixed non-user query resource.

Audit never contains title, summary, blocks, source records/URLs, reviewer email,
request body, arbitrary DTO, arbitrary Error, credentials, user psychological
content, retrieval query, prompt, or Provider payload. The normal operational log
records only fixed event/failure categories, staff request correlation, and safe
resource IDs where already allowed.

Applied mutation Audit idempotency keys are derived from non-content state:

- create: version database ID;
- candidate update: version ID plus resulting draft revision;
- source review: version ID plus reviewed draft revision;
- publish: version ID; and
- withdraw: version ID.

Because a withdrawn version cannot reactivate, publish and withdraw each have at
most one applied lifecycle action. Read and `no_change` attempts use a fresh random
request-scoped Audit key so the access/retry itself is recorded. No Audit key
contains article text, source text/URL, a content hash, or a request-body hash.

## 10. Synthetic and environment boundary

The Admin HTTP workflow cannot create, edit, verify, publish, or promote
`synthetic_fixture` content. Development/Test synthetic records continue to use
the separate guarded fixture service and `_test` database protection. A Staff role
does not convert synthetic content into curated evidence.

Staging/Production Admin reads do not expose synthetic body, document identity, or
source URLs. An exact synthetic target receives the same controlled unavailable
response regardless of its stored state. Existing public and AI historical
environment-isolation rules remain in force even when augmentation is disabled.

The three candidate articles are still unverified, unpublished files outside the
runtime database. This batch neither approves nor imports them.

## 11. Public reader and Knowledge AI compatibility

- Public list/detail response schemas and visibility rules do not change.
- Draft/review Admin reads never use the public presenter and cannot become public
  through a shared cache.
- Publication swaps only the public current version; exact older stored references
  continue to resolve their frozen evidence under ADR-019.
- Withdrawal hides current public reading and future retrieval but does not delete
  versions, sources, Assistant Messages, or references.
- No Admin mutation triggers model generation, retrieval, embedding, vector work,
  or user notification.
- `AI_KNOWLEDGE_ENABLED` remains `false` by default, and Production AI remains
  disabled.

## 12. Minimum migration and repository plan

The implementation batch should:

1. add `draft_revision` in the actual next forward-only migration;
2. backfill existing rows to `1` without touching evidence or timestamps;
3. add the positive check and revise candidate/source triggers to advance the
   opaque token before freeze while preserving all existing freeze protections;
4. leave Migrations 0000 through the current migration unchanged;
5. add shared within-transaction article/version locks and candidate replacement;
6. keep the CLI and HTTP facades separate while sharing those primitives; and
7. extend application Audit allowlists with exact metadata schemas.

Migration tests must cover empty database application, non-empty upgrade with
published/withdrawn/unverified/synthetic fixtures, evidence preservation, invalid
legacy state atomic rejection, trigger behavior, and no half-applied migration.
Only protected `_test` databases may be used.

## 13. Acceptance matrix

### Authorization and disclosure

- ordinary user or forged Staff ID cannot access any route;
- each Knowledge role can perform only its matrix operations;
- combined roles still exercise endpoint-specific checks;
- revoked/disabled/stale Staff Sessions fail before data return;
- candidate read is withheld when Audit fails;
- logs and Audit contain no body, source URL, email, or arbitrary errors; and
- synthetic content is rejected by Admin HTTP in every environment and not exposed
  by Staging/Production reads.

### Candidate and revision concurrency

- create version 1 and exact next version; reject gaps and concurrent competing
  next versions deterministically;
- identical concurrent create leaves one row and returns current state;
- different concurrent candidates for one version never merge or overwrite;
- full replacement changes body and ordered sources atomically;
- title/body/source-only changes all advance the opaque revision;
- reviewer opens revision A, editor commits B, late review of A returns 409;
- review locks first, then a competing edit cannot alter verified evidence;
- Audit failure rolls back create, edit, and review; and
- no source can be moved, appended, edited, or deleted after verification.

### Publication ordering and retry

- exact verified candidate publishes once and exact retry preserves evidence/time;
- unverified, synthetic, stale-revision, older-reviewed, or withdrawn targets fail;
- two concurrently verified candidates resolve by the defined highest-reviewed
  ordering, not merely the one-published unique index;
- publishing a newer version atomically withdraws the old current version;
- retrying an old publish cannot reactivate or replace the new version;
- retrying an old withdrawal cannot affect a newer current version;
- withdraw retry preserves the first timestamp; and
- mutation plus Audit commits or rolls back together.

### CLI coexistence and compatibility

- CLI and Admin HTTP operations use a controlled barrier to prove article-row
  serialization in both execution orders;
- CLI exact retry and old-version protections remain valid;
- HTTP reviewer/time are always server-derived even though the restricted CLI
  keeps its reviewed-manifest trust boundary;
- public list/detail and Knowledge AI exact citations remain unchanged through
  publish/withdraw; and
- no AI, Conversation, Consent, Incognito, Mood, Quota, or Safety regression.

## 14. Implementation split and rollback boundary

### Batch 3A — schema, repositories, and services

- revision migration and triggers;
- shared locked lifecycle primitives;
- role-specific application services and Audit schemas;
- concurrency/migration/integration tests.

Rollback disables the new Admin module/routes while retaining the forward-only
schema and immutable content history.

### Batch 3B — HTTP contract and command coexistence

- controllers, shared DTOs, Staff Session/CSRF integration;
- exact status/recovery reads;
- CLI refactor onto shared transaction primitives;
- API/security/privacy regressions and documentation.

These may be delivered in one implementation PR if it never exposes a partial
HTTP mutation path that lacks Audit, exact revision checks, or CLI serialization.
There is no Admin Web batch in this task.

## 15. Decisions required before implementation

No product decision blocks the minimum implementation. The following engineering
choices are fixed by this proposal and should be accepted or rejected together:

1. `draft_revision` is an opaque monotonic integer covering the entire candidate;
2. only the highest unverified draft is editable, while a reviewed unpublished
   candidate may coexist with a higher unverified draft;
3. publication selects the highest verified candidate, while a higher unverified
   draft does not block it; and
4. the restricted CLI retains its existing reviewed-manifest trust model while
   Admin HTTP derives reviewer identity/time and both share state primitives.

Production decisions remain separate: real editor/reviewer enrollment and MFA,
content-review operating procedure, reviewer identity retention, real candidate
article approval/reuse rights, and production deployment/security readiness.

No new ADR is proposed. This document makes the already Accepted ADR-018 content
lifecycle and ADR-020 role separation implementable; it does not change either
decision. Any later proposal to weaken exact-version evidence, merge the three
roles, add professional review, or replace the CLI trust boundary would require a
separate architecture decision.

Project production state remains:

- Production Safety Lock: Enforced
- Production AI Chat: Disabled
- `productionSafe=false`
- Real Model Safety Evaluation: Not Evaluated
