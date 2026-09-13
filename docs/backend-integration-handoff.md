# Backend Integration Handoff

- Verified code snapshot: `ec70e806f00f2cb79166e5dce2279a4bb792ba19`
- Verification method: read-only review of controllers, application services,
  shared types, Drizzle schema/migrations, API documents, and representative tests
- Runtime verification in this documentation batch: not rerun
- Baseline hosted verification: PR #34 pre-merge run
  [34690443943](https://github.com/yuan672/mental-health-ai/actions/runs/34690443943)
  and `develop` post-merge run
  [34691042945](https://github.com/yuan672/mental-health-ai/actions/runs/34691042945)

This document is the integration index for the current backend. It does not replace
`docs/HANDOFF.md` or an Accepted ADR. Detailed request and response contracts remain
in `docs/api/`; this file deliberately links to them instead of copying every
schema into another source of truth.

The replacement frontend is user-owned. This handoff describes server contracts
and boundaries only; it does not prescribe pages, components, styling, reducers,
or interaction design.

## 1. Source priority and current state

Use these sources in order:

1. [`HANDOFF.md`](HANDOFF.md) for product, scope, safety, and data requirements;
2. [Accepted ADRs](architecture/adr/README.md) for binding architecture decisions;
3. current controllers, application services, schema, migrations, and tests for
   implemented behavior;
4. detailed [API documentation](api/);
5. [`PROJECT_CONTROL_HANDOFF.md`](PROJECT_CONTROL_HANDOFF.md) for concise delivery
   status;
6. this integration index.

Current safety and rollout state is intentionally unchanged:

- `ADMIN_AUTH_ENABLED=false` by default;
- `AI_KNOWLEDGE_ENABLED=false` by default;
- Production Safety Lock: Enforced;
- Production AI Chat: Disabled;
- `productionSafe=false`;
- Real Model Safety Evaluation: Not Evaluated;
- the three candidate Knowledge articles are unverified and unpublished.

## 2. Delivered backend capability map

“Delivered” below means the bounded engineering contract is present in `develop`.
It is not a production-readiness, legal-approval, clinical-validation, or
real-model-quality claim.

| Domain                                                  | Delivered backend                                                                                                                                                                                                      | Integration entry                                                                                                                          | Important boundary                                                                                                                                                                                       | Representative evidence                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User Auth, adult eligibility, and Consent               | Password registration/login, opaque server Session, adult-verification port, environment-aware registration requirements, Consent projection/decision ledger, exact operation replay, and dependency-scoped withdrawal | [`identity-access.md`](api/identity-access.md), `AuthController`, `ConsentsController`                                                     | Registration is Development/Test-only with the current mock provider and synthetic documents. Production documents and a real age provider are absent.                                                   | `identity-access.integration.spec.ts`, `consent-lifecycle.integration.spec.ts`, `consent-runtime.unit.spec.ts`; PRs [#2](https://github.com/yuan672/mental-health-ai/pull/2), [#14](https://github.com/yuan672/mental-health-ai/pull/14), and [#15](https://github.com/yuan672/mental-health-ai/pull/15) |
| Account deletion                                        | Current-password, Origin/CSRF-protected ordinary-User deletion with bounded single-process runtime termination, required content-free Audit, and commit-result reconciliation                                          | [`account-deletion.md`](api/account-deletion.md), ADR-022                                                                                  | Development/Test only and disabled by default. No UI, durable receipt/tombstone, cross-instance protection, backup erasure, Provider recall, or Production policy is delivered.                          | `account-deletion.unit.spec.ts`, `account-deletion.integration.spec.ts`, `consent-runtime.unit.spec.ts`                                                                                                                                                                                                  |
| Persistent Conversation, Message, and Quota             | Owner-scoped metadata/history reads, save/delete/delete-all, 90-day ordinary retention, message ordering, daily quota, cross-day request idempotency, and refund compensation                                          | [`conversation-access.md`](api/conversation-access.md), [`conversation-quota-foundation.md`](api/conversation-quota-foundation.md)         | History lists contain no preview/title/safety/provider data. Saved Conversations have no automatic expiry. Quota policy remains configuration-owned.                                                     | `conversation-access.integration.spec.ts`, `conversation-quota.integration.spec.ts`; PRs [#3](https://github.com/yuan672/mental-health-ai/pull/3) and [#8](https://github.com/yuan672/mental-health-ai/pull/8)                                                                                           |
| AI orchestration and Safety                             | Provider abstraction, SiliconFlow adapter, strict turn idempotency, real input/output Safety, deterministic crisis/degraded templates, cancellation/deadlines, SSE, Risk Event, Review Queue, and Audit persistence    | [`ai-chat-streaming.md`](api/ai-chat-streaming.md), [`ai-safety.md`](ai/ai-safety.md), ADR-013 and ADR-014                                 | Real provider use remains disabled in Production. Safety templates and synthetic corpora are engineering evidence, not real-model or clinical evidence.                                                  | `ai-foundation.integration.spec.ts`, `ai-safety.integration.spec.ts`, `siliconflow-provider.spec.ts`; PRs [#4](https://github.com/yuan672/mental-health-ai/pull/4) and [#5](https://github.com/yuan672/mental-health-ai/pull/5)                                                                          |
| Incognito runtime                                       | Public create/end lifecycle, strict mode-discriminated chat, bounded session/user/context memory, TTL, logout/Consent cleanup, late-result rejection, and quota replay protection                                      | [`ai-chat-streaming.md`](api/ai-chat-streaming.md), ADR-015 and ADR-016                                                                    | Ordinary Incognito text has no Conversation, Message, or AI Turn row. It is single-process and has no refresh/restart recovery. Minimal Safety/Audit records remain possible.                            | `incognito-privacy.integration.spec.ts`, `incognito-context-store.spec.ts`; PR [#12](https://github.com/yuan672/mental-health-ai/pull/12)                                                                                                                                                                |
| Mood and Profile                                        | Owner-scoped Mood create/status/list/get/update/delete/delete-all plus minimal read-only Profile                                                                                                                       | [`mood-profile.md`](api/mood-profile.md), ADR-017                                                                                          | Mood is independent of AI availability, quota, and AI-admission Consent. Profile adds no profile table or editable personal fields.                                                                      | `mood-profile.integration.spec.ts`, `migration-0006-mood-profile.integration.spec.ts`; PR [#18](https://github.com/yuan672/mental-health-ai/pull/18)                                                                                                                                                     |
| Independent Knowledge reader and publication foundation | Authenticated list/detail, exact immutable versions and frozen ordered sources, guarded synthetic fixture path, restricted manifest publish/withdraw commands                                                          | [`knowledge-base.md`](api/knowledge-base.md), [`knowledge-publication-runbook.md`](architecture/knowledge-publication-runbook.md), ADR-018 | Reader needs only a valid user Session. No search, taxonomy, favorites, reading history, or formal production article has been delivered.                                                                | `knowledge-base.integration.spec.ts`, `migration-0007-knowledge-base.integration.spec.ts`; PR [#22](https://github.com/yuan672/mental-health-ai/pull/22)                                                                                                                                                 |
| Knowledge AI-A                                          | Bounded local lexical retrieval, exact-version source snapshot, grounded prompt/response validation, full-buffer Safety, v2 reference delivery/history, and atomic Persistent provenance                               | [`ai-chat-streaming.md`](api/ai-chat-streaming.md), ADR-019                                                                                | Disabled by default. No vector database, embedding service, user-interest profile, or real-model evaluation. The replacement frontend must implement AI-B before augmentation is enabled for users.      | `knowledge-retrieval.integration.spec.ts`, `knowledge-ai-grounding.integration.spec.ts`, `knowledge-message-reference.integration.spec.ts`; PR [#25](https://github.com/yuan672/mental-health-ai/pull/25)                                                                                                |
| Staff identity and finite authorization                 | Separate Staff principals, credentials, Sessions, role grants, exact Admin origin/CSRF boundary, authorization revision, disable/session revocation, and restricted bootstrap                                          | [`admin-access.md`](api/admin-access.md), ADR-020                                                                                          | Ordinary users cannot become Staff. `access_administrator` is not a universal Admin. HTTP Admin access is disabled by default and limited to Development/Test configuration.                             | `admin-identity.integration.spec.ts`, `migration-0009-admin-identity.integration.spec.ts`; PRs [#27](https://github.com/yuan672/mental-health-ai/pull/27) and [#28](https://github.com/yuan672/mental-health-ai/pull/28)                                                                                 |
| Risk Event and Review Queue                             | Metadata-only Staff list/detail, queue list, atomic claim/resolve, database reauthorization, and required access/mutation Audit                                                                                        | [`admin-safety-review.md`](api/admin-safety-review.md)                                                                                     | No user/message/client-request IDs or psychological text are returned. Queue metadata does not promise real-time monitoring or takeover.                                                                 | `admin-safety-review.integration.spec.ts`; PR [#29](https://github.com/yuan672/mental-health-ai/pull/29)                                                                                                                                                                                                 |
| Admin Knowledge Management                              | Staff-only curated draft, candidate replacement, exact source review, publication/retirement, revision concurrency, and mandatory Audit                                                                                | [`admin-knowledge-management.md`](api/admin-knowledge-management.md)                                                                       | Edit, source-review, and publish permissions are separate. Publisher authority cannot manufacture `source_verified` evidence. Synthetic fixtures are outside Admin HTTP.                                 | `admin-knowledge-management.integration.spec.ts`, `migration-0010-admin-knowledge-management.integration.spec.ts`; PR [#31](https://github.com/yuan672/mental-health-ai/pull/31)                                                                                                                         |
| Audit Read                                              | Allowlisted Staff/Knowledge/Audit/AI-metadata Audit projection, time/filter-bound cursor, retention filtering, database reauthorization, and required access Audit                                                     | [`admin-audit-quality.md`](api/admin-audit-quality.md)                                                                                     | Not a generic Audit database browser. Risk, Crisis, Mood, and Conversation Audit actions are not readable through this initial endpoint.                                                                 | `admin-audit-read.integration.spec.ts`; PR [#33](https://github.com/yuan672/mental-health-ai/pull/33)                                                                                                                                                                                                    |
| Persistent AI Turn metadata                             | Bounded lifecycle, validated prompt identity, mapped failure category, terminal/duration/lease state, parent-Conversation visibility, and required access Audit                                                        | [`admin-audit-quality.md`](api/admin-audit-quality.md)                                                                                     | This is not answer scoring, clinical review, user delivery proof, or content access. It has no Incognito rows and returns no user/Conversation/Message/client-request/Risk/Quota/citation/Provider data. | `admin-ai-turn-metadata.integration.spec.ts`, `admin-ai-turn-metadata.unit.spec.ts`; PR [#34](https://github.com/yuan672/mental-health-ai/pull/34)                                                                                                                                                       |

The database source of truth is [`database/src/schema.ts`](../database/src/schema.ts).
Committed migrations currently run from `0000_secret_photon` through
`0010_moaning_harrier`; normal schema changes remain forward-only Drizzle
migrations.

## 3. Current HTTP surfaces

JSON success responses use `{ "success": true, "data": ... }`. JSON failures use
the bounded envelope in [`error-format.md`](api/error-format.md); the AI chat route
uses its documented SSE contract after streaming begins. User-supplied IDs never
replace authenticated ownership checks.

### 3.1 Public and user Session surfaces

| Surface                   | Routes                                                                                                                                                                                                  | Detailed contract                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Health and entry          | `GET /health`, `GET /auth/registration-requirements`                                                                                                                                                    | [`identity-access.md`](api/identity-access.md)         |
| Account Session           | `POST /auth/register`, `POST /auth/login`, `GET /auth/session`, `POST /auth/logout`                                                                                                                     | [`identity-access.md`](api/identity-access.md)         |
| Account deletion          | `POST /account/deletion`                                                                                                                                                                                | [`account-deletion.md`](api/account-deletion.md)       |
| Consent                   | `GET /consents`, `POST /consents`                                                                                                                                                                       | [`identity-access.md`](api/identity-access.md)         |
| Conversation              | `GET /conversations`, `GET /conversations/:id`, `GET /conversations/:id/messages`, `POST /conversations/:id/save`, `DELETE /conversations/:id`, `DELETE /conversations`                                 | [`conversation-access.md`](api/conversation-access.md) |
| AI availability and quota | `GET /capabilities`, `GET /quota`                                                                                                                                                                       | [`conversation-access.md`](api/conversation-access.md) |
| AI chat                   | `POST /ai/chat/stream`                                                                                                                                                                                  | [`ai-chat-streaming.md`](api/ai-chat-streaming.md)     |
| Incognito lifecycle       | `POST /incognito-contexts`, `DELETE /incognito-contexts/:contextId`                                                                                                                                     | [`ai-chat-streaming.md`](api/ai-chat-streaming.md)     |
| Mood                      | `POST /mood-entries`, `GET /mood-entries`, `GET /mood-entries/creation-status/:clientRequestId`, `GET /mood-entries/:id`, `PATCH /mood-entries/:id`, `DELETE /mood-entries/:id`, `DELETE /mood-entries` | [`mood-profile.md`](api/mood-profile.md)               |
| Profile                   | `GET /profile`                                                                                                                                                                                          | [`mood-profile.md`](api/mood-profile.md)               |
| Independent Knowledge     | `GET /knowledge/articles`, `GET /knowledge/articles/:articleKey`                                                                                                                                        | [`knowledge-base.md`](api/knowledge-base.md)           |

### 3.2 Staff surfaces

Every `/admin` request, including Staff login and GET, requires an enabled,
environment-eligible Admin backend plus an exact configured Admin Origin. Staff
login requires neither a pre-existing Staff Session nor Staff CSRF. Every other
route requires a current Staff Session; Staff-authenticated mutations, including
logout, additionally require Staff CSRF.

| Surface            | Routes                                                                                            | Required role/permission source                                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Staff Session      | `POST /admin/auth/login`, `GET /admin/auth/session`, `POST /admin/auth/logout`                    | [`admin-access.md`](api/admin-access.md)                                                                                                                  |
| Staff access       | create/list/get Staff, grant/revoke role, disable, revoke Sessions                                | `access_administrator`; [`admin-access.md`](api/admin-access.md)                                                                                          |
| Safety review      | Risk list/detail; queue list/claim/resolve                                                        | `safety_reviewer`; [`admin-safety-review.md`](api/admin-safety-review.md)                                                                                 |
| Knowledge workflow | directory/status/draft/review/publication reads and exact draft/review/publish/withdraw mutations | separate `knowledge_editor`, `knowledge_source_reviewer`, and `knowledge_publisher`; [`admin-knowledge-management.md`](api/admin-knowledge-management.md) |
| Audit Read         | `GET /admin/audit-logs`                                                                           | `audit_reader`; [`admin-audit-quality.md`](api/admin-audit-quality.md)                                                                                    |
| AI Turn metadata   | `GET /admin/ai-quality/turns`, `GET /admin/ai-quality/turns/:turnId`                              | `ai_quality_reviewer`; [`admin-audit-quality.md`](api/admin-audit-quality.md)                                                                             |

The exact code-owned role-to-permission map is in
`apps/api/src/admin/staff-access.types.ts`. Roles do not inherit and there is no
wildcard permission.

## 4. Contracts a replacement client must preserve

### 4.1 Session, Origin, CSRF, cache, and validation

- Browser calls must use cookie credentials. Ordinary users use HttpOnly
  `mh_session` and readable `mh_csrf`; Staff uses HttpOnly `mh_staff_session` and
  readable `mh_staff_csrf` scoped to `/admin`.
- Ordinary cookie-authenticated mutations require an exact `WEB_ORIGINS` Origin or,
  when Origin is absent, a URL-parseable Referer whose origin is in that allowlist;
  they also require the CSRF cookie and `x-csrf-token`. The current guard itself
  does not impose a Referer scheme, so an explicitly allowlisted local HTTP origin
  works in Development. ADR-011 still requires HTTPS Referer in Production; the
  current implementation relies on the Production `WEB_ORIGINS` configuration and
  deployment policy to satisfy that requirement rather than enforcing the scheme
  in this guard. Registration and login require the trusted-origin check but no
  double-submit token. Ordinary GET reads do not require CSRF.
- Every Admin request requires an exact `ADMIN_WEB_ORIGINS` Origin. Staff login
  requires neither an existing Staff Session nor Staff CSRF. Staff-authenticated
  Admin mutations, including logout, require the `mh_staff_csrf` cookie and
  `x-staff-csrf-token`; Admin GET requests do not.
- The Admin cookies use `SameSite=Strict`; user cookies use `SameSite=Lax`. Both
  become `Secure` in Production. Ordinary credentials never authenticate Admin
  routes.
- Sensitive reads and documented errors are `private, no-store`; capability and
  registration-requirement responses are also no-store.
- Treat `401 UNAUTHENTICATED` as Session invalidation, cancel outstanding work, and
  discard in-memory data owned by that principal. A late response from the old
  principal must not repopulate current state.
- Runtime-validate every response. `@mental-health/types` provides shared
  TypeScript contracts, but compile-time types alone do not validate network data.
- Do not persist chat, Incognito, Mood, Consent-operation, Knowledge-reading, Staff,
  or sensitive Admin state in `localStorage`, `sessionStorage`, or IndexedDB.

### 4.2 Retry, conflict, and unknown-result semantics are domain-specific

Do not apply one domain's retry rule to another:

| Domain                            | Stable key/concurrency boundary                                                                            | Client meaning                                                                                                                                                                                                                                            |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Persistent AI                     | `(userId, clientRequestId)` AI Turn plus active-Conversation constraint                                    | Exact duplicate returns existing turn metadata and does not regenerate or recharge while the turn exists. Metadata-only recovery also requires the confirmed original `conversationId`; deletion/purge must not fall back to creating a new Conversation. |
| Incognito AI                      | live context claim plus bounded used request IDs and the quota ledger                                      | A duplicate does not restart generation. Ended, expired, lost, or restarted context has no recovery reader.                                                                                                                                               |
| Consent                           | `(userId, operationId)` immutable decision receipt plus `expectedRevision`                                 | Exact replay returns the original receipt and latest state. Same ID with different normalized semantics conflicts. `CONSENT_RESULT_UNKNOWN` is resolved only with the original request/ID.                                                                |
| Mood create                       | live row unique on `(userId, clientRequestId)`                                                             | A duplicate while the row exists returns its current state and may reflect later edits. `creation-status` is read-only; `absent` is not rollback/cancellation proof. Never replay the old create POST automatically.                                      |
| Mood update/delete                | `expectedRevision`                                                                                         | `409 MOOD_STATE_CHANGED` requires an authoritative reread and a new user decision. Delete-all is not automatically retried after an unknown result.                                                                                                       |
| Conversation save/delete          | current owner/lifecycle state                                                                              | Save is idempotent. Delete/delete-all return committed server results; delete-all count is `conversationCount`, never a client estimate.                                                                                                                  |
| Staff create/access lifecycle     | caller Staff UUID for row-lifetime create confirmation; `expectedAuthorizationRevision` for access changes | Missing status after an unknown create does not prove rollback. Role/session/disable conflicts require reread; applied access changes invalidate prior Staff Sessions.                                                                                    |
| Review Queue                      | conditional state transitions                                                                              | Claim/resolve have no immutable operation receipt. After an unknown response, reread queue state; a repeated mutation may correctly conflict.                                                                                                             |
| Admin Knowledge                   | exact article/version plus opaque `draftRevision`                                                          | Create can return current no-change state; replace/review/publish/withdraw use exact revisions and authoritative GET recovery. A timeout does not prove rollback.                                                                                         |
| Audit or sensitive metadata reads | a new audited access per attempt                                                                           | If commit acknowledgement is lost, the access Audit may already exist. Retrying is a new access and may create another Audit record.                                                                                                                      |

### 4.3 Persistent and Incognito chat protocol

`POST /ai/chat/stream` accepts a strict discriminated union:

- Persistent: `mode: "persistent"`, `clientRequestId`, optional owned
  `conversationId`, and `message`.
- Incognito: `mode: "incognito"`, `clientRequestId`, live `contextId`, and
  `message`.

The only SSE names are `turn.started`, `message.segment`, `turn.completed`, and
`turn.failed`. Persistent events bind a `turnId`/Conversation; Incognito events
bind a runtime `generationId` and never fabricate persistent identifiers. Events
after cancel, terminal state, Session/Consent invalidation, or context end are
invalid late results.

Knowledge-reference v2 is explicitly negotiated on both stream and message-history
requests:

```http
X-MH-Knowledge-References: 1
```

- Empty/omitted selects v1. Another non-empty value is a validation error.
- Successful v2 responses acknowledge the header and include
  `Vary: X-MH-Knowledge-References`.
- `deliveryMode=immediate` retains normal semantic streaming and completes with an
  empty reference array.
- `deliveryMode=commit_with_references` has exactly one full-buffered approved
  segment. A client must keep it hidden in bounded memory and reveal body plus the
  non-empty validated reference array only after the strict matching completion.
- A Persistent v1 history page containing a referenced message returns
  `406 CLIENT_CAPABILITY_REQUIRED`; the client must not display the body without
  provenance.
- On missing/truncated/invalid completion, a Persistent client reconciles through
  strict v2 owner-scoped history. A confirmed original Conversation that has been
  deleted/purged ends recovery; do not replay a creation-style POST without its ID.
- Incognito has no history/recovery reader. An uncertain grounded result retires
  that context path instead of regenerating or persisting references.
- Trusted Safety replacement text remains immediate and has no Knowledge
  references.

See [`ai-chat-streaming.md`](api/ai-chat-streaming.md) and
[`ADR-019`](architecture/adr/ADR-019-llm-knowledge-retrieval-and-citation-boundaries.md)
for the full delivery and recovery contract.

### 4.4 Content and evidence isolation

- Development/Test Consent documents are visibly synthetic Registry fixtures.
  Staging/Production accept only `production_reviewed` Registry entries. Missing
  eligible documents disable acceptance/registration/AI admission but must not
  block login, owned withdrawal, Privacy reads, or ordinary history deletion.
- Development/Test Knowledge may expose explicit `synthetic_fixture + unverified`
  content only through guarded fixture configuration. Staging/Production reject it
  in independent reads, retrieval, history provenance, publication policy, and
  Admin projections.
- `source_verified` means a real human checked the exact article-version/source
  evidence described by ADR-018. It is not professional, medical, clinical, legal,
  or production approval.
- Staff Knowledge roles do not create review truth by possession. Draft write,
  source review, and publication are separate permissions and audited actions.

## 5. Data lifecycle summary

| Data                                     | Current engineering lifecycle                                                                                                                                                                                                    |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ordinary Conversations/Messages/AI Turns | Unsaved Conversation expires after 90 elapsed days; saved has no automatic expiry. User deletion removes Message content immediately; bounded purge removes expired/deleted Conversation metadata and cascaded turns.            |
| Incognito chat                           | Process memory only, bounded by Session/user/context/request/message/character limits and TTL. End/logout/invalid Session/Consent withdrawal/expiry/process restart makes it unavailable.                                        |
| Quota                                    | Aggregate is per Asia/Shanghai day; idempotency key is per user across dates. Refund deletes the matching ledger row and decrements its original-date aggregate once.                                                            |
| Mood                                     | Retained for the account lifetime unless explicitly hard-deleted. It does not use Conversation retention. Deletion Audit contains no Mood content.                                                                               |
| Consent                                  | Projection plus decision ledger. Normal lifecycle operations do not rewrite prior decisions. Production retention/account-deletion/backup treatment is undecided.                                                                |
| Risk Event/Queue                         | Risk Event has independent configured retention (Development/Test default 180 days); chat/user references can become null. Queue cascades with its Risk Event. Incognito safety records contain bounded metadata, not chat text. |
| Audit                                    | Independent configured retention. Audit metadata is action-specific and allowlisted; there is no indefinite-retention promise.                                                                                                   |
| Knowledge versions/sources               | Reviewed evidence is immutable; update creates another exact version; withdrawal hides but does not rewrite it. Production content-retention policy is not selected.                                                             |
| Assistant Knowledge references           | Follow the assistant Message lifecycle and cascade with it; exact article-version deletion is restricted while referenced.                                                                                                       |
| Staff                                    | Disablement is terminal in the delivered batch; sessions are fixed-expiry and revision-bound. Production Staff retention/offboarding policy is undecided.                                                                        |

`ON DELETE SET NULL` does not make a Risk Event anonymous and no lifecycle relation
is presented here as a legal-retention conclusion.

## 6. Local learning/demo prerequisites

This section records existing commands and guards; this docs-only review did not run
them.

1. Install Node.js 24 and pnpm 12, copy `.env.example` to an untracked `.env`, set
   an explicit positive `FREE_DAILY_AI_LIMIT`, and replace every local placeholder.
2. Start PostgreSQL with `docker compose up -d`, then run `pnpm db:migrate`.
3. Start the API with `pnpm dev:api`. `APP_ENV=development`,
   `AI_CHAT_ENABLED=false`, `AI_KNOWLEDGE_ENABLED=false`, and
   `ADMIN_AUTH_ENABLED=false` are the safe default posture.
4. Development registration requires `AGE_VERIFICATION_PROVIDER=mock` and the
   current synthetic Consent Registry. Its document URLs are served by the existing
   Vite Development/Test fixture pages and are excluded from a production build. A
   replacement frontend must deliberately provide an equivalent Development/Test
   document-reading path; the backend does not host those pages.
5. `pnpm --filter @mental-health/api knowledge:seed-fixture -- <manifest>` inserts
   only a visibly synthetic Knowledge fixture and fails outside Development/Test.
   In Test it additionally requires a database name ending in `_test`. It does not
   reset the schema. With the repository-pinned pnpm 12.4.0, an isolated argv probe
   confirmed that the `--` separator is removed before the script starts, so the
   manifest is `process.argv[2]`. Filtered commands run with `apps/api` as their
   working directory; the existing manifest loader checks both that directory and
   the workspace root, so the runbook's root-relative fixture path resolves.
6. `pnpm --filter @mental-health/api admin:bootstrap` reads one JSON object from
   protected stdin and is limited to Development/Test. Set
   `ADMIN_AUTH_ENABLED=true` only to exercise Admin HTTP in an eligible local
   environment; this switch cannot authorize Production use.
7. `pnpm --filter @mental-health/api admin:seed-fixture` is Test-only and requires
   a `_test` database.
8. `pnpm --filter @mental-health/api seed:e2e` is destructive by design: it drops
   and rebuilds the configured schema, but code requires both `APP_ENV=test` and a
   database name ending in `_test`. It is not a Development/Production bootstrap or
   a general demo-data command.

The repository has no one-command reusable demo initializer that creates an
ordinary account, Staff role matrix, Knowledge workflow, real provider, and
production-ready Safety configuration together. Existing fixture/seed paths are
purpose-specific and must not be composed into a production claim.

## 7. Remaining work, classified

### 7.1 Accepted backend engineering gaps

No unresolved implementation gap was found in the already accepted and merged
backend batches at the verified snapshot. In particular, Knowledge AI-A and Admin
Batch 1, 2, 3, 4A, and 4B must not be reimplemented.

This does not broaden their accepted contracts. AI Quality remains metadata-only;
a content-bearing answer-review or scoring workflow would require a separate
privacy/permission/product decision and is not an implicit missing endpoint.

### 7.2 Client work owned outside this backend task

- replacement user frontend integration with the existing public APIs;
- Knowledge AI-B v2 reference delivery, hidden pending body, 406 handling, and
  Persistent reconciliation;
- Admin UI for the already delivered finite Staff, Safety Review, Knowledge,
  Audit, and AI metadata APIs.

These client items are pending. Cancelling the former UI design does not mark them
complete and does not invalidate the server protocol.

### 7.3 Human product/content/policy decisions

- article-by-article review, reuse-right confirmation, accountable reviewer
  evidence, and controlled publication of curated Knowledge content;
- production Consent wording and determination of whether the two current Consent
  types are sufficient for third-party AI processing;
- production Consent, Risk/Audit, Staff, Knowledge, account-deletion, and backup
  retention policies;
- authoritative mainland-China crisis-resource verification;
- production age-verification and Staff enrollment/offboarding policies.

### 7.4 Production-only engineering and verification

- Provider privacy, retention, security, and applicable compliance review;
- real-model safety, grounded-answer, citation, and quality evaluation;
- real reviewer identity deployment, MFA/recovery, and least-privilege operations;
- database encryption/key management plus backup/restore/deletion testing;
- automatic Conversation and Safety/Audit retention scheduling;
- abuse prevention/rate limiting and production quota policy;
- deployment-layer SSE buffering, disconnect, and SPA hosting verification;
- a multi-instance decision for Incognito state and Consent cancellation;
- complete production configuration, secret provisioning, and workload/query-plan
  validation.

These remain production blockers but do not retroactively make the merged bounded
Development/Test engineering batches incomplete.

### 7.5 Deferred optional or out-of-scope capabilities

Search/taxonomy/favorites, vector retrieval/embeddings, a generic permission
platform, content-bearing psychological review, real-time human takeover, B2B,
payments, social/community features, native apps, and WeChat mini-programs remain
deferred or outside the current V1 scope.

## 8. Suggested reading order for an integration client

1. [`error-format.md`](api/error-format.md) and
   [`identity-access.md`](api/identity-access.md);
2. [`conversation-access.md`](api/conversation-access.md) and
   [`ai-chat-streaming.md`](api/ai-chat-streaming.md);
3. [`mood-profile.md`](api/mood-profile.md) and
   [`knowledge-base.md`](api/knowledge-base.md);
4. [`admin-access.md`](api/admin-access.md),
   [`admin-safety-review.md`](api/admin-safety-review.md),
   [`admin-knowledge-management.md`](api/admin-knowledge-management.md), and
   [`admin-audit-quality.md`](api/admin-audit-quality.md) for an independently
   authorized Admin client;
5. `packages/types/src` for shared compile-time types and server code/tests for
   strict runtime schemas and edge-case evidence.

When a linked detailed document describes a narrower historical batch, preserve
that batch boundary and use current code plus `PROJECT_CONTROL_HANDOFF.md` for
delivery status.
