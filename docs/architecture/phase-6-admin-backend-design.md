# Phase 6 Admin Identity and Least-Privilege Backend Design

- Status: Accepted for Batch 1 backend implementation
- Date: 2026-09-12
- Scope: backend identity, sessions, authorization, sensitive-access auditing, and
  implementation boundaries only
- Related: HANDOFF section 45 and ADR-004, ADR-007, ADR-011, ADR-014, ADR-016,
  ADR-018, and ADR-019

## 1. Outcome and scope

This design defines a small, independently implementable Admin backend for the
existing modular monolith. It does not design an Admin page and does not grant any
ordinary user administrative authority.

The first implementation batch establishes only staff identity, staff sessions,
finite roles, permission checks, account lifecycle, and access-change auditing.
Later batches can expose the already planned Risk Review, Knowledge Management,
Audit Read, and AI Quality Review APIs behind that foundation.

This design does not add an organization model, B2B tenancy, a general policy
engine, a generic permissions database, realtime human takeover, or a universal
administrator.

## 2. Current baseline

### 2.1 Backend capabilities already complete

| Capability             | Current implementation                                                                                     | Reusable boundary                                                                                      |
| ---------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Ordinary user identity | `users`, password credentials, opaque server sessions, Argon2id, CSRF, trusted-origin checks               | Password hashing, random token generation, token hashing, cookie hardening patterns, safe error system |
| Session invalidation   | Fixed-expiry user sessions, logout revocation, AI abort, Incognito cleanup                                 | Revocation and fail-closed session-validation patterns                                                 |
| Risk records           | Minimal `risk_events` with independent retention and no copied message body                                | Risk metadata repository and retention policy                                                          |
| Human review workflow  | Queue persistence, atomic claim/resolve, assignment, bounded resolution codes                              | `HumanReviewQueueService` and repository state transitions                                             |
| Reviewer authorization | `SafetyReviewerAuthorizer` at the application-service boundary                                             | Default implementation denies every principal; fake authorization exists only in tests                 |
| Sensitive read audit   | Risk context read and its audit append share one transaction                                               | If audit persistence fails, sensitive context is not returned                                          |
| Audit persistence      | Append-oriented `audit_logs`, action-specific Zod metadata, retention and purge                            | Transactional append and idempotency-key support                                                       |
| Knowledge publication  | Immutable versions, frozen ordered sources, exact-version publish/withdraw commands, environment isolation | Publication service/repository and manifest contracts                                                  |
| Knowledge-grounded AI  | Local retrieval, exact-version references, v2 capability negotiation and history protection                | Backend AI-A is complete and disabled by default                                                       |

### 2.2 Backend capabilities not yet implemented

- a trusted staff principal and credential store;
- staff-only sessions, cookies, origin rules, and CSRF boundary;
- real role-to-permission resolution;
- account creation, explicit grant, revocation, disablement, and session-revoke
  services for staff;
- Admin HTTP APIs for Risk Events, queue listing, Knowledge Management, Audit
  reading, or AI Quality Review;
- a real replacement for `DefaultDenySafetyReviewerAuthorizer`;
- a production staff-enrollment, MFA, recovery, and offboarding process;
- an approved ability to read psychological conversation text for either Safety
  Review or AI Quality Review.

The current Knowledge publish/withdraw commands remain valid controlled internal
operations. Adding an Admin API later does not silently replace or weaken their
exact-version and immutable-evidence rules.

### 2.3 Backend interfaces ready for the replacement frontend

The replacement frontend can integrate without additional backend invention:

- `POST /ai/chat/stream` with `X-MH-Knowledge-References: 1` negotiates strict v2
  `deliveryMode` and answer-level exact-version references;
- `GET /conversations/:id/messages` with the same capability header returns strict
  v2 history, while an affected v1 reader receives HTTP 406
  `CLIENT_CAPABILITY_REQUIRED`;
- `GET /knowledge/articles` and `GET /knowledge/articles/:articleKey` expose the
  authenticated independent Knowledge reader;
- current Auth, Consent, Conversation, Incognito, Mood, Profile, Quota, and
  capability endpoints retain their accepted contracts.

AI-B client presentation and reconciliation remain pending. Suspending the old Web
implementation does not change the server contract and does not mark AI-B or Phase
5E complete.

### 2.4 Human or production decisions that code cannot complete

- the three candidate articles remain unverified and unpublished;
- source/reuse review and accountable human approval for real curated content;
- mainland-China crisis-resource verification;
- Provider privacy, retention, security, and applicable compliance review;
- production Consent wording and whether an additional AI-processing Consent is
  required;
- production staff enrollment, MFA/recovery, offboarding, and emergency-access
  policy;
- whether reviewers may ever read bounded ordinary conversation text;
- whether AI Quality Review may ever read user or assistant message content;
- production Audit, staff-account, and access-decision retention;
- database encryption, backup/restore, and cross-instance cancellation readiness.

For the current local learning/demo use, synthetic staff accounts and records are
sufficient for engineering tests. They do not satisfy the production decisions
above.

## 3. Identity separation

### 3.1 Recommendation

Create a separate **staff identity domain**. An ordinary `users` row never carries
an Admin flag, role, or permission. Staff principals have separate credentials,
sessions, cookies, and guards.

The same human may independently hold an ordinary account and a staff account, but
the records are not linked and neither account derives authority from the other.
A valid ordinary `mh_session` cookie cannot authenticate an `/admin/*` request.
Knowing or submitting a staff principal ID is not authentication.

This separation reuses existing cryptographic and HTTP patterns without reusing the
ordinary user's security context:

- Argon2id password hashing through the existing password-hasher implementation;
- random 256-bit opaque session tokens with only SHA-256 hashes stored;
- fixed expiry and explicit revocation;
- Secure, HttpOnly, SameSite cookies;
- trusted-origin plus double-submit CSRF validation;
- unified AppError envelopes and typed redacted security logging.

### 3.2 Staff session boundary

Use separate names and scope:

- `mh_staff_session`: HttpOnly, Secure in Production, SameSite=Strict, Path=/admin;
- `mh_staff_csrf`: readable only for the staff client path, SameSite=Strict,
  Path=/admin;
- the existing `x-csrf-token` header can be reused, but it is compared only with
  `mh_staff_csrf` for staff mutations;
- `ADMIN_WEB_ORIGINS` is a separately validated allowlist with no implicit fallback
  to ordinary `WEB_ORIGINS` in Staging or Production.

Every protected request resolves a `StaffAuthorizationContext` from the raw staff
session. The context contains only staff principal ID, staff session ID, current
authorization revision, and code-derived permissions. Controller input cannot
construct it.

```ts
type StaffAuthorizationContext = Readonly<{
  principalId: string;
  sessionId: string;
  authorizationRevision: number;
  permissions: readonly StaffPermission[];
}>;
```

The session lookup joins the active session to an active staff principal and
requires `session.issued_authorization_revision =
principal.authorization_revision`. A disable, grant, or revocation increments the
principal revision and revokes that principal's existing sessions in the same
transaction. A stale session therefore fails even if a best-effort cookie clear did
not reach the browser.

## 4. Finite roles and permissions

Roles are code-owned, Zod-validated keys. There is no database-configurable role or
permission expression language. Role grants are explicit and combinable; no role
inherits from another role, and no `super_admin` or wildcard permission exists.

| Role                        | Allowed permissions                                                                                                              | Returned/readable data                                                                                                                                                    | Explicitly not allowed                                                                                                               |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `access_administrator`      | create a staff principal; list staff access state; grant/revoke a bounded role; disable a staff principal; revoke staff sessions | staff ID, normalized login email, status, active role keys, authorization revision and lifecycle timestamps                                                               | Risk Events, queue contents, chat/Mood/Incognito content, Knowledge verification/publication, general Audit data, AI Quality records |
| `safety_reviewer`           | list/read minimal Risk Event metadata; list queue; claim own item; resolve own claimed item                                      | Risk Event ID, level, bounded categories/reason codes, detection/policy/classifier version, timestamps, Incognito flag, queue ID/priority/state/assignment and resolution | user email, message body, full Conversation, Incognito body, prompts, Provider payload, Audit browsing, staff management             |
| `knowledge_editor`          | create the next draft version; edit draft body and ordered sources; validate a draft                                             | exact editorial title/summary/blocks/source records and draft state                                                                                                       | mark `source_verified`, publish, withdraw, Risk/Audit data                                                                           |
| `knowledge_source_reviewer` | read an exact draft and create a source-review attestation for that exact immutable body/source set                              | editorial content/source evidence and its review state                                                                                                                    | edit the reviewed version, publish, claim professional review, Risk/Audit data                                                       |
| `knowledge_publisher`       | publish or withdraw an exact version that already satisfies the accepted evidence contract                                       | exact version, review evidence identity, publication state/timestamps                                                                                                     | edit content/sources, create its source-verification result, claim professional review                                               |
| `audit_reader`              | read paginated allowlisted Audit records and safe metadata                                                                       | actor type/ID, action, resource type/ID, occurrence/retention time, action-specific safe metadata                                                                         | dereference resources into psychological content, credentials, request bodies, arbitrary metadata                                    |
| `ai_quality_reviewer`       | read bounded AI operational/turn metadata selected for a future quality workflow                                                 | turn ID, status, prompt/model version, finish/failure category and bounded timing/token metadata where already permitted                                                  | user identity, client request ID, message body, prompt text, citation query/rank, Incognito content, Provider raw payload            |

`safety_reviewer` and `ai_quality_reviewer` are metadata-only in the minimum design.
No initial role receives psychological message-content access. If a later review
workflow genuinely requires ordinary Conversation text, it needs a separately
named permission, a bounded response contract, assignment/purpose checks, and a
successful access audit in the same transaction. Incognito raw text remains
unavailable because ADR-014 deliberately stores no Incognito snapshot.

## 5. Minimal data model

The proposed implementation adds four tables. All changes use a forward-only
Drizzle migration and retain the existing ordinary-user tables unchanged.

### 5.1 `staff_principals`

| Field                    | Rule                                                              |
| ------------------------ | ----------------------------------------------------------------- |
| `id`                     | caller-generated UUID primary key and creation-confirmation key   |
| `status`                 | stable DB enum `active \| disabled`                               |
| `authorization_revision` | positive integer, monotonically incremented on role/status change |
| `created_at`             | immutable timestamp                                               |
| `disabled_at`            | null while active; set once disabled                              |

Initial implementation does not hard-delete or reactivate a staff principal. A
future account-deletion/retention policy is separate from disablement.

### 5.2 `staff_password_credentials`

| Field                      | Rule                                                    |
| -------------------------- | ------------------------------------------------------- |
| `staff_principal_id`       | primary key, FK to staff principal, `ON DELETE CASCADE` |
| `email`                    | normalized lowercase login identifier, unique, max 320  |
| `password_hash`            | Argon2id hash only                                      |
| `created_at`, `updated_at` | credential lifecycle timestamps                         |

Email and password material never enter Audit or ordinary/security logs.
The credential row is created only in the same transaction as its principal; the
initial implementation has no endpoint that creates a principal without a usable
credential or later fills one by direct database editing.

### 5.3 `staff_sessions`

| Field                                    | Rule                                       |
| ---------------------------------------- | ------------------------------------------ |
| `id`                                     | UUID primary key                           |
| `staff_principal_id`                     | FK with `ON DELETE CASCADE`                |
| `token_hash`                             | unique 64-character SHA-256 digest         |
| `issued_authorization_revision`          | revision bound when the session is created |
| `created_at`, `expires_at`, `revoked_at` | fixed session lifecycle                    |

Indexes cover principal and expiry. TTL comes from validated
`STAFF_SESSION_TTL_SECONDS`; a test fixture value is not a production policy.

### 5.4 `staff_role_grants`

| Field                                   | Rule                                                                                   |
| --------------------------------------- | -------------------------------------------------------------------------------------- |
| `id`                                    | UUID primary key                                                                       |
| `staff_principal_id`                    | FK with `ON DELETE CASCADE`                                                            |
| `role_key`                              | application/Zod bounded text, not arbitrary public input                               |
| `grant_source`                          | stable `bootstrap \| staff` discriminator                                              |
| `granted_by_principal_id`               | nullable self-domain FK with `ON DELETE SET NULL`; required when a staff grant is made |
| `granted_at`                            | immutable grant timestamp                                                              |
| `revoked_by_principal_id`, `revoked_at` | nullable revocation evidence; actor FK uses `SET NULL`                                 |

A partial unique index permits at most one active grant for a principal/role.
Normal revocation sets the revocation fields and never edits the original grant
identity/time. Application validation rejects unknown role keys. `SET NULL` is a
technical lifecycle rule, not a claim that records are anonymized.

A second partial unique index permits only one `grant_source=bootstrap` grant, and
application/database checks restrict that source to `access_administrator`.
`grant_source` distinguishes a real bootstrap from a later lifecycle cleanup that
sets a staff actor FK to null. Bootstrap grants are never hard-deleted in the
initial lifecycle, so disabling or revoking the first principal does not silently
reopen bootstrap. Recovery after that point requires the separately approved
operational procedure, not another ordinary bootstrap invocation.

Audit rows remain the action record for staff creation, role changes, disablement,
session revocation, and sensitive reads. Audit actor IDs intentionally remain
opaque text without a staff FK so an approved future staff cleanup cannot erase the
actor reference by cascade. Production retention is still undecided.

## 6. Staff account lifecycle

### 6.1 Initial account

There is no public staff registration and no default staff account.

The first `access_administrator` is created by a restricted offline bootstrap
command. It reads the password from secure stdin, accepts one explicit normalized
email, grants only the explicitly requested `access_administrator` role, and emits
no credential or email. The database transaction creates the principal,
credential, role grant, and bounded bootstrap Audit action atomically.

Before checking whether bootstrap is available, that transaction acquires one
fixed, application-owned PostgreSQL transaction advisory lock. The availability
check and all inserts therefore execute in one database-wide serial order even
when two processes submit different emails and no principal row yet exists. The
lock is released automatically on commit or rollback. It is not held while hashing
the password, and it is not a distributed bootstrap service. The partial unique
bootstrap-grant index remains the database invariant if a caller omits or
misorders the advisory-lock protocol.

The command:

- refuses to run against a Development/Test fixture database unless its name ends
  in `_test` when destructive setup is requested;
- refuses to create another bootstrap principal after any committed bootstrap
  grant, even if the original principal is later disabled or its role is revoked;
- is fail-closed in Staging/Production unless an explicit deployment-controlled
  bootstrap prerequisite is present;
- never accepts a wildcard role list.

Production operator identity, MFA, credential recovery, and storage of the
deployment bootstrap prerequisite require separate operational approval. Local
synthetic setup does not satisfy them.

### 6.2 Explicit staff creation and grants

An `access_administrator` creates a staff principal and its initial password
credential in one transaction; the new principal has no domain role. The request
contains a caller-generated `staffPrincipalId`, normalized email, and initial
password. The password is validated and Argon2id-hashed before the short database
transaction, is never returned, and is never passed to Audit or logging. The
transaction revalidates the actor permission, inserts principal and credential,
appends `staff_principal_created`, then commits. An Audit or credential insert
failure rolls everything back. Roles are granted separately and explicitly.
Account creation does not copy an ordinary user or infer a role from an
email/domain.

The UUID gives a row-lifetime confirmation boundary without a general operation
ledger. If that ID already exists for the same normalized email with a credential,
the endpoint returns `no_change` plus the current staff state and never replaces
the stored password hash; the response is not an immutable receipt for the
original password. The same ID with another email, or the same email with another
ID, returns 409 and changes nothing. After a network-unknown result, the caller
keeps the original request in memory and first reads
`GET /admin/staff-principals/:id`. `present` confirms only the current row;
`missing` may mean the first transaction is still in flight and does not prove
rollback. Retrying creation is permitted only with the same ID, email, and original
password snapshot. If that snapshot is unavailable, the caller must stop and
resolve state rather than generate a replacement ID or password automatically.

Grant, revoke, and disable operations use the target principal's
`expectedAuthorizationRevision`:

- if the requested desired state is already present, return `no_change` and the
  current authoritative state;
- otherwise a stale revision returns HTTP 409 and applies nothing;
- an applied transition increments the revision, revokes every existing target
  session, appends its Audit record, and commits atomically;
- an Audit failure rolls back the role/status/session changes;
- concurrent different mutations from one revision have one winner and one 409;
- database uniqueness prevents duplicate active grants.

This desired-state behavior gives safe request retries without a general operation
ledger. A read after a network-unknown result establishes the current state but is
not an immutable operation receipt. Audit idempotency keys are stable for the
applied transition; they are not repurposed as a permanent command log.

### 6.3 Disablement and session invalidation

Disablement is terminal in the first batch. It increments authorization revision,
sets `disabled_at`, revokes all staff sessions, and audits the action in one
transaction. New login and all existing-session validation fail afterward.

A role grant or revocation also invalidates all target sessions. This is stricter
than waiting for cached roles to expire and prevents an old session from retaining
a removed permission. A newly granted role requires a new login; role mutation does
not mint a session.

Explicit `revoke-sessions` participates in the same revision protocol. The service
locks the target principal, checks active status and exact
`expectedAuthorizationRevision`, increments authorization revision, revokes every
active session visible under that lock, and appends `staff_sessions_revoked`
atomically. This explicit security command returns `applied` even when
`sessionCount` is zero: advancing revision records the completed revocation
boundary and prevents an old request from targeting a later login. Audit failure
rolls back the revision and every session update. `no_change` remains a result for
role/status desired-state operations, but is deliberately not a result of
`revoke-sessions`.

Staff login takes the same principal-row lock after password verification. While
holding it, login rechecks active status and current grants, then inserts a session
bound to that exact revision. The lock is released before returning the cookie.
Consequently, if login commits first, a following revocation sees and revokes that
session; if revocation commits first, a later login receives the new revision and
is not part of the earlier revocation.

A committed revocation whose response is lost is an unknown result, not a claimed
rollback or immutable receipt. Reading current state may show a newer revision and
no sessions, but does not prove which request caused it. Replaying the old request
with its old expected revision returns 409 and cannot revoke a session created by a
later login. A fresh explicit revocation must start from the newly read revision.
An `applied` result with zero revoked sessions proves the revision boundary was
committed, not that future login is disabled; future login remains possible. A
stale 409 proves only that the supplied revision is no longer current. No response
is guaranteed after an approved future cleanup removes the staff row.

## 7. Authorization and transaction boundary

Authorization is enforced in application services, not only controllers. A
controller guard authenticates the staff session, but each protected application
operation calls a typed `StaffAuthorizer` with one bounded permission.

```ts
interface StaffAuthorizer {
  authorizeWithinTransaction(
    tx: AppTransaction,
    context: StaffAuthorizationContext,
    permission: StaffPermission,
  ): Promise<void>;
}
```

For a sensitive read, one short transaction performs:

1. validate the staff session, active principal, exact authorization revision and
   active required role;
2. read only the allowlisted resource fields;
3. append the access Audit record;
4. commit;
5. return the response.

An Audit failure returns a safe database error and no sensitive payload. If access
revocation commits before step 1, the request is denied. If the sensitive-read
transaction establishes authorization first, the request is an already in-flight
access; it may complete with its committed audit. The system does not claim recall
of data already returned.

The staff principal list/detail is also a sensitive staff-directory read because it
contains normalized email and access state. It follows this same authorize,
allowlisted read, access-audit, commit, then return sequence; it is not exempt merely
because it does not contain psychological content.

Mutation lock order is fixed: the bootstrap-only advisory lock when applicable,
then unique staff principal/session rows (sorted by principal UUID where actor and
target differ), then the domain resource, then Audit append. Login, role/status
changes, and explicit session revocation all serialize on the same target principal
row. No Audit or domain callback acquires staff locks in reverse order. Lock waits
use the request deadline/AbortSignal and remain bounded.

`DefaultDenySafetyReviewerAuthorizer` remains the fallback until a real
database-backed staff authorizer and staff session context are installed. The
replacement authorizer validates the session context at the service boundary; a
plain `{ id: "reviewer" }` value or an ordinary user ID remains insufficient.

## 8. API contract drafts

Every response is `private, no-store`, uses the existing AppError envelope, and is
strictly Zod validated. All mutations require the staff-origin and staff-CSRF
guards. These routes are backend contracts only; this design adds no page.

### 8.1 Identity/session foundation batch

| Method and route                                    | Permission                  | Request/result                                                                                                                                         |
| --------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /admin/auth/login`                            | none; trusted Admin origin  | staff email/password; sets only staff cookies; returns principal ID, active role keys, revision and expiry                                             |
| `GET /admin/auth/session`                           | active staff session        | same bounded session view; no email/password hash/token                                                                                                |
| `POST /admin/auth/logout`                           | active staff session + CSRF | revokes current staff session and clears staff cookies                                                                                                 |
| `POST /admin/staff-principals`                      | `staff_principal:create`    | `{ staffPrincipalId, email, initialPassword }`; atomically creates active principal, credential and Audit with no roles                                |
| `GET /admin/staff-principals`                       | `staff_principal:read`      | opaque-cursor page of ID, email, status, active roles, revision and timestamps                                                                         |
| `GET /admin/staff-principals/:id`                   | `staff_principal:read`      | the same bounded authoritative state                                                                                                                   |
| `PUT /admin/staff-principals/:id/roles/:roleKey`    | `staff_role:grant`          | `{ expectedAuthorizationRevision }`; applied/no-change plus current state                                                                              |
| `DELETE /admin/staff-principals/:id/roles/:roleKey` | `staff_role:revoke`         | CSRF and `{ expectedAuthorizationRevision }`; applied/no-change plus current state                                                                     |
| `POST /admin/staff-principals/:id/disable`          | `staff_principal:disable`   | `{ expectedAuthorizationRevision }`; applied/no-change plus current state                                                                              |
| `POST /admin/staff-principals/:id/revoke-sessions`  | `staff_session:revoke`      | `{ expectedAuthorizationRevision }`; always applied at a current revision, increments it, revokes the locked visible session set and audits atomically |

Missing and non-readable staff IDs share one 404 boundary. Login uses the same
response for unknown accounts and incorrect passwords.

### 8.2 Later Risk Review API batch

- `GET /admin/risk-events`: opaque-cursor metadata-only list;
- `GET /admin/risk-events/:id`: metadata-only detail;
- `GET /admin/review-queue`: opaque-cursor queue list;
- `POST /admin/review-queue/:id/claim`;
- `POST /admin/review-queue/:id/resolve` with an existing bounded resolution code.

Risk Event responses omit user ID, client request ID, Conversation/Message/AI Turn
IDs, email, message body, prompt, assistant output, and Incognito content. They may
expose booleans such as `ordinaryContextReferenceAvailable` without exposing the
identifier. Claim remains the existing atomic `pending -> in_review` transition;
resolve remains restricted to the assigned reviewer.

### 8.3 Later Knowledge Management API batch

Use separate permissions and exact article/version routes:

- editor: create/update a draft and ordered sources;
- source reviewer: attest the exact draft after re-reading its immutable candidate
  identity; the server derives `reviewedBy` and `reviewedAt` from the authenticated
  staff principal and clock;
- publisher: publish or withdraw the exact already-reviewed version.

The API never accepts `reviewedBy` from a client. Source review freezes the exact
body/source set. Publication cannot create verification evidence and keeps ADR-018
sequential-version, retry, source-freeze, environment, and synthetic-isolation
rules. Production publication continues to reject synthetic fixtures.

### 8.4 Later Audit Read API batch

`GET /admin/audit-logs` supports bounded filters over action, resource type,
occurred-at range, and opaque cursor. It returns only the existing allowlisted
columns and action-specific safe metadata. It cannot join or dereference to
Conversation, Message, Mood, Risk body, credential, or Provider payload.

The read and an `audit_log_accessed` Audit append occur in one transaction. A failed
append returns no page. The access record may store only bounded filter categories
and returned count, never a psychological value or arbitrary query object.

### 8.5 Later AI Quality Review API batch

The first AI Quality Review backend is metadata-only. It may list selected AI Turn
operational state and version metadata but does not expose message content, prompts,
users, Incognito data, or Provider payloads. There is no scoring, model-evaluation
claim, or real-model run in this design.

Any content-bearing quality review requires a separate decision covering purpose,
selection, Consent, field access, retention, redaction, audit, and Incognito
exclusion. It is not implicitly authorized by the `ai_quality_reviewer` role.

## 9. Audit contract

Add bounded application action/resource codes, not PostgreSQL enums for evolving
actions.

| Action                             | Resource                    | Safe metadata                                         |
| ---------------------------------- | --------------------------- | ----------------------------------------------------- |
| `staff_principal_bootstrapped`     | `staff_principal`           | `{ roleKey: "access_administrator" }`                 |
| `staff_principal_created`          | `staff_principal`           | `{}`                                                  |
| `staff_role_granted`               | `staff_principal`           | `{ roleKey, resultingAuthorizationRevision }`         |
| `staff_role_revoked`               | `staff_principal`           | `{ roleKey, resultingAuthorizationRevision }`         |
| `staff_principal_disabled`         | `staff_principal`           | `{ resultingAuthorizationRevision }`                  |
| `staff_sessions_revoked`           | `staff_principal`           | `{ sessionCount }`                                    |
| `staff_directory_accessed`         | `staff_principal_query`     | bounded filter category and returned count only       |
| existing Risk/Queue actions        | existing resources          | existing metadata schemas                             |
| `knowledge_source_review_recorded` | `knowledge_article_version` | `{ articleVersion, reviewStatus: "source_verified" }` |
| `knowledge_version_published`      | `knowledge_article_version` | `{ articleVersion }`                                  |
| `knowledge_version_withdrawn`      | `knowledge_article_version` | `{ articleVersion }`                                  |
| `audit_log_accessed`               | `audit_log_query`           | bounded filter category and returned count only       |
| `ai_quality_metadata_accessed`     | `ai_quality_review`         | `{ returnedCount }`                                   |

Staff Audit actor type is `staff`; the role is not copied into each action because
authorization is derived at execution time. Audit schemas reject email, password,
session/cookie/CSRF values, message content, risk narrative, Mood content, prompt,
Knowledge body/source payload, Provider payload, arbitrary DTO, and arbitrary
Error objects.

## 10. Environment, logging, and privacy

- Admin HTTP authentication is disabled by default until its validated
  configuration exists. This does not stop ordinary APIs from starting.
- Development/Test can use visibly synthetic staff fixtures; any seed that resets
  or writes fixture state requires an explicit Test environment and `_test`
  database suffix.
- Synthetic staff, reviewer, Audit, Risk, and Knowledge data cannot be presented as
  production identity, source review, safety evaluation, or compliance evidence.
- Security logs use only fixed event/failure categories plus opaque staff/session
  IDs. They never receive staff email, credentials, cookies, CSRF, role mutation
  DTOs, or domain content.
- Admin authentication does not make Production AI safe and does not alter the
  Production Safety Lock.
- Installing a database-backed reviewer authorizer does not by itself make the
  Safety Gate production-ready. Production readiness still requires a real staff
  principal provider, least-privilege access path, validated configuration and all
  other existing Safety readiness prerequisites; otherwise the effective reviewer
  capability remains fail-closed.
- No new psychological content, Incognito snapshot, reading history, interest
  profile, or long-term chat copy is introduced.

## 11. Implementation sequence and rollback boundaries

These are delivery batches within the existing Admin scope, not new product
phases.

### Batch 1: identity, sessions, and authorization foundation

- Accepted ADR-020 and exact schema/API contract review;
- four staff tables and forward-only migration;
- password/session services, separate cookies/origin/CSRF guards;
- bootstrap and protected synthetic fixture commands;
- role map, `StaffAuthorizer`, staff lifecycle APIs, access-change audits;
- database-backed Safety Reviewer authorizer integration while retaining default
  deny when the foundation is unavailable.

Rollback: disable Admin authentication and retain default-deny reviewer behavior.
No domain data migration depends on a role grant.

### Batch 2: Risk Event and Human Review APIs

- metadata-only Risk list/detail and queue list;
- existing claim/resolve services behind trusted staff context;
- sensitive-read auditing in the same transaction.

Rollback: disable these routes; Risk creation and queue persistence continue
unchanged.

### Batch 3: Knowledge Management APIs

- draft/source editing, separate exact-version source review, publish and withdraw;
- reuse immutable version/source rules and existing command path.

Rollback: disable Admin mutations and retain the existing restricted release
commands and read APIs.

### Batch 4: Audit read and metadata-only AI Quality Review

- bounded Audit reader with access audit;
- metadata-only quality-review list/detail if a concrete workflow requires it.

Rollback: disable read routes; append-only Audit and ordinary AI operation remain
unchanged.

Every batch has an independent PR, migration only where needed, CI, and route-level
enablement. No batch depends on an Admin UI.

## 12. Acceptance matrix

### 12.1 Identity and privilege isolation

- ordinary session cookie against every `/admin/*` route returns unauthenticated;
- an ordinary user ID, forged reviewer ID, disabled staff ID, expired/revoked staff
  session, or stale authorization revision is denied at the service boundary;
- no role, empty roles, and wrong role are denied;
- one explicit role grants only its mapped permissions;
- `access_administrator` cannot read Risk, Knowledge content, Audit, or AI Quality
  resources without a separate grant;
- staff login unknown-account and wrong-password responses are indistinguishable;
- cookies, tokens, passwords, email and mutation bodies do not appear in logs.

### 12.2 Lifecycle and concurrency

- bootstrap creates no default wildcard; two different-email first-bootstrap
  transactions are serialized by the fixed PostgreSQL transaction advisory lock,
  while the partial unique bootstrap-grant index enforces the invariant; exactly
  one succeeds, and the loser leaves no principal, credential, role, or Audit
  residue;
- bootstrap Audit failure rolls back principal, credential and role creation;
- protected account creation requires a caller UUID, email and initial password;
  principal, credential and Audit are atomic, duplicate ID/email conflicts are
  bounded as specified, and a network-unknown read is not called a receipt;
- two concurrent creates with the same UUID/email yield one principal, one
  credential and one creation Audit; a different UUID using the same email, or the
  same UUID using another email, returns 409 without partial rows or Audit;
- with the first create held before commit, a status read may return missing; after
  commit-response loss, the same read returns the current principal, and neither
  observation is described as an immutable create receipt or cancellation proof;
- concurrent creation using the same ID/email produces one principal, one
  credential and one creation Audit; a different ID for the same email or a reused
  ID for another email returns 409 without residue;
- after a deliberately lost create response, a bounded status read can observe the
  current row but missing does not prove rollback; a same-snapshot retry never
  overwrites an existing password hash;
- two concurrent grants of the same role result in one active grant;
- two different mutations from one revision produce one applied result and one 409;
- role revoke/disable plus session revocation plus Audit either all commit or all
  roll back;
- login and revoke-sessions use the same principal-row serialization: revoke-first
  permits a later new-revision login, while login-first causes that session to be
  revoked;
- after a committed revoke-sessions response is lost and a new login succeeds, a
  replay carrying the old revision returns 409 and cannot revoke the new session;
- revoke-sessions always produces `applied` at a current revision, including a zero
  session count; role/status `no_change`, revoke-sessions `applied`, stale and
  unknown results retain the evidence limits defined in section 6.3, and Audit
  failure rolls back the applied path;
- a session validated after revocation/disable cannot use the removed permission;
- an operation authorized before revocation is treated as in-flight and must have a
  committed access Audit before any sensitive response;
- PostgreSQL tests hold the principal row at the login/revocation boundary to prove
  both orders, and hold Audit failure before commit to prove revision and session
  changes roll back;
- lock waits are bounded and concurrency tests use barriers rather than sleep.

### 12.3 Safety Review

- current default authorizer remains deny until Batch 1 is installed;
- Risk/Queue reads never return psychological message text or Incognito content;
- a queue item can be claimed once and resolved only by its assignee;
- Audit failure prevents sensitive response or state transition;
- Risk Event retention, nullable links, queue cascade, and existing creation
  idempotency are unchanged.

### 12.4 Knowledge Management

- editor cannot verify/publish; source reviewer cannot publish; publisher cannot
  create verification evidence;
- server derives reviewer identity/time;
- source verification freezes the exact body and ordered sources;
- old/retried publish/withdraw commands preserve exact-version semantics;
- Development/Test synthetic fixtures cannot become source-verified production
  content;
- Staging/Production continue to reject synthetic content.

### 12.5 Audit and AI Quality

- Audit pages expose only allowlisted rows and cannot dereference content;
- Audit access failure returns no page;
- AI Quality metadata cannot contain user/message/prompt/Provider content;
- no engineering test is described as real-model or clinical evaluation.

### 12.6 Migration and quality gates

- empty database applies every migration from 0000;
- upgrade from the current non-empty schema preserves all users, sessions,
  Consent, Conversations, Risk, Queue, Audit, Mood, Knowledge and citations;
- invalid staff grants fail the migration transaction without partial schema/data;
- dedicated `_test` PostgreSQL only for destructive setup;
- format, lint, typecheck, API tests, existing Web tests, Chromium P0, build, and
  required CI remain green.

## 13. Priority for the current local learning/demo use

1. Implement Batch 1 with synthetic Development/Test accounts and default-disabled
   Admin HTTP auth.
2. Add metadata-only Risk/Queue APIs to exercise least-privilege and audited access.
3. Add Knowledge Management only after a real candidate review workflow needs it.
4. Add Audit read and AI Quality metadata APIs only when there is a concrete local
   review workflow.

AI-B frontend integration is intentionally outside this backend work. The existing
v2 server contract remains available to the user's replacement frontend.

## 14. Decisions needed before implementation

The two material engineering decisions for the first batch are accepted:

1. use separate staff identity/session tables instead of adding roles to ordinary
   users;
2. keep initial Safety Review and AI Quality Review metadata-only, with no
   psychological message-content permission.

Production MFA/identity provider, production bootstrap operation, staff retention,
and any future content-reading permission do not block local engineering, but they
do block production Admin enablement.

## 15. Preserved project state

- The three candidate articles remain unverified and unpublished.
- `AI_KNOWLEDGE_ENABLED` remains false by default.
- Production Safety Lock remains Enforced.
- Production AI Chat remains Disabled.
- `productionSafe=false`.
- Real Model Safety Evaluation remains Not Evaluated.
