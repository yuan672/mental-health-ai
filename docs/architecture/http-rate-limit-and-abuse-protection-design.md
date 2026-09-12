# Minimum HTTP Rate Limiting and Abuse Protection Backend Design

- Status: Accepted engineering design; implementation pending
- Date: 2026-09-12
- Scope: backend HTTP admission and bounded credential-work protection only
- Related: HANDOFF sections 26 and 35; ADR-007, ADR-009, ADR-011 through ADR-020

## 1. Outcome and scope

Add a small, process-local admission layer that protects authentication work,
ordinary API/database work, new AI work, and Staff-sensitive reads from short
bursts. Keep termination, withdrawal, and result-confirmation work in a separately
budgeted lane so exhausting a creation/generation budget does not indefinitely
prevent a user from reducing retained state or authority.

This is the minimum appropriate design for the current single-API-process local
learning/demo deployment. It adds no Redis, table, queue, distributed lock,
external abuse-scoring provider, browser fingerprint, or generic permission
platform. It does not claim to solve volumetric denial of service, distributed
credential attacks, or production proxy/edge protection.

The limiter is not a safety classifier. A request rejected before AI admission has
not been risk-assessed and must not be described as safe. Every AI request that is
admitted continues through the existing Consent, ownership, quota-eligibility,
Risk Detection, Crisis, Provider, Output Safety, cancellation, and persistence
boundaries.

## 2. Current implementation inventory

| Existing mechanism                                                   | What it protects                                                                      | What it does not protect                                                           |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| PostgreSQL daily quota and idempotency ledger                        | Billable AI turns, retry-safe consumption, and refunds                                | HTTP request frequency, login work, reads, or pre-quota classifier load            |
| `ActiveAiExecutionRegistry`                                          | Total AI lifecycle deadline and process-local global/per-user active execution counts | Bursty requests that fail before/while registering; credential or general API work |
| Consent coordinator limits                                           | Per-user lock waiters, total waiters, active executions, and revoked-marker memory    | Unrelated HTTP traffic or password hashing                                         |
| Incognito context store limits                                       | Contexts per process/user/session, requests/messages/characters per context           | Rapid context create/end churn or other routes                                     |
| One active AI turn per persistent Conversation                       | Concurrent generation for one Conversation                                            | Many Conversations or non-AI requests                                              |
| Provider `429` mapping                                               | Upstream/provider throttling failure                                                  | Admission at this API                                                              |
| `RATE_LIMITED` and `QUOTA_EXCEEDED`                                  | Distinct public error codes already exist                                             | There is no general local HTTP limiter or `Retry-After` contract yet               |
| Origin, Session, CSRF, ownership, Staff permission, and Audit guards | Request authenticity and authorization                                                | Request volume; none may be replaced by rate limiting                              |

Relevant implementation entry points include:

- `apps/api/src/auth/auth.service.ts` and `password-hasher.service.ts` for Argon2id
  registration/login cost;
- `apps/api/src/admin/staff-auth.service.ts` for Staff credential verification;
- `apps/api/src/ai/runtime/active-ai-execution.registry.ts` and
  `apps/api/src/consents/runtime/` for existing AI/Consent capacity;
- `apps/api/src/ai/incognito/incognito-context.store.ts` for Incognito bounds;
- `apps/api/src/common/errors/` and `common/filters/app-exception.filter.ts` for the
  existing safe error envelope;
- `apps/api/src/security/security-logging.service.ts` and `app.module.ts` for typed
  logging and redaction.

## 3. Threat model and non-goals

The first implementation addresses:

- repeated login/registration requests consuming Argon2, age-verification, and
  database capacity;
- a valid Session issuing bursts of database reads/writes or new AI work;
- rapid Incognito-context allocation;
- a Staff Session issuing bursts of sensitive audited reads or mutations;
- unbounded process-memory keys created by the limiter itself; and
- accidental client loops, double-submit, and immediate retry storms.

It does not claim protection against:

- a distributed botnet or a large attack hidden behind many real network sources;
- connection, TLS, slow-body, or oversized-body exhaustion before Nest guards run;
- a production reverse proxy that is not configured with an explicit trust model;
- global limits across multiple API instances or a counter that survives restart;
- account-specific distributed password guessing without introducing targeted
  lockout and additional identity/privacy decisions; or
- provider-side capacity, which remains a separate failure domain.

Those are production deployment and capacity-readiness tasks, not reasons to add
Redis or persistent tracking to the current local architecture.

## 4. Recommended architecture

Use one `HttpAbuseProtectionModule` with four narrow components:

1. `IngressRateLimitGuard` applies an early token bucket keyed by a normalized
   direct socket address and one server-owned route-family lane:
   `network_standard`, `network_control`, or `network_mixed_probe`. These lanes have
   separate token and key-storage reservations. Ordinary traffic cannot consume
   the control or mixed-route reservation. The guard executes before credential
   verification, Session/database lookup, or Provider work. Nest has already
   accepted and parsed the HTTP request at this point, so deployment-layer
   connection/body protection remains separate.
2. `MixedRequestAdmission` applies only after successful authentication, existing
   CSRF enforcement, and strict request parsing. A separately bounded
   `classification_probe` permits the minimum owner-scoped read needed to classify
   a mixed POST as exact recovery, new work, or a domain conflict. The result, not a
   client-provided "recovery" flag, selects the downstream policy.
3. `PrincipalRateLimitGuard` applies the selected general, AI-new-work,
   Staff-sensitive, or control/recovery policy using only the authenticated internal
   principal ID.
4. `CredentialWorkAdmission` is a small, non-queued global semaphore shared by all
   HTTP-reachable Argon2 password work: ordinary register/login, Staff login, and
   Staff-principal creation. It protects Argon2 memory and CPU independently of
   request rate.

The guards share a bounded `ProcessLocalTokenBucketStore`. Policy selection is
code-owned metadata, never a raw path or a client-provided policy name. Route method
and normalized controller pattern select the ingress lane. The store operation is
synchronous with no `await` between read, refill, and consume, which makes it atomic
within one Node.js event loop.

Do not add another AI semaphore. The existing `ActiveAiExecutionRegistry` already
bounds complete AI executions globally and per user, carries the total deadline,
and releases on terminal cleanup. Its capacity errors should be translated through
the same fixed `RATE_LIMITED` boundary rather than leaking as generic 500 errors.

### 4.1 Request order

The common order for a route with one fixed purpose is:

```text
server-owned standard or control ingress admission
→ existing Admin-enabled / trusted-Origin checks where applicable
→ existing Session authentication
→ existing CSRF validation for cookie-authenticated mutations
→ strict Zod/application validation
→ fixed principal/action admission
→ ownership / finite Staff permission
→ existing domain transaction or AI lifecycle
```

A mixed POST uses:

```text
server-owned mixed-route ingress admission
→ existing Origin / Session / CSRF guards
→ strict discriminated-union validation
→ classification-probe admission
→ minimum owner-scoped existing-operation/turn lookup
→ server-selected general/new-work, control/recovery, or conflict outcome
→ existing domain service
```

The classification read is itself bounded. If its budget is exhausted, the request
returns 429 before the lookup. The read creates no durable record and does not call
a Provider, classifier, password hasher, or other external service. A missing
record is only a classification result; the existing domain transaction still
resolves a concurrent winner and remains the source of idempotency truth.

Rate limiting never establishes identity, ownership, Consent, or permission. It
must not return protected resource existence or another principal's bucket state.

For login and registration, fixed network/route policies run before account lookup,
age verification, or password work. The credential permit is acquired immediately
before each real or dummy Argon2 operation and is held until that operation settles.
Known and unknown login identifiers consume the same password-work admission unit
and receive the same `RATE_LIMITED` response when that unit is unavailable.

For action-discriminated Consent mutation, the route always uses the mixed ingress
lane; the body cannot select a privileged ingress lane. After Auth, CSRF, and strict
union validation, the bounded classification read looks up `(userId, operationId)`.
An exact already-committed replay uses the control/recovery lane; a same-ID with
different normalized semantics returns the existing Consent conflict without
entering a mutation lane; an absent new acceptance uses ordinary mutation capacity;
and an absent withdrawal uses control/recovery capacity. The repository repeats its
own replay-first checks under its existing lock/transaction protocol. A forged
action can therefore consume only finite mixed/classification/control capacity and
cannot bypass validation, ownership, revision, or withdrawal-target checks.
Admission to `control_recovery` is not a promise that Consent coordination cannot
be busy: the existing bounded per-user/global lock queue, deadline, and revoked-
marker capacity remain authoritative and may still return their current transient
failure. Exact replay keeps its replay-first semantics when it reaches that
coordinator; the limiter does not create an unbounded shortcut around it.

For persistent AI, the route always uses the mixed ingress lane. After Auth, CSRF,
strict union validation, and classification-probe admission, a minimum owner-scoped
`clientRequestId` lookup classifies the request. An existing turn uses
control/recovery HTTP capacity; an absent turn uses AI-new-work capacity before the
current orchestration is invoked. Concurrent misses may each consume an admission
token, but database idempotency still permits only one logical turn and Provider
path. A bound `conversationId` remains mandatory for non-creating metadata recovery;
if the bound Conversation/turn was deleted, recovery stops rather than falling back
to new creation. An unbound POST is creation-capable only under ADR-019's existing
explicit-continuation contract and is classified as new work, never as recovery.

This HTTP classification does **not** bypass current AI execution capacity. Today
`preparePersistentTurn` calls `registerPending`/`bindRequired` before repeating the
existing-turn lookup. Consequently, even after the HTTP recovery lane admits an
existing-turn request, a full `ActiveAiExecutionRegistry`, Consent coordination
capacity/deadline, withdrawn Consent, or invalid/deleted Conversation can still
produce the corresponding bounded failure before metadata is returned. The first
implementation preserves that accepted lifecycle and maps active-execution
capacity to 429; it does not promise metadata recovery during registry saturation.
Guaranteeing otherwise would require a separately reviewed lookup reorder or a new
read-only recovery endpoint and is not accepted by this proposal.

For Incognito AI, the strict mode discriminator selects AI-new-work after the fixed
mixed-route ingress and classification budget. Incognito has no metadata-replay
lane. Rejection occurs before `claimGeneration` and must not add the client request
ID to the context or create a generation claim. Existing context-loss and duplicate-
request semantics then remain authoritative.

No limiter runs after SSE headers are flushed. An admitted stream is governed by
its existing total/idle/first-token deadlines, active-execution capacity, AbortSignal,
Safety checks, and backpressure. It cannot be converted into a mid-stream JSON 429.

## 5. Identity and privacy boundary

### 5.1 Unauthenticated network key

Use `request.socket.remoteAddress` with default Express proxy trust disabled.
Normalize an IPv4-mapped IPv6 address to IPv4 and normalize equivalent IPv6 text
forms before keying. Do not accept `X-Forwarded-For`, `Forwarded`, a user-supplied
header, email, account ID, request ID, or URL as an unauthenticated limiter key.

The normalized network address is personal/security data. It exists only inside the
bounded process-memory store, is never persisted or added to Audit, and is not
included in application/security logs or responses. It is not described as
anonymous. No address-derived hash or long-lived browser fingerprint is added.

Default proxy trust is safe against header spoofing but causes all clients behind a
reverse proxy to appear as that proxy. Before a production proxy is used, operators
must select and validate an exact trusted-hop/network configuration and retest
IPv4/IPv6 handling. That production decision is deliberately not guessed here.

Shared NATs can make each applicable network-lane bucket affect several legitimate
users. Network buckets should therefore be broad and defensive, while authenticated
principal policies provide the tighter control after Session validation.

### 5.2 Authenticated keys

After successful Session validation, use the internal `userId` or
`staffPrincipalId`. Never use raw Session/Cookie/CSRF values. Policy-group prefixes
keep Staff, user, control, credential, and new-work counters separate. No limiter
key is emitted to logs, metrics, errors, or headers.

The initial credential policy deliberately does not key by normalized email. That
avoids retaining an email-derived key and avoids giving one attacker a direct
per-account lockout primitive. It leaves distributed account-targeted guessing as a
production edge/identity-protection limitation.

## 6. Route and policy matrix

The values below are Development/Test starting fixtures, not production-safe
thresholds, free-tier policy, or capacity evidence. Production values require load
testing and deployment-topology review.

| Policy                 | Development/Test starting fixture | Identity                              | Purpose                                                                                  |
| ---------------------- | --------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------- |
| `network_standard`     | capacity 60; refill 2/second      | normalized direct socket address      | Pure public/general/new-work route ingress                                               |
| `network_control`      | capacity 20; refill 1/3 seconds   | normalized direct socket address      | Pure logout, delete, withdrawal, and authoritative-read route ingress                    |
| `network_mixed_probe`  | capacity 20; refill 1/3 seconds   | normalized direct socket address      | Fixed ingress for POST routes whose new/recovery purpose needs a server lookup           |
| `public_read`          | capacity 30; refill 1/second      | network                               | Registration requirements and other low-cost public reads                                |
| `user_credential`      | capacity 5; refill 1/30 seconds   | network                               | Ordinary login attempts                                                                  |
| `registration`         | capacity 3; refill 1/60 seconds   | network                               | Age-verification/hash/registration attempts                                              |
| `staff_credential`     | capacity 3; refill 1/60 seconds   | network                               | Staff login attempts, only when Admin HTTP is eligible                                   |
| `classification_probe` | capacity 12; refill 1/3 seconds   | authenticated user                    | Minimum owner-scoped operation/turn lookup on mixed routes                               |
| `principal_general`    | capacity 60; refill 1/second      | authenticated user or Staff principal | Ordinary authenticated reads and bounded writes                                          |
| `ai_new_work`          | capacity 2; refill 1/15 seconds   | authenticated user                    | New persistent/Incognito AI requests and Incognito context creation                      |
| `staff_sensitive`      | capacity 30; refill 1/2 seconds   | Staff principal                       | Audited Risk/Queue/Knowledge/Audit/AI metadata reads and normal workflow mutations       |
| `control_recovery`     | capacity 20; refill 1/3 seconds   | authenticated principal               | Logout, withdrawal, context end, privacy deletion, and authoritative result confirmation |

The credential semaphore starts at four total concurrent HTTP Argon2 pipelines in
Development/Test. The value is based only on the current Argon2id configuration's
material CPU/memory cost and is not a production sizing result.

### 6.1 Fixed-purpose routes

| Route family                                                                                   | Ingress and downstream policy                                           | Notes                                                                                                      |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `GET /health`                                                                                  | none in application                                                     | Keep liveness cheap; deployment ingress must protect connection floods                                     |
| `GET /auth/registration-requirements`                                                          | `network_standard + public_read`                                        | No account lookup                                                                                          |
| `POST /auth/login`                                                                             | `network_standard + user_credential + credential semaphore`             | Known and unknown email receive identical admission                                                        |
| `POST /auth/register`                                                                          | `network_standard + registration + credential semaphore`                | Network rejection precedes age provider; credential rejection precedes hash and writes                     |
| `POST /admin/auth/login`                                                                       | `network_standard + staff_credential + credential semaphore`            | Existing Admin-enabled and exact-Origin checks remain mandatory                                            |
| `POST /admin/staff-principals`                                                                 | `network_standard + staff_sensitive + credential semaphore`             | Covers the pre-transaction hash, including eventual `no_change`; permission and Audit remain authoritative |
| Ordinary authenticated GET or bounded create/update/save                                       | `network_standard + principal_general`                                  | Session precedes principal keying; CSRF/ownership/revision remain unchanged                                |
| `POST /incognito-contexts`                                                                     | `network_standard + ai_new_work` plus existing Consent/context capacity | Rejection precedes context allocation                                                                      |
| `GET /auth/session`, `GET /admin/auth/session`, and `GET /consents`                            | `network_control + control_recovery`                                    | Fixed authoritative state routes; Auth and private/no-store behavior remain                                |
| `GET /conversations/:id/messages`                                                              | `network_control`; v1 `principal_general`, strict v2 `control_recovery` | Existing capability parsing, ownership, one-view history, and 406 guard remain                             |
| Mood `creation-status` and `GET /mood-entries/:id`                                             | `network_control + control_recovery`                                    | Fixed authoritative rereads; `absent` is never rollback proof                                              |
| Fixed Staff exact-status reads                                                                 | `network_control + control_recovery`                                    | Existing permission and mandatory access Audit remain                                                      |
| User/Staff logout, Incognito end, Conversation/Mood single/delete-all                          | `network_control + control_recovery`                                    | Existing Auth, CSRF, ownership, transaction, and unknown-result semantics remain                           |
| Staff disable, role revoke, and session revoke                                                 | `network_control + control_recovery`                                    | Authority reduction does not share ordinary Staff editorial/read capacity                                  |
| Staff Risk/Queue/Knowledge/Audit/AI reads and normal workflow mutations not listed as recovery | `network_standard + staff_sensitive`                                    | Mandatory service authorization and access/mutation Audit remain                                           |

The fixed Staff status reads in the recovery row are
`GET /admin/auth/session`, `GET /admin/staff-principals/:id`, and the existing
Knowledge exact-version `status` and `publication-state` routes. Staff directory
lists, drafts, review candidates, Risk/Queue, Audit, and AI-quality reads remain
`staff_sensitive`. A recovery-classified sensitive read still returns nothing
unless its existing required Audit commits.

All `GET /conversations/:id/messages` requests use the fixed control ingress because
the route is recovery-capable. After the existing strict capability parser, v2 uses
control/recovery capacity because its body-plus-reference history is the accepted
grounded reconciliation source; v1 remains a general history read. The capability
changes an actual response contract and is not a free-form `recovery=true` claim.
No hidden intent flag changes the lane. Likewise `GET /mood-entries/:id` is fixed as
authoritative reread capacity whether it follows an unknown mutation or ordinary
navigation. These are deliberate conservative classifications, not unlimited
exemptions.

### 6.2 Mixed POST classification

| Request/result                                   | Before lookup                                                                  | Minimum server lookup                                | After lookup                                                                                  |
| ------------------------------------------------ | ------------------------------------------------------------------------------ | ---------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `POST /consents`, any body                       | `network_mixed_probe`; Auth; CSRF; strict action union; `classification_probe` | owned `(userId, operationId)`                        | See the four Consent rows below                                                               |
| Consent exact semantic operation exists          | as above                                                                       | operation and normalized semantic equality           | `control_recovery`, then existing replay-first coordinator/repository path                    |
| Consent same operation ID, different semantics   | as above                                                                       | operation and normalized semantic equality           | typed Consent conflict; no acceptance/withdrawal token and no durable side effect             |
| Consent operation absent, `accept`               | as above                                                                       | absence at that read instant                         | `principal_general` before Registry/revision validation and mutation                          |
| Consent operation absent, `withdraw`             | as above                                                                       | absence at that read instant                         | `control_recovery` before dependency preparation and mutation                                 |
| `POST /ai/chat/stream`, any strict union variant | `network_mixed_probe`; Auth; CSRF; strict mode union; `classification_probe`   | persistent: owned `clientRequestId`; Incognito: none | See the three AI rows below                                                                   |
| Persistent matching AI Turn exists               | as above                                                                       | owner-scoped turn identity only                      | `control_recovery`, then current orchestration and its repeated binding/owner/status checks   |
| Persistent matching AI Turn absent               | as above                                                                       | absence at that read instant                         | `ai_new_work` before orchestration; a bound missing Conversation still fails without creation |
| Incognito variant                                | as above                                                                       | no replay lookup or recovery claim                   | `ai_new_work`; existing context/request idempotency remains authoritative                     |

The classification query has its own finite principal and key-storage budget. It
does not use `control_recovery`, so an ordinary classification miss cannot spend
control tokens. A concurrent operation/turn can commit after the lookup; the
existing transaction/unique constraint resolves that race. The HTTP layer does not
turn an absence into proof of rollback or permission to reconstruct a deleted
resource.

A mixed-ingress rejection occurs before Session/database work. A classification-
probe rejection occurs before the owner-scoped lookup. A selected downstream-policy
rejection occurs after that read but before `ConsentsService.mutate`,
`registerPending`, `preparePersistentTurn`, Conversation/turn/context creation,
Registry/revision mutation, quota, Safety classification, or Provider dispatch.
Thus the lookup is the only business read allowed before final admission and it has
no durable side effect.

The mixed ingress and classification lane can themselves be saturated by traffic
sent directly to those mixed routes. That returns bounded 429 and may temporarily
prevent both new and recovery uses of that route. The guarantee is narrower:
ordinary standard-route tokens or key allocation cannot consume the reserved
control or mixed-route pools. No single-process application design guarantees
control availability against a direct attack on the control/mixed route, shared-NAT
pressure, connection exhaustion, or multi-instance traffic.

## 7. Token bucket and bounded memory contract

Each fixed policy owns a map of identity key to:

```text
tokens
lastRefillMonotonic
lastSeenMonotonic
```

Use `performance.now()` or `process.hrtime.bigint()` for refill/expiry calculations,
not wall-clock time. Wall-clock changes therefore do not mint or remove tokens.
Refill is lazy and capped at capacity. One admitted HTTP request consumes one token;
no token is refunded based on response status, because status-dependent refunds
would leak account validity and encourage retry amplification.

Configuration is strictly parsed at startup. Capacity, refill interval, entry TTL,
per-policy key cap, the checked sum of all key caps, and credential concurrency are
positive bounded integers with cross-field validation. Invalid configuration fails
startup. Proposed implementation variables use an `HTTP_RATE_LIMIT_*` prefix; exact
names should stay few and map only to the fixed code-owned policies.

Entries whose buckets are full and idle beyond the configured TTL are removable.
Cleanup uses an unref'd timer plus an opportunistic bounded sweep; it never performs
an unbounded full-map scan on every request. Shutdown clears timers/maps. Every
permit and abort listener is released in `finally`.

The first implementation uses hard map partitions. `network_standard`,
`network_control`, `network_mixed_probe`, `classification_probe`, and each
downstream policy have independent key caps. The process-wide maximum is the
startup-validated sum of those caps, not a first-come shared map that standard
traffic can fill. If a later implementation adds a lower outer cap, it must reserve
the full configured control and mixed-route partitions before admitting standard
keys.

When one policy's key cap is full, an unknown new key for that policy is rejected
with `RATE_LIMITED`; existing keys continue under their buckets. Entries are not
evicted merely to admit a new key, because eviction would let address churn reset
limits. Ordinary policies cannot borrow reserved control/mixed keys or tokens. If a
control, mixed, or classification lane itself is saturated, it also returns a
temporary 429 rather than becoming an unlimited bypass.

There is no generic `catch { allow }`. Expected saturation returns 429. Invalid
configuration fails startup, and unexpected internal errors fail the request
without starting new work. Independent control capacity prevents unrelated normal
traffic from consuming its reservation; it does not promise that a saturated
control/mixed lane can always terminate or recover. Distributed and direct
control-route exhaustion remain production edge problems.

### 7.1 Credential-work permit lifecycle

`CredentialWorkAdmission.run(signal, startArgon2)` has four explicit states:

1. If the non-queued semaphore has no permit, return 429 without calling the
   password hasher. If the request is already aborted, terminate without acquiring
   a permit or starting work.
2. After acquiring a permit, recheck the HTTP lifecycle signal and invoke the
   Argon2 thunk synchronously. If cancellation won before invocation, return the
   permit without starting Argon2.
3. Once `hash`, `verify`, or the real work inside `verifyDummy` has started, its
   underlying Promise owns the permit until it actually settles. The current Argon2
   API accepts no `AbortSignal`; an HTTP disconnect or deadline suppresses later
   Session/cookie/database work and response delivery but does not cancel the native
   calculation. The implementation must not `Promise.race` abort against Argon2 and
   release the permit from the losing request while that work continues.
4. Underlying success or failure releases the permit exactly once in `finally`,
   removes request abort/close listeners, then propagates the result only if the
   request remains usable. If cancellation is observed before the downstream step
   starts, no Session, registration, or Staff-principal transaction starts.

An HTTP-scoped AbortSignal is derived from the request/response lifecycle and a
bounded endpoint deadline. It is not passed to Argon2 as if cancellation were
supported. If a later disconnect races after a downstream database operation has
started, existing transaction/idempotency rules decide its outcome; response
closure is not proof of rollback or non-commit.

All HTTP paths that can invoke `PasswordHasherService.hash`, `verify`, or
`verifyDummy` use this one admission component:

- `POST /auth/register` and `POST /auth/login`;
- `POST /admin/auth/login`; and
- `POST /admin/staff-principals`, whose current service hashes the initial password
  before transaction authorization and before discovering an idempotent
  `no_change` result.

The Staff-principal path therefore consumes both Staff-sensitive request capacity
and a credential permit before its current transaction semantics run. The limiter
does not change Staff permission checks, caller-generated principal ID behavior,
`no_change`, or mandatory Audit. Startup construction of the single dummy hash and
the restricted offline Staff bootstrap are not HTTP requests; they remain explicit
one-off scopes and do not justify refactoring the CLI. Test seed commands that call
Argon2 directly remain protected by their existing test-only database/environment
guards rather than by an HTTP limiter.

Process restart clears every bucket and semaphore. Multiple API instances each
enforce only their own counters. These are explicit guarantees, not implementation
bugs to hide behind a database table.

## 8. Domain lifecycle preservation

- A locally rate-limited new request creates no Conversation, Message, AI Turn,
  Mood entry, Consent decision, Incognito context/generation, Risk Event, Review
  Queue item, domain Audit row, quota ledger row, or Provider/classifier call.
- `QUOTA_EXCEEDED` remains the daily AI product policy computed by PostgreSQL and
  Asia/Shanghai time. `RATE_LIMITED` means transient request/capacity admission.
  Neither is renamed or conflated.
- Quota exhaustion continues to allow the existing bounded Safety assessment and
  deterministic HIGH/CRITICAL response behavior when the AI request itself is
  admitted. Rate limiting does not inspect message text or attempt a risk exemption.
- A request rejected before AI admission has no RiskDecision. The client must not
  claim that Safety checked it or that a crisis service is monitoring it.
- Consent exact replay, no-change receipt, expected revision, unknown-result, and
  dependency-scoped cancellation retain ADR-016 semantics. A limiter does not
  invent a replacement operation ID.
- Mood `creation-status`, persistent bound-conversation recovery, and Incognito
  lost-context behavior retain their domain-specific meanings. The client must not
  turn 429 into an automatic state-changing POST.
- Disconnect/cancel of an already active SSE stream remains an AbortSignal event and
  is never charged against a new HTTP control bucket. Existing quota refund rules
  remain unchanged.
- Staff rate rejection occurs before a sensitive service result and therefore does
  not create a resource-access Audit row. Successful sensitive access continues to
  require its transactional Audit. A high-volume rejection must not amplify load by
  inserting an Audit row per attempt.

## 9. Public response and client contract

Reuse the existing JSON error body:

```json
{
  "success": false,
  "error": {
    "code": "RATE_LIMITED",
    "message": "请求过于频繁，请稍后重试"
  }
}
```

For the local token bucket, set `Retry-After` to the ceiling of the seconds until
the next token, with a minimum of 1 and a bounded maximum. Add `Retry-After` to the
CORS exposed-header allowlist so an allowed browser origin can read it. Continue
`Cache-Control: private, no-store`. Do not return capacity, current token count,
network/principal key, another user's state, provider identity, or internal policy
configuration.

An active-concurrency rejection has no exact release time. It may use a small
bounded `Retry-After` hint documented as advisory, or omit the header; it must not
fabricate an exact completion time. Provider 429 and local 429 may share the public
`RATE_LIMITED` code to avoid exposing provider internals, while fixed operational
categories distinguish them internally. `QUOTA_EXCEEDED` remains separately
actionable and must not receive a misleading short `Retry-After` from this limiter.

A 429 returned before a mutation reaches its coordination boundary is a confirmed
non-start only when the client actually receives that response. A connection loss
is still an unknown result and uses the existing domain-specific recovery rule.

## 10. Operational logging and Audit

Add one typed security-log method accepting only:

```text
event = http_rate_limited
policyGroup = bounded code-owned enum
identityKind = network | user | staff
reason = token_exhausted | key_capacity | concurrency_capacity
```

Do not log the network address, user/staff ID, email, raw URL/path, query, Session,
Cookie, CSRF token, request body, message, prompt, article identity, Mood value, or
arbitrary error. Aggregate metrics can be designed later; the ordinary log must not
become a per-user behavior database.

Do not persist HTTP-limit decisions in `audit_logs`. Audit remains for accountable
domain/staff actions, and mandatory sensitive-read Audit remains inside its current
transaction. The limiter's fixed log category is operational evidence only.

## 11. Schema, dependency, and rollout impact

The proposed first implementation needs:

- no PostgreSQL schema or migration;
- no new public endpoint: Consent exact replay and persistent turn metadata replay
  continue to use their existing POST contracts and existing owner/binding rules;
- no Redis, queue, external service, or browser storage;
- no new runtime package if implemented with Nest guards/interceptors and Node
  primitives;
- validated environment configuration and `.env.example` documentation;
- one small module, fixed policy metadata, bounded store, credential semaphore,
  typed logging, and tests; and
- a narrow CORS exposure change for `Retry-After`.

Rollout order:

1. partitioned bounded store, identity resolver, configuration, and unit tests;
2. standard/control/mixed ingress guards and mixed classification probe;
3. public credential/registration guards and credential lifecycle wrapper;
4. authenticated user/control routes and AI pre-admission integration;
5. Staff-sensitive/control routes, including Staff-principal password work;
6. privacy/logging, lifecycle, and full regression tests.

Rollback disables only the new admission module in Development/Test after stopping
traffic; Staging/Production must not silently start with rate limiting disabled once
the control is declared a readiness requirement. Existing Quota, context, active
execution, Consent, authorization, and Safety controls remain installed either way.

## 12. Acceptance plan

### 12.1 Unit and configuration

- exact capacity, refill, burst, fractional elapsed time, and `Retry-After` using a
  fake monotonic clock;
- wall-clock jumps do not affect tokens;
- identity/policy namespaces do not collide;
- direct address, IPv4-mapped IPv6, malformed/missing address, and untrusted
  forwarded headers;
- exhaust `network_standard` tokens and key slots while reserved control and mixed
  ingress tokens/slots remain usable; exhaust each reserved lane and receive its
  own bounded 429;
- bounded key capacity, startup-validated aggregate bound, expired-entry cleanup,
  no eviction bypass, and timer shutdown;
- forged forwarded headers, request actions, capability headers, or informal
  "recovery" markers never choose an unlimited route or avoid strict parsing; and
- invalid/disabled production configuration fails closed as designed.

### 12.2 Authentication and privacy

- known user, unknown user, and wrong password consume identical login admission
  and expose no account distinction;
- a network/route rejection of login/register/staff-login performs no account/age
  provider, Argon2, Session, or persistence work; a credential-capacity rejection
  performs no Argon2 or later side effect, although registration's already-finished
  age-provider call is not undone;
- rejected Staff-principal creation performs zero Argon2 and no permission,
  transaction, or Audit work; an admitted request still enforces existing Staff
  permission and Audit behavior;
- one source cannot allocate unbounded email-derived keys;
- response/log snapshots contain no address, email, password, Session/Cookie/CSRF,
  body, psychological text, or limiter key;
- trusted Origin, CSRF, Session, ownership, and Staff permission checks remain
  independently enforced.

### 12.3 Domain and lifecycle

- rejected new persistent AI request creates no Conversation/AI Turn/Message,
  consumes no quota, and calls neither Risk classifier nor generation/output
  Provider;
- an already-started SSE is not interrupted by later bucket exhaustion and never
  receives a JSON 429 after headers;
- existing active-execution global/per-user capacity maps to bounded 429 and always
  releases on completion/cancel/timeout;
- quota exhausted remains `QUOTA_EXCEEDED`, and an admitted HIGH/CRITICAL request
  retains its deterministic Safety behavior;
- rejected Incognito context creation allocates no context; control-lane end still
  aborts/removes an existing context;
- for Consent mutation, cover a missing operation, exact operation replay, same ID
  with different normalized semantics, two concurrent first submissions, and
  classification-probe exhaustion; only the server lookup selects the downstream
  policy and exact replay retains its operation ID and receipt semantics;
- ordinary acceptance saturation does not consume control/recovery tokens, while
  direct mixed/classification/control saturation returns an honest bounded 429;
- for persistent AI, cover existing and absent `clientRequestId`, concurrent misses,
  bound deleted Conversation, and unbound creation-capable continuation; recovery
  never creates a replacement Conversation/turn or calls a Provider;
- with the active execution registry full, an admitted existing-turn POST receives
  the current bounded capacity failure rather than a false recovery guarantee; no
  second AI semaphore is introduced;
- logout, Staff revoke/disable, privacy delete, Mood confirmation, and authoritative
  recovery remain available under a saturated new-work policy and remain bounded by
  their own lane;
- no automatic mutation replay is added after 429 or network uncertainty.

### 12.4 Concurrency and integration

- barrier-controlled simultaneous consumes never exceed a bucket's admitted count;
- a controlled Promise/barrier keeps Argon2 work unresolved while requests are
  cancelled: actually running `hash`, `verify`, and dummy-verify operations never
  exceed the global permit count, and no permit returns until the underlying work
  settles;
- success, Argon2 failure, request cancellation, and response closure each return a
  permit exactly once and remove listeners; a cancelled completed calculation does
  not start Session, cookie, registration, or Staff persistence work when the abort
  is observed before that downstream boundary;
- ordinary registration/login, Staff login, and Staff-principal creation—including
  its eventual `no_change` path—share the same credential concurrency bound and
  have no waiting queue;
- key-capacity and cleanup races do not exceed the configured map bound;
- different users/Staff/network sources do not share principal buckets, while one
  shared NAT intentionally shares each applicable network-lane bucket;
- all existing Persistent/Incognito, Consent, Quota, Safety, Mood, Knowledge, Staff,
  Audit, and Chromium regressions remain green using synthetic data only.

No acceptance result is a volumetric penetration test, production threshold proof,
real-provider evaluation, or clinical/safety guarantee.

## 13. Decisions required before implementation

Accepting this proposal would approve only:

1. process-local bounded token buckets plus a non-queued credential semaphore for
   the current single-process Development/Test target;
2. direct normalized socket address as the ephemeral unauthenticated key, with no
   forwarded-header trust until deployment topology is separately approved;
3. hard-partitioned standard, control, and mixed-route ingress maps, followed by a
   bounded server-side classification probe and independently budgeted but not
   unlimited control/recovery lane;
4. retaining the current AI/Consent lifecycle limits, including that persistent
   metadata replay can still receive 429 while `ActiveAiExecutionRegistry` is full,
   rather than adding another AI semaphore or recovery API; and
5. reuse of `RATE_LIMITED` plus optional/advisory `Retry-After`, without a new error
   code or persistent operation ledger.

The example thresholds are implementation fixtures and may be tuned through strict
configuration without changing product quota policy. A material change to the
identity source, persistence, cross-instance guarantee, or exemption semantics
requires review.

If recovery must succeed while the current AI registry is saturated, that is a
separate architecture decision: it requires either reordering the existing-turn and
Consent checks or adding a read-only recovery endpoint. Either option must be
reviewed against ADR-013, ADR-016, and ADR-019 before implementation. This proposal
recommends accepting the bounded 429 limitation for the current local/demo target.

## 14. Production-only blockers

- trusted reverse-proxy topology and safe client-address derivation;
- privacy review of ephemeral network-address processing and operational retention;
- load/capacity testing to select production thresholds and Argon2 concurrency;
- edge protection for connection, TLS, slow-body, and volumetric attacks;
- multi-instance/global enforcement decision, potentially using infrastructure not
  authorized by this proposal;
- distributed credential-abuse strategy without account-targeted denial of service;
- production monitoring/alert aggregation without user-level behavior logs; and
- confirmation that rate limiting and every existing Production Safety readiness
  requirement are enabled in the deployed configuration.

Current rollout state remains unchanged: `ADMIN_AUTH_ENABLED=false`,
`AI_KNOWLEDGE_ENABLED=false`, Production Safety Lock Enforced, Production AI Chat
Disabled, `productionSafe=false`, and Real Model Safety Evaluation Not Evaluated.
The three candidate Knowledge articles remain unverified and unpublished.
