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

- An article has at most one **active editable draft**, defined exactly as
  `publicationStatus=draft && reviewStatus=unverified`; it is always at the highest
  allocated version.
- A next version cannot be created while that highest version remains an active
  editable draft; the editor can atomically replace its full candidate instead.
- Once the highest draft is `source_verified`, a next unverified version may be
  created. The immutable reviewed-but-unpublished version remains historical
  evidence rather than being deleted or edited.
- Publication advances in version order. A source-verified version is eligible
  only when every lower version has already been published/withdrawn or explicitly
  retired. A higher unverified or verified draft does not make the next eligible
  predecessor disappear, but it cannot publish before that predecessor is
  resolved.
- Publishing a newer eligible version withdraws the current older published
  version atomically. A withdrawn version never becomes active again.
- A publisher can retire an exact unpublished
  `curated + draft + source_verified` candidate without publishing it. The row
  becomes `withdrawn`, receives a server-owned `withdrawnAt`, retains its immutable
  candidate/review evidence, and keeps `publishedAt=null`. An unverified draft
  cannot be retired; it remains editable and must be corrected through the atomic
  full-candidate replacement. This is the safe path when a frozen candidate is
  found to be wrong: retire it, prepare/review the already allocated next version
  (or create the next version), then publish that successor. The system never
  requires publishing known-bad content merely to advance the sequence.

This permits editorial work to continue after a candidate is frozen, while making
the accepted predecessor-before-successor rule deterministic without adding a
fourth lifecycle state. The implementation migration must relax only the existing
withdrawn timestamp combination for a curated source-verified version that was
never published: it has `withdrawnAt` and `publishedAt=null`. A previously
published withdrawn version retains both timestamps in their existing order. The
existing curated-review constraint remains in force, so an unverified curated
draft still cannot transition to withdrawn. Existing evidence is not rewritten.

## 5. Workflow transitions

| Current state                       | Command                     | Required condition                                                      | Result                                                             |
| ----------------------------------- | --------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------ |
| no exact version                    | create version `N`          | `N = highest + 1`; no highest unverified draft                          | `draft/unverified/curated`, current candidate revision             |
| exact existing version              | create same exact candidate | normalized candidate matches                                            | `no_change`; return current state without reversing later state    |
| unverified draft                    | replace candidate           | exact current `expectedDraftRevision`; target is highest editable draft | atomically replace full candidate and advance revision             |
| unverified draft                    | source verify               | exact current revision; complete valid curated candidate                | `draft/source_verified`; server sets reviewer and time             |
| any frozen source-verified version  | source verify again         | exact candidate revision is unchanged                                   | `no_change`; preserve original reviewer/time                       |
| next eligible source-verified draft | publish                     | all lower versions are resolved; exact revision                         | `published`; lower current version becomes `withdrawn`             |
| exact currently published version   | publish again               | no later publication has replaced it                                    | `no_change`; preserve original publish/review evidence             |
| curated source-verified draft       | retire                      | exact current revision                                                  | `withdrawn`; `publishedAt=null`; set server time once              |
| unverified draft                    | retire                      | none                                                                    | conflict; remains editable and unchanged                           |
| published version                   | withdraw                    | exact version and current revision                                      | `withdrawn`; preserve `publishedAt`; set server time once          |
| already withdrawn version           | withdraw again              | exact target and revision still match                                   | `no_change`; preserve original withdrawal time and current version |

All other transitions return a typed conflict. A create retry with changed body or
sources, an edit against a stale revision, review after editing, publication of a
stale or out-of-sequence candidate, publication of synthetic content, and
reactivation of a withdrawn version are rejected. Retirement of an unverified or
synthetic draft is also rejected.

`professional_reviewed` remains unsupported by this batch. Staff source review can
produce only `source_verified`, whose meaning remains the narrow ADR-018 source
check and not professional, clinical, legal, or product approval.

## 6. HTTP and application-service boundary

The exact request and response shapes are specified in
`docs/api/admin-knowledge-management.md`. The minimum routes are:

| Method | Path                                                                        | Purpose                                     |
| ------ | --------------------------------------------------------------------------- | ------------------------------------------- |
| `GET`  | `/admin/knowledge/articles?limit=&cursor=`                                  | bounded workflow directory                  |
| `GET`  | `/admin/knowledge/articles/:articleKey/versions/:version/status`            | authoritative exact-version state           |
| `POST` | `/admin/knowledge/articles/:articleKey/versions/:version`                   | create the exact next draft candidate       |
| `GET`  | `/admin/knowledge/articles/:articleKey/versions/:version/draft`             | exact editable draft                        |
| `PUT`  | `/admin/knowledge/articles/:articleKey/versions/:version/draft`             | atomically replace an editable candidate    |
| `GET`  | `/admin/knowledge/articles/:articleKey/versions/:version/review-candidate`  | exact reviewer candidate                    |
| `POST` | `/admin/knowledge/articles/:articleKey/versions/:version/source-review`     | verify exact revision                       |
| `GET`  | `/admin/knowledge/articles/:articleKey/versions/:version/publication-state` | publisher projection                        |
| `POST` | `/admin/knowledge/articles/:articleKey/versions/:version/publish`           | publish exact frozen version                |
| `POST` | `/admin/knowledge/articles/:articleKey/versions/:version/withdraw`          | withdraw published or retire verified draft |

`articleKey` and `version` are always explicit. There is no “publish latest” or
“withdraw current” mutation, because those phrases can target a different version
after a concurrent transition.

Mutation bodies do not accept `contentOrigin`, `reviewStatus`, `reviewedBy`,
`reviewedAt`, `publishedAt`, or `withdrawnAt`. The Admin HTTP path always creates
`curated` candidates, and the service derives actors and timestamps from the
authenticated Staff context and server clock.

## 7. Transaction contracts

Controller guards perform an early Staff Session check, and every Admin route,
including GET, first requires an exact trusted `ADMIN_WEB_ORIGINS` Origin. That is
not the authoritative data authorization. Every protected application service
opens its own short database transaction and calls the database-backed Staff
authorizer **inside that transaction** before reading or mutating the protected
resource. Controllers do not call repositories directly.

### 7.1 Directory and sensitive candidate reads

```text
validate request
controller performs preliminary Staff Session + trusted Admin Origin checks
BEGIN short repeatable-read transaction
  authorize current Staff principal/session/revision and exact permission(s)
  read bounded projection
  append allowlisted read Audit
COMMIT
return only after Audit commits
```

If Audit fails, no candidate/body/source response is returned.

### 7.2 Create or replace draft

```text
validate exact path and full bounded candidate
controller performs preliminary Staff Session + Origin + Staff CSRF checks
BEGIN
  authorizeWithinTransaction knowledge:draft_write
  lock article identity (create then lock for first version)
  load versions and exact target
  create: compare an existing exact target first; otherwise enforce next-version rules
  replace: enforce editable state and expected revision before payload comparison
  derive no_change only under the command-specific ordering above
  otherwise insert or atomically replace body plus complete ordered sources
  read resulting opaque revision and authoritative state
  append allowlisted staff Audit
COMMIT
return current state
```

### 7.3 Verify sources

```text
controller performs preliminary Staff Session + Origin + Staff CSRF checks
BEGIN
  authorizeWithinTransaction knowledge:source_review
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
controller performs preliminary Staff Session + Origin + Staff CSRF checks
BEGIN
  authorizeWithinTransaction knowledge:publish
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

The authorization check, protected data operation, and Audit are one short
transaction. If revocation/disablement commits before the transaction's
authoritative authorization read, the request is rejected. If the request has
already completed that authoritative check and a concurrent revocation commits
afterward, the bounded in-flight transaction may finish under the existing
ADR-020 boundary. No database lock is held for a browser interaction, and this
design adds no cross-instance cancellation or whole-request authorization lock.

The directory/status disjunction uses one bounded
`authorizeAnyWithinTransaction()` check over the three existing Knowledge
permissions. It loads current Staff state once inside the transaction; it does not
try three out-of-transaction guards or create a new broad read permission.

## 8. Retry, conflict, and unknown results

This batch intentionally adds no permanent operation ledger, candidate snapshot,
content fingerprint, or generic workflow engine.

- An exact create retry first checks whether the exact version already exists. If
  its normalized full candidate matches, it returns current state as `no_change`
  without reversing later review/publication. A mismatch conflicts.
- Candidate replacement uses strict optimistic concurrency: require an editable
  unverified draft and exact current `expectedDraftRevision` before comparing the
  normalized replacement. Same content at that current revision is `no_change`;
  any stale revision is 409 even if the current content happens to be identical.
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

For example, if `PUT` at revision 5 commits and produces revision 7 but its response
is lost, retrying the original revision-5 request returns 409. The caller reads the
exact draft/status and presents current state; it does not receive a fabricated
receipt for the first request. A deliberate no-op at current revision 7 can return
`no_change`. If another editor has produced different revision-7 content, the old
payload is never applied. If review or publication has frozen the candidate, the
old `PUT` also conflicts even when its payload matches.

The other commands have narrow state-specific retry exceptions:

- create checks exact candidate identity before normal new-version eligibility;
- source review returns `no_change` only when the stored frozen revision matches
  `expectedDraftRevision`, preserving the first reviewer/time;
- publish returns `no_change` only while that exact target is currently published
  at the requested revision; an already withdrawn target conflicts; and
- withdraw/retire returns `no_change` for the exact already-withdrawn target and
  matching revision, preserving the first withdrawal time. A new transition from
  draft is allowed only for a curated source-verified candidate.

These responses report authoritative current state, not immutable operation
receipts.

## 9. CLI and HTTP publication compatibility

The accepted ADR-018 version sequence is authoritative: later versions cannot win
before an unresolved predecessor. Current `publishExisting()` additionally rejects
an exact target whenever **any** higher version exists. Admin drafts make that
blanket check too strict because a higher draft must not prevent resolving the
predecessor. Batch 3 therefore requires a narrow CLI implementation change: replace
the blanket-higher-version conflict with the same predecessor-resolution rule used
by HTTP. This aligns the CLI with ADR-018; it does not change manifest trust,
withdrawn non-reactivation, exact evidence matching, or one-current-version rules.

| Stored state                                 | Exact target         | HTTP result                                                                                       | CLI result after shared-policy refactor                                         |
| -------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| v1 verified draft; v2 unverified draft       | publish v1           | allowed; v1 is the unresolved predecessor                                                         | allowed only for an exact v1 manifest including matching stored review evidence |
| same                                         | publish v2           | 409; unverified and out of sequence                                                               | rejected by curated manifest/exact-state rules                                  |
| v1 and v2 verified drafts; nothing published | publish v1           | allowed; v1 must resolve first                                                                    | same exact-manifest result                                                      |
| same                                         | publish v2           | 409 until v1 is published or explicitly retired                                                   | same sequence conflict                                                          |
| v1 published; v2 verified; v3 unverified     | publish v2           | atomically withdraw v1 and publish v2                                                             | same; v3 does not block resolving v2                                            |
| same                                         | retry publish v1     | `no_change` only while v1 remains current                                                         | existing CLI behavior also returns current v1 before checking higher rows       |
| a higher version is now published            | retry old publish    | conflict; old target is withdrawn and cannot reactivate                                           | same                                                                            |
| a higher version is now published            | retry old withdraw   | `no_change` on exact old target; newer current untouched                                          | same                                                                            |
| CLI and HTTP race on one article             | either exact command | article lock orders them; the second observes the first and applies the same state/identity rules | same shared lock and policy                                                     |
| curated source-verified draft is known wrong | retire exact draft   | allowed with `knowledge:publish`, exact revision, and transactional Audit                         | existing CLI withdraw continues to reject every draft                           |

Version allocation remains gap-free (`highest + 1`). First publication/replacement
eligibility is based on resolved predecessors. Completed-operation retries are
checked only under the narrow state exceptions above. The CLI still accepts review
identity/time only from its restricted, schema-validated manifest trust boundary;
HTTP never accepts those fields.

CLI and HTTP therefore share publication ordering, article locks, immutable
evidence, and published-version withdrawal rules, but not every entry point. The
existing CLI `withdraw` command continues to reject all drafts. Unpublished frozen
candidate retirement is an authenticated, transactionally audited Staff HTTP
operation only; this does not fabricate a CLI Staff/system actor or silently widen
the CLI trust boundary.

The current CLI has no Staff Session and emits only a fixed success/failure command
result; it does not append a Staff Audit row or authenticate a release operator.
Batch 3 does not silently fabricate a Staff actor for it. Mandatory database Audit
for future CLI invocations would require a separately approved system/release actor
identity and credential boundary. That production-operational choice does not
weaken the Admin HTTP rule: every HTTP read/change/no-change remains transactionally
audited before its result is returned.

If a frozen source-verified predecessor is wrong, `knowledge:publish` retires that
exact draft without publication. Its body, sources, reviewer evidence, and version
remain immutable. The correct successor can then pass review and advance normally.
An unverified error is corrected in place through the editor's full-candidate
replacement and never needs false verification merely to be retired. This uses the
existing `withdrawn` lifecycle meaning and needs the narrow timestamp-constraint
adjustment described in section 4.2, but it does not supersede ADR-018.

## 10. Audit contract

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

## 11. Synthetic and environment boundary

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

## 12. Public reader and Knowledge AI compatibility

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

## 13. Minimum migration and repository plan

The implementation batch should:

1. add `draft_revision` in the actual next forward-only migration;
2. backfill existing rows to `1` without touching evidence or timestamps;
3. allow only a curated source-verified unpublished version to have `withdrawnAt`
   with `publishedAt=null`, while preserving the existing curated review
   constraint and timestamp ordering for previously published versions;
4. add the positive check and revise candidate/source triggers to advance the
   opaque token before freeze while preserving all existing freeze protections;
5. leave Migrations 0000 through the current migration unchanged;
6. add shared within-transaction authorization, article/version locks, predecessor
   eligibility, draft retirement, and candidate replacement;
7. keep the CLI and HTTP facades separate while sharing those primitives; and
8. extend application Audit allowlists with exact metadata schemas.

Migration tests must cover empty database application, non-empty upgrade with
published/withdrawn/unverified/synthetic fixtures, evidence preservation, invalid
legacy state atomic rejection, trigger behavior, and no half-applied migration.
Only protected `_test` databases may be used.

## 14. Acceptance matrix

### Authorization and disclosure

- ordinary user or forged Staff ID cannot access any route;
- each Knowledge role can perform only its matrix operations;
- combined roles still exercise endpoint-specific checks;
- revoked/disabled/stale Staff Sessions fail before data return;
- revocation committed before transaction authorization rejects, while a request
  authorized first follows the bounded in-flight completion rule;
- every Admin GET rejects a missing/untrusted Admin Origin, while GET does not
  require a CSRF header;
- every mutation requires the actual `x-staff-csrf-token` boundary;
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
- a lost revision-5 update response followed by the same old request gets 409 and
  recovers through an exact read; current-revision same content gets `no_change`;
- reviewer opens revision A, editor commits B, late review of A returns 409;
- review locks first, then a competing edit cannot alter verified evidence;
- Audit failure rolls back create, edit, and review; and
- no source can be moved, appended, edited, or deleted after verification.

### Publication ordering and retry

- exact next verified candidate publishes once and exact retry preserves
  evidence/time;
- unverified, synthetic, stale-revision, out-of-sequence, or withdrawn targets
  fail;
- two verified candidates resolve in predecessor order, not merely by the
  one-published unique index;
- unverified retirement conflicts without changing data;
- a wrong source-verified frozen predecessor can be retired with
  `publishedAt=null`, and its correct successor can then advance;
- retiring an unrelated candidate does not change the current published version;
- draft retirement competing with review/publish/edit serializes on the existing
  article/version locks;
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

## 15. Implementation split and rollback boundary

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

## 16. Decisions required before implementation

No product decision blocks the minimum implementation. The following engineering
choices are fixed by this proposal and should be accepted or rejected together:

1. `draft_revision` is an opaque monotonic integer covering the entire candidate;
2. only the highest unverified draft is editable, while reviewed unpublished
   candidates may coexist with a higher unverified draft;
3. publication advances in predecessor order; a wrong curated source-verified
   draft can be retired without publication, an unverified draft remains editable,
   and a higher draft does not block resolving its eligible predecessor; and
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
