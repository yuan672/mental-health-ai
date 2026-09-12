# Phase 6 Admin Audit Read and AI Turn Metadata Design

- Status: Accepted engineering design; Batch 4A implementation in review in PR
  #33 and Batch 4B implementation pending
- Date: 2026-09-12
- Accepted: 2026-09-12
- Scope: Phase 6 Batch 4 backend read contracts only
- Related: HANDOFF section 45, ADR-007, ADR-013, ADR-014, ADR-019, and
  Accepted ADR-020

## 1. Outcome and scope

This design closes the remaining minimum backend contracts for two local
learning/demo workflows:

1. an authorized Audit reader verifies that a synthetic Staff access change or
   Knowledge review/publication operation produced a bounded action record; and
2. an authorized AI quality reviewer inspects the lifecycle state, prompt identity,
   and bounded failure category of an existing Persistent AI Turn.

The second workflow is deliberately named **Persistent AI Turn execution metadata
review**. It is not answer-quality scoring, clinical review, model evaluation, or
production monitoring. The current database has enough data to make that limited
workflow useful, so the design keeps it rather than creating a new collection
system.

This batch adds no Admin UI, message-content access, export, full-text search,
generic reporting platform, model call, real-model evaluation, or Incognito
history. It does not alter the user's replacement-frontend work or the existing
Knowledge AI v2 client contract.

## 2. Verified current facts

### 2.1 Reusable backend boundaries

| Area                  | Current fact                                                                                                                                  | Consequence for this design                                                                                             |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Staff identity        | Separate Staff principals, credentials, sessions, origin allowlist, CSRF boundary, authorization revision, and fixed roles are implemented.   | Both readers require a current Staff Session. An ordinary user session or submitted principal ID provides no authority. |
| Permissions           | `audit_reader` grants only `audit:read`; `ai_quality_reviewer` grants only `ai_quality:read_metadata`. `access_administrator` grants neither. | The two readers remain independently grantable and non-inheriting.                                                      |
| Service authorization | `DatabaseStaffAuthorizer` re-reads principal, session, revision, and active roles inside a supplied transaction.                              | Controller guards are preliminary only; each reader re-authorizes in its application service transaction.               |
| Audit persistence     | `audit_logs` is append-oriented, has action-specific Zod metadata, `retention_until`, idempotency keys, and bounded purge.                    | Audit Read reuses the table and retention policy. It never returns raw JSON or the idempotency key.                     |
| Sensitive reads       | Staff, Safety, and Knowledge services already use authorize, read/project, append Audit, commit, then return.                                 | Batch 4 follows the same transaction pattern and withholds data when the access Audit fails.                            |
| AI Turn persistence   | `ai_turns` persists ordinary turn status, prompt key/version, bounded-length failure code, lease, and lifecycle timestamps.                   | A metadata-only workflow is possible without a new AI Quality table.                                                    |
| Deletion              | `ai_turns` follows User/Conversation cascade deletion; Incognito writes no `ai_turns` row.                                                    | The reader does not create an independent copy and cannot reconstruct deleted or Incognito execution history.           |
| Operational logging   | Provider/model/request ID, TTFT, token counts, finish reason, and several durations are emitted only to operational logs.                     | There is no authorized log repository. Those values are not API fields and are not backfilled or inferred.              |

### 2.2 Data-source classification

| Candidate field                   | Source                                              | Batch 4 result                                                                                         |
| --------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Turn ID                           | `ai_turns.id`                                       | Return as an opaque UUID.                                                                              |
| Status                            | `ai_turns.status`                                   | Return the bounded `claimed \| streaming \| completed \| failed \| cancelled` value.                   |
| Prompt key/version                | `ai_turns.prompt_key`, `prompt_version`             | Return through a validated availability union; never return prompt text.                               |
| Failure                           | `ai_turns.failure_code`                             | Map through a code-owned finite category map; never return the raw string.                             |
| Lifecycle start/end               | `started_at`, `completed_at`                        | Return with exact lifecycle wording. `started_at` is not Provider dispatch time.                       |
| Lifecycle duration                | `completed_at - started_at`                         | Derive only when both values exist and the result is non-negative. It is not model or network latency. |
| Lease state                       | `status`, `lease_expires_at`, response `observedAt` | Derive `valid \| expired \| not_applicable`; do not expose the raw lease timestamp.                    |
| Provider/model/request ID         | Operational log only                                | Not available through Batch 4.                                                                         |
| Token counts, TTFT, finish reason | Operational log only                                | Not available through Batch 4.                                                                         |
| Provider dispatch time or latency | Not persisted                                       | Not available and not inferred.                                                                        |
| Delivery to browser               | Not persisted as an acknowledgement                 | `completed` means backend terminal persistence, not proof that the client received completion.         |
| Knowledge query/rank/outcome      | Not persisted in `ai_turns`                         | Not returned and not reconstructed from logs or citations.                                             |
| Answer score or clinical quality  | Does not exist                                      | Explicitly outside scope.                                                                              |

## 3. Product and permission boundary

| Workflow                                | Required permission        | Returned data                                                                                         | Explicitly excluded                                                                                                   |
| --------------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Audit Read                              | `audit:read`               | A narrow Staff/Knowledge/action-access Audit projection                                               | Risk/Crisis/Mood/Conversation activity, raw metadata, idempotency key, linked content, email, credentials             |
| Persistent AI Turn metadata list/detail | `ai_quality:read_metadata` | Opaque turn ID, status, validated prompt identity, bounded failure category, lifecycle/lease metadata | User/Conversation/Message/client-request IDs, all text, Risk/Quota/citation data, Provider payload or log-only fields |

`access_administrator` receives neither permission. A principal that needs both
workflows must receive both explicit roles and must establish a new Staff Session
after the authorization revision changes.

The Audit reader is intentionally narrower than the complete writer allowlist. A
general `audit_reader` must not learn user-level crisis, Mood, or Conversation
activity timestamps and identifiers merely because those records share the same
table. Risk/Queue information continues through the separately authorized Batch 2
API.

## 4. Audit Read design

### 4.1 Readable action/resource/metadata pairs

Only the following exact pairs are visible in the first reader. The response
presenter parses the metadata with the corresponding strict schema.

| Action                               | Resource type                | Visible safe metadata                                                              |
| ------------------------------------ | ---------------------------- | ---------------------------------------------------------------------------------- |
| `staff_principal_bootstrapped`       | `staff_principal`            | `{ roleKey: "access_administrator" }`                                              |
| `staff_principal_created`            | `staff_principal`            | `{}`                                                                               |
| `staff_role_granted`                 | `staff_principal`            | `{ roleKey, resultingAuthorizationRevision }`                                      |
| `staff_role_revoked`                 | `staff_principal`            | `{ roleKey, resultingAuthorizationRevision }`                                      |
| `staff_principal_disabled`           | `staff_principal`            | `{ resultingAuthorizationRevision }`                                               |
| `staff_sessions_revoked`             | `staff_principal`            | `{ sessionCount }`                                                                 |
| `staff_directory_accessed`           | `staff_principal_query`      | `{ filterCategory: "all" \| "id", returnedCount }`                                 |
| `knowledge_directory_accessed`       | `knowledge_article_query`    | `{ filterCategory: "all", returnedCount }`                                         |
| `knowledge_version_status_viewed`    | `knowledge_article_version`  | `{ accessCategory: "status", version }`                                            |
| `knowledge_draft_viewed`             | `knowledge_article_version`  | `{ accessCategory: "draft", version }`                                             |
| `knowledge_review_candidate_viewed`  | `knowledge_article_version`  | `{ accessCategory: "review", version }`                                            |
| `knowledge_publication_state_viewed` | `knowledge_article_version`  | `{ accessCategory: "publication", version }`                                       |
| `knowledge_draft_created`            | `knowledge_article_version`  | `{ disposition, version, resultingDraftRevision }`                                 |
| `knowledge_draft_updated`            | `knowledge_article_version`  | `{ disposition, version, resultingDraftRevision }`                                 |
| `knowledge_source_verified`          | `knowledge_article_version`  | `{ disposition, version, resultingDraftRevision }`                                 |
| `knowledge_version_published`        | `knowledge_article_version`  | `{ disposition, version, resultingDraftRevision, publicationStatus: "published" }` |
| `knowledge_version_withdrawn`        | `knowledge_article_version`  | `{ disposition, version, resultingDraftRevision, publicationStatus: "withdrawn" }` |
| `audit_log_accessed`                 | `audit_log_query`            | `{ filterCategory, pageKind, returnedCount }`                                      |
| `ai_quality_metadata_accessed`       | `ai_turn_query` or `ai_turn` | `{ accessCategory, filterCategory, returnedCount }`                                |

Implementation must use the actual code-owned action name
`knowledge_source_verified`; the older conceptual
`knowledge_source_review_recorded` name is not a persisted action. The currently
declared but unwritten `knowledge_article` resource type is not exposed merely
because it exists in an application enum.

Staff `no_change` lifecycle operations currently append
`staff_directory_accessed`, not a grant/revoke/disable mutation action. Knowledge
`no_change` operations append the corresponding Knowledge mutation action with
`disposition="no_change"`. Therefore Audit rows are bounded action evidence, not a
universal immutable command receipt, and absence of a mutation action is not proof
that no request was attempted.

### 4.2 Projection

An allowlisted record returns only:

- Audit Log ID;
- bounded actor type and nullable opaque actor ID;
- the exact readable action/resource pair and opaque resource ID;
- `occurredAt` and `retentionUntil`; and
- the action-discriminated safe metadata above.

It never returns `idempotencyKey`, raw `safeMetadata`, an arbitrary JSON field,
email, current role, IP/user-agent, request DTO, Error, or dereferenced target.
Actor and resource identifiers are pseudonymous/opaque identifiers, not anonymous
data. For this reader, actor is the strict union `{ type: "system", id: null } | {
type: "staff", id: UUID }`; other stored actor shapes are not exposed. The actor's
current roles must not be used to infer their historical role.

Rows with actions outside the reader subset are not selected and cannot be named
as filters. If a row claims a readable action but has an invalid actor shape,
action/resource pair, or metadata shape, the service fails the whole page with the
controlled database error. It returns neither a partial page nor the stored raw
value and does not rewrite the historical row.

### 4.3 Filters and pagination

The initial query supports:

- one optional exact readable `action`;
- one optional exact readable `resourceType`;
- an optional pair `occurredFrom` / `occurredBefore`, both RFC 3339 timestamps with
  offsets; and
- `limit`, default 20 and bounded to 1–50.

If only one time boundary is supplied, `from >= before`, `before` is later than the
request's server `observedAt`, or an action/resource filter pair is impossible, the
request is invalid. The maximum interval is 31 days. With no explicit interval the
server uses the seven days ending at request start. These are reversible
engineering bounds for the local workflow, not retention policy.

Results use `(occurredAt DESC, id DESC)`. The opaque cursor contains a schema kind
and version, the last tuple, the normalized action/resource/time filters, and the
initial request's exclusive upper bound. A continuation may omit repeated filters;
if it supplies any, they must equal the cursor values. The existing cursor is
canonical base64url JSON, not a signed authorization token. Every continuation
therefore re-validates the decoded strict schema, readable filters, bounded time
window, exclusive ceiling, last tuple, and repeated query fields as untrusted
input. Malformed, non-canonical, schema-invalid, out-of-bounds, or mismatching
values return `400 VALIDATION_ERROR`.

The cursor prevents later normal records at or after the fixed upper bound from
appearing in that traversal. It does not create a durable cross-request snapshot:
purge or a deliberately backdated insert may shorten or change a later page.
Clients refresh from page one after an operational change.

The query also requires `retentionUntil > observedAt`, so an expired record is not
returned merely because the cleanup command has not run. Purge-first makes a row
absent. If the read snapshot is established first, a concurrent purge may complete
while the already-authorized page returns its complete old snapshot; no later read
can reconstruct the row.

### 4.4 Access Audit without recursion

One short `REPEATABLE READ / READ WRITE` transaction performs:

1. database re-authorization for `audit:read`;
2. the bounded query and strict projection;
3. one required `audit_log_accessed` append; and
4. commit before returning the page.

The access metadata contains only:

```ts
type AuditReadAccessMetadata = Readonly<{
  filterCategory: 'all' | 'action' | 'resource_type' | 'time_range' | 'combined';
  pageKind: 'initial' | 'continuation';
  returnedCount: number;
}>;
```

It does not record actual filter values. The access row uses the Staff principal
UUID as the query resource ID and a new server-generated idempotency key per HTTP
attempt. The required append must verify that it inserted a row; the current
generic `ON CONFLICT DO NOTHING` behavior alone is not sufficient evidence for a
sensitive read.

The page query executes before its access row is appended and uses the fixed
exclusive ceiling, so the new row cannot enter the current traversal. A later
reader may see that access action, but reading it creates only the one access row
for that later request. No repository callback or background task recursively
invokes Audit Read.

If Audit append or commit fails, no page is returned. A commit acknowledgement
failure does not prove the access row was rolled back; a retry is a new access and
may correctly create another access row. No permanent read-operation ledger is
introduced.

## 5. Persistent AI Turn execution metadata design

### 5.1 Exact response boundary

Each visible turn contains:

```ts
type AdminAiTurnMetadata = Readonly<{
  turnId: string;
  status: 'claimed' | 'streaming' | 'completed' | 'failed' | 'cancelled';
  promptIdentity:
    | Readonly<{ availability: 'available'; key: string; version: string }>
    | Readonly<{ availability: 'unavailable' }>;
  failureCategory:
    | 'quota_exhausted'
    | 'concurrency_conflict'
    | 'stale_recovery'
    | 'cancelled_before_dispatch'
    | 'cancelled'
    | 'timeout_before_dispatch'
    | 'timeout'
    | 'provider_rate_limited'
    | 'provider_authentication'
    | 'provider_unavailable'
    | 'provider_malformed'
    | 'preparation'
    | 'safety'
    | 'persistence'
    | 'internal'
    | 'unknown'
    | null;
  lifecycleStartedAt: string;
  terminalAt: string | null;
  lifecycleDurationMs: number | null;
  leaseState: 'valid' | 'expired' | 'not_applicable';
}>;
```

`lifecycleStartedAt` is the persisted claim/lifecycle start. It is not Provider
dispatch or first-token time. `lifecycleDurationMs` spans the whole persisted turn
lifecycle, including safety, context, Provider, and persistence work, and is never
named model latency. A completed row proves a backend terminal commit, not browser
receipt.

Prompt identity is returned only when both persisted values are 1–64 characters
and match the code-identifier patterns `[a-z0-9][a-z0-9._-]*` for the key and
`[A-Za-z0-9][A-Za-z0-9._-]*` for the version. An invalid historical value becomes
`{ availability: "unavailable" }`; the raw value is never returned. A terminal row
projects its terminal timestamp and duration only when that timestamp is valid and
not earlier than the lifecycle start; otherwise both values are null. An active row
always projects a null terminal timestamp and duration, even if malformed historical
data contains a terminal timestamp.

### 5.2 Failure mapping

The presenter owns an exhaustive map from known persisted codes to the categories
above. At minimum it maps:

- `QUOTA_EXCEEDED` to `quota_exhausted`;
- `AI_TURN_IN_PROGRESS` to `concurrency_conflict`;
- `STALE_TURN` to `stale_recovery`;
- `CANCELLED_BEFORE_PROVIDER` to `cancelled_before_dispatch`;
- `CLIENT_CANCELLED`, `EXECUTION_CANCELLED`, and
  `STREAM_DELIVERY_TERMINATED` to `cancelled`;
- `TOTAL_TIMEOUT_BEFORE_PROVIDER` to `timeout_before_dispatch`;
- `TIMEOUT` to `timeout`;
- `RATE_LIMITED` to `provider_rate_limited`;
- `AUTHENTICATION` to `provider_authentication`;
- `UPSTREAM`, `NETWORK`, `ABORTED`, and `UNCONFIGURED` to
  `provider_unavailable`;
- `MALFORMED_STREAM` and `MALFORMED_RESPONSE` to `provider_malformed`;
- `PREPARATION_FAILED` to `preparation`;
- `SAFETY` to `safety`;
- `PERSISTENCE`, `TRUSTED_SAFETY_PERSISTENCE_FAILED`, and
  `SAFETY_RESPONSE_PERSISTENCE_FAILED` to `persistence`; and
- `INTERNAL` to `internal`.

Any other non-null code maps to `unknown`. A `failed`/`cancelled` row with no code,
or an active/completed row carrying an inconsistent non-null code, also maps to
`unknown`; an otherwise consistent non-failure row returns null. The API never
returns a raw failure code and does not guess a more specific meaning from
application logs.

### 5.3 Visibility and lifecycle

Only rows in `ai_turns` are candidates, so Incognito is excluded by construction.
The repository must not join Risk, Audit, logs, or runtime maps to recreate an
Incognito history.

The list/detail query joins the parent Conversation only as a visibility condition:
the Conversation must not be soft deleted and must either be saved or not yet
expired at the transaction's `observedAt`. No Conversation or user field enters the
projection. If soft delete/expiry wins first, list omits and detail returns the
same `404 NOT_FOUND` used for a missing turn. If the authorized read snapshot wins
first, it may return its complete old metadata with a committed access Audit.
Subsequent hard purge cascades the turn and no independent copy remains.

The reader is available independently of current `AI_CHAT_ENABLED` and
`AI_KNOWLEDGE_ENABLED` values because it reads already-retained metadata. It does
not start generation, call a Provider, consume quota, or make Production AI
available.

### 5.4 List/detail and access Audit

The list supports a bounded optional status filter, the same explicit-or-default
7-day/31-day-maximum time-window rules, limit 1–50, and opaque
`(createdAt DESC, id DESC)` pagination. The cursor binds status and normalized time
window. It is a current retained-state traversal, not a long-term snapshot.

The exact detail route accepts only a UUID turn ID and returns the same projection;
it does not provide linked-resource navigation.

Each successful list or detail executes in one short
`REPEATABLE READ / READ WRITE` transaction:

1. re-authorize `ai_quality:read_metadata`;
2. establish `observedAt` and read/project the eligible turn data;
3. append one required `ai_quality_metadata_accessed` Audit; and
4. commit before returning.

The Audit metadata is restricted to:

```ts
type AiQualityAccessMetadata = Readonly<{
  accessCategory: 'list' | 'detail';
  filterCategory: 'all' | 'status' | 'time_range' | 'status_and_time' | 'id';
  returnedCount: number;
}>;
```

The list uses `ai_turn_query` with the actor UUID as its resource ID. Detail uses
`ai_turn` with the opaque turn UUID. It does not place status, prompt identity,
failure category, or time values into Audit metadata. Audit failure withholds the
response under the same acknowledgement boundary as Audit Read.

## 6. API and error summary

The full draft is in `docs/api/admin-audit-quality.md`.

| Method | Route                             | Permission                 | Purpose                                                         |
| ------ | --------------------------------- | -------------------------- | --------------------------------------------------------------- |
| `GET`  | `/admin/audit-logs`               | `audit:read`               | Read the narrow Staff/Knowledge/action-access Audit projection. |
| `GET`  | `/admin/ai-quality/turns`         | `ai_quality:read_metadata` | List eligible Persistent AI Turn execution metadata.            |
| `GET`  | `/admin/ai-quality/turns/:turnId` | `ai_quality:read_metadata` | Read one eligible Persistent AI Turn metadata projection.       |

All routes require `ADMIN_AUTH_ENABLED=true`, an exact trusted Admin Origin, and a
current Staff Session. They return `Cache-Control: private, no-store`. Because all
three routes are GET-only, they do not require a CSRF header; any future mutation
would require the Staff CSRF guard and separate design.

Errors use the existing envelope:

- invalid time/filter/cursor or ID shape: `400 VALIDATION_ERROR`;
- missing Staff Session: `401 UNAUTHENTICATED`;
- wrong role, forged context, or untrusted origin: `403 FORBIDDEN`;
- unavailable/missing AI Turn detail: `404 NOT_FOUND`;
- Admin disabled: `503 ADMIN_AUTH_DISABLED`; and
- database/projection/access-Audit failure: `500 DATABASE_ERROR` with no data.

## 7. Repository, schema, index, and migration plan

Expected implementation changes are deliberately small:

- API-local strict request/cursor/response Zod schemas;
- an Admin Audit/AI metadata repository and application service;
- three controller GET routes and module wiring;
- code-owned readable Audit pair/presenter schemas;
- new `audit_log_accessed` and `ai_quality_metadata_accessed` action/resource
  allowlists and their exact metadata schemas;
- a required-access-Audit append that proves an insert occurred; and
- API/integration/privacy tests and documentation.

No new table, column, database enum, AI Quality store, log query system, or shared
frontend package is required. The existing varchar/JSONB Audit representation can
hold the new bounded application actions. Therefore the first local-demo
implementation requires **no Migration**.

The current tables do not have ideal global `(occurred_at, id)` or
`(created_at, id)` indexes. With the first implementation's small local dataset,
maximum 31-day window, and page size 50, this is an accepted bounded limitation.
Implementation must inspect PostgreSQL query plans with representative synthetic
data. If evidence shows an unacceptable scan, add only the proven indexes in a
separate forward-only migration; do not pre-build a reporting index suite.

## 8. Concurrency, retention, retry, and logging

- Authorization-first and revocation-first orders retain ADR-020 semantics. A
  revocation committed before transaction authorization denies the read. A read
  that authorizes and establishes its snapshot first is in-flight and may return
  only after its access Audit commits; the system cannot recall an already returned
  response.
- Each page/detail request is an independent access and Audit event. Retrying a
  network-unknown read may append another access Audit. No response claims that a
  failed request definitely left no Audit row.
- A page never extends `retentionUntil`. Expired Audit rows are hidden before purge;
  purged Audit or cascaded AI Turn data is not restored or copied.
- Audit `actorId`/`resourceId` values remain opaque identifiers and are not described
  as anonymized.
- Ordinary/security logs record only fixed route/outcome/failure categories and
  request correlation already permitted by the logging policy. They never receive
  filter values, response rows, prompt identity, failure code/category, Staff
  email, tokens/cookies/CSRF, or psychological content.

## 9. Implementation split and rollback

These remain delivery batches inside Phase 6, not new product phases.

### Batch 4A — Audit Read

- strict readable-pair schemas and required access-Audit append;
- repository/service/controller for `GET /admin/audit-logs`;
- authorization, cursor, retention, concurrency, and leakage tests.

Rollback: disable/remove the read route. Existing append/purge behavior and stored
Audit rows remain unchanged.

### Batch 4B — Persistent AI Turn metadata

- safe prompt/failure/lifecycle presenter;
- list/detail repository/service/controller;
- access Audit and deletion/Incognito/privacy tests.

Rollback: disable/remove the metadata routes. AI orchestration and `ai_turns`
lifecycle remain unchanged.

The split keeps Audit Read independently useful and prevents AI metadata work from
blocking it. Neither implementation requires an Admin page.

## 10. Acceptance matrix for future implementation

### 10.1 Authentication and authorization

- ordinary Session, submitted Staff ID, missing/expired/revoked Staff Session,
  disabled principal, and stale authorization revision are rejected;
- wrong role and `access_administrator` alone are rejected for both readers;
- direct application-service calls cannot bypass database authorization;
- an explicit role grants only its one fixed permission;
- trusted Admin Origin and `private, no-store` are enforced; GET requires no CSRF.

### 10.2 Audit Read

- only exact readable action/resource pairs are returned;
- each action's metadata is independently Zod validated and unknown JSON is never
  passed through;
- unknown/out-of-scope actions are excluded, while malformed rows that claim a
  readable pair fail the whole page safely;
- raw idempotency keys, emails, current roles, content, arbitrary DTO/Error, and
  dereferenced resources never appear;
- malformed/non-canonical/schema-invalid cursors, filter mismatch, cursor-embedded
  invalid or overlong time windows/ceilings, ordering, and page bounds are tested;
- access Audit failure/required-insert failure returns no page;
- exactly one access Audit is produced for a successful request, is absent from
  the same traversal, and does not trigger a recursive read;
- PostgreSQL barriers cover read-first and purge-first ordering; snapshot-first
  returns one complete old page while purge-first omits the row;
- expired-unpurged rows are hidden and purge remains independently bounded.

### 10.3 Persistent AI Turn metadata

- list/detail return only the defined projection and never return linked IDs,
  text, Risk, Quota, Knowledge citation/query, or Provider data;
- every known failure code maps to the expected category and arbitrary historical
  values map to `unknown` without raw passthrough;
- invalid prompt identity becomes unavailable, missing/negative lifecycle data is
  not invented, and lease state is derived against one `observedAt`;
- soft-deleted and expired parent Conversations are excluded before physical purge;
- PostgreSQL barriers cover metadata-read-first and Conversation purge-first
  ordering without mixed or recreated state;
- hard deletion makes detail return 404 and does not create an independent copy;
- Incognito executions never appear, including by joining logs/Risk/Audit;
- Admin metadata remains readable when generation is disabled, but the read makes
  no Provider call and consumes no quota;
- access Audit failure returns no metadata.

### 10.4 Privacy, migration, and regression

- redaction tests cover message/prompt/provider payload, user/client/conversation/
  message identifiers, credentials, cookies, CSRF, Staff email, and query values;
- existing Staff, Safety Review, Knowledge, Audit append/purge, Conversation
  deletion, Persistent/Incognito, Consent, Quota, and AI safety tests remain green;
- no schema migration is added unless a reviewed query-plan result proves an index
  is necessary; any later index change is forward-only and uses `_test` databases;
- synthetic tests are not described as real-model, clinical, content-review, or
  production-identity evidence.

## 11. Decisions and production-only work

No unresolved product decision blocks implementation. The 7-day default, 31-day
maximum, narrow Audit action subset, and split
implementation are ordinary reversible engineering choices within ADR-020.

A new architecture decision is required before any future batch adds message or
prompt content, exports, answer scoring, reviewer labels/work items, operational-log
ingestion, model calls, or Incognito history. This design does not authorize any of
them.

Production-only work remains separate:

- real Staff enrollment, MFA/recovery/offboarding, and emergency access policy;
- production Audit/Staff/AI metadata retention and account-deletion treatment;
- encryption, backup/restore, automatic cleanup scheduling, and production Admin
  observability;
- accountable approval of any future content-bearing review purpose and access;
- Provider/privacy/Consent review and real-model evaluation.

## 12. Preserved project state

- Frontend work remains user-owned; no Admin UI or Knowledge AI-B client is
  implemented here.
- The three candidate articles remain unverified and unpublished.
- `ADMIN_AUTH_ENABLED=false` remains the default.
- `AI_KNOWLEDGE_ENABLED=false` remains the default.
- Production Safety Lock remains Enforced.
- Production AI Chat remains Disabled.
- `productionSafe=false`.
- Real Model Safety Evaluation remains Not Evaluated.
- Phase 5E and Phase 6 remain incomplete.
