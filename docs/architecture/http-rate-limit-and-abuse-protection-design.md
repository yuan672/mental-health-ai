# Minimum HTTP Rate Limiting and Abuse Protection Backend Design

- Status: Proposed engineering design; not implemented
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

Use one `HttpAbuseProtectionModule` with three narrow components:

1. `NetworkRateLimitGuard` applies an early, coarse token bucket keyed by a
   normalized direct socket address and a fixed policy group. It executes before
   credential verification, Session/database lookup, or Provider work. Nest has
   already accepted and parsed the HTTP request at this point, so deployment-layer
   connection/body protection remains separate.
2. `PrincipalRateLimitGuard` applies after successful user/Staff Session validation
   and, for mutations, after the existing Origin/CSRF guards. It uses only the
   authenticated internal principal ID and a fixed policy group.
3. `CredentialWorkAdmission` is a small, non-queued global semaphore shared by
   ordinary and Staff registration/login password work. It protects Argon2 memory
   and CPU independently of request rate. A permit is released in `finally`.

The two guards share a bounded `ProcessLocalTokenBucketStore`. Policy selection is
code-owned metadata, never a raw path or client-provided policy name. A route may
consume both a coarse network bucket and a principal bucket. The store operation is
synchronous with no `await` between read, refill, and consume, which makes it atomic
within one Node.js event loop.

Do not add another AI semaphore. The existing `ActiveAiExecutionRegistry` already
bounds complete AI executions globally and per user, carries the total deadline,
and releases on terminal cleanup. Its capacity errors should be translated through
the same fixed `RATE_LIMITED` boundary rather than leaking as generic 500 errors.

### 4.1 Request order

The common order is:

```text
coarse network admission
→ existing Admin-enabled / trusted-Origin checks where applicable
→ existing Session authentication
→ existing CSRF validation for cookie-authenticated mutations
→ principal or action-specific admission
→ Zod/application validation not already completed
→ ownership / finite Staff permission
→ existing domain transaction or AI lifecycle
```

Rate limiting never establishes identity, ownership, Consent, or permission. It
must not return protected resource existence or another principal's bucket state.

For login and registration, the coarse/credential policy runs before account lookup
and before real or dummy Argon2 work. Valid and invalid identifiers consume the same
admission unit and receive the same `RATE_LIMITED` response when rejected.

For action-discriminated Consent mutation, strict request validation occurs before
choosing the action lane. The existing operation lookup remains before current
Registry/revision business validation. An exact already-committed replay uses the
recovery lane; a new acceptance uses ordinary mutation capacity; a withdrawal uses
the control lane. A same-ID/different-operation conflict remains a Consent conflict,
not a way to choose another rate key.

For persistent AI, the existing owner-scoped `clientRequestId` lookup remains the
first business lookup. An existing turn may return metadata through recovery
capacity. A new request consumes the AI-start bucket before creating a Conversation
or turn, persisting a Message, consuming quota, invoking Risk Detection, or starting
a Provider. The temporary pending execution registration is disposed on rejection.
Concurrent requests that race before the first turn exists may each consume an
admission token, but database idempotency still permits only one logical turn and
Provider path.

For Incognito AI, consume AI-start capacity before `claimGeneration`; rejection
must not add the client request ID to the context or create a generation claim.
Existing context-loss and duplicate-request semantics then remain authoritative.

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

Shared NATs can make a coarse network bucket affect several legitimate users. The
network bucket should therefore be broad and defensive, while authenticated
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

| Policy              | Development/Test starting fixture | Identity                              | Purpose                                                                                  |
| ------------------- | --------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------- |
| `network_coarse`    | capacity 60; refill 2/second      | normalized direct socket address      | Broad safety net shared by all non-health HTTP routes                                    |
| `public_read`       | capacity 30; refill 1/second      | network                               | Registration requirements and other low-cost public reads                                |
| `user_credential`   | capacity 5; refill 1/30 seconds   | network                               | Ordinary login attempts                                                                  |
| `registration`      | capacity 3; refill 1/60 seconds   | network                               | Age-verification/hash/registration attempts                                              |
| `staff_credential`  | capacity 3; refill 1/60 seconds   | network                               | Staff login attempts, only when Admin HTTP is eligible                                   |
| `principal_general` | capacity 60; refill 1/second      | authenticated user or Staff principal | Ordinary authenticated reads and bounded writes                                          |
| `ai_new_work`       | capacity 2; refill 1/15 seconds   | authenticated user                    | New persistent/Incognito AI requests and Incognito context creation                      |
| `staff_sensitive`   | capacity 30; refill 1/2 seconds   | Staff principal                       | Audited Risk/Queue/Knowledge/Audit/AI metadata reads and normal workflow mutations       |
| `control_recovery`  | capacity 20; refill 1/3 seconds   | authenticated principal               | Logout, withdrawal, context end, privacy deletion, and authoritative result confirmation |

The credential semaphore starts at four total concurrent Argon2/registration
pipelines in Development/Test. The value is based only on the current Argon2id
configuration's material CPU/memory cost and is not a production sizing result.

| Route family                                           | Required policy after existing guards                                | Notes                                                                                 |
| ------------------------------------------------------ | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `GET /health`                                          | none in application                                                  | Keep liveness cheap and available; deployment ingress must protect connection floods  |
| `GET /auth/registration-requirements`                  | `network_coarse + public_read`                                       | No account lookup                                                                     |
| `POST /auth/login`                                     | `network_coarse + user_credential + credential semaphore`            | Same admission for known/unknown email                                                |
| `POST /auth/register`                                  | `network_coarse + registration + credential semaphore`               | Rejection precedes age provider, password hash, and writes                            |
| `POST /admin/auth/login`                               | `network_coarse + staff_credential + credential semaphore`           | Existing Admin-enabled and exact-Origin checks remain mandatory                       |
| Ordinary authenticated GET                             | `network_coarse + principal_general`                                 | Session validation precedes principal keying; ownership remains in service/repository |
| Ordinary create/update/save                            | `network_coarse + principal_general`                                 | Existing CSRF and domain idempotency/revision remain unchanged                        |
| New `POST /ai/chat/stream` work                        | `network_coarse + ai_new_work` plus existing active-execution limits | Before durable creation, quota, classifier, or Provider; no mid-stream limiting       |
| `POST /incognito-contexts`                             | `network_coarse + ai_new_work` plus existing context capacity        | Before allocating the context                                                         |
| Logout and `DELETE /incognito-contexts/:id`            | `network_coarse + control_recovery`                                  | Independent of exhausted new-work/general buckets                                     |
| Consent exact replay/withdrawal                        | `network_coarse + control_recovery`                                  | Replay lookup and dependency-scoped cleanup semantics remain ADR-016                  |
| Mood `creation-status` and authoritative rereads       | `network_coarse + control_recovery`                                  | Read-only; never converts `absent` into rollback proof                                |
| Conversation/Mood delete and delete-all                | `network_coarse + control_recovery`                                  | Still Auth/CSRF/owner-scoped; no automatic mutation retry                             |
| Staff logout, disable, role revoke, or revoke-sessions | `network_coarse + control_recovery`                                  | Authority-reducing operations do not share exhausted editorial/read capacity          |
| Staff sensitive reads/workflow                         | `network_coarse + staff_sensitive`                                   | Existing service authorization and mandatory access/mutation Audit remain             |

`GET /auth/session` and `GET /admin/auth/session` use a broad network policy before
authentication and principal-general capacity after success. Unknown-result
recovery routes still have finite limits; the separate refillable lane prevents a
new-work storm from permanently consuming their capacity. There is no unlimited
exemption.

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
per-policy key cap, global key cap, and credential concurrency are positive bounded
integers with cross-field validation. Invalid configuration fails startup. Proposed
implementation variables use an `HTTP_RATE_LIMIT_*` prefix; exact names should stay
few and map only to the fixed code-owned policies.

Entries whose buckets are full and idle beyond the configured TTL are removable.
Cleanup uses an unref'd timer plus an opportunistic bounded sweep; it never performs
an unbounded full-map scan on every request. Shutdown clears timers/maps. Every
permit and abort listener is released in `finally`.

When a per-policy or global key cap is full, an unknown new key is rejected with
`RATE_LIMITED`; existing keys continue under their buckets. Entries are not evicted
merely to admit a new key, because eviction would let address churn reset limits.
The `control_recovery` map has independently reserved capacity and cannot be filled
by credential, general, AI, or Staff-sensitive keys. If that lane itself is
saturated, it also returns a temporary 429 rather than becoming an unlimited
bypass.

There is no generic `catch { allow }`. Expected saturation returns 429. Invalid
configuration fails startup, and unexpected internal errors fail the request
without starting new work. Independent control capacity and finite refill protect
normal termination availability; distributed exhaustion remains a production edge
problem.

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
- no Redis, queue, external service, or browser storage;
- no new runtime package if implemented with Nest guards/interceptors and Node
  primitives;
- validated environment configuration and `.env.example` documentation;
- one small module, fixed policy metadata, bounded store, credential semaphore,
  typed logging, and tests; and
- a narrow CORS exposure change for `Retry-After`.

Rollout order:

1. bounded store, identity resolver, configuration, and unit tests;
2. public credential/registration guards and credential semaphore;
3. authenticated user/control routes and AI pre-admission integration;
4. Staff-sensitive/control routes;
5. privacy/logging, lifecycle, and full regression tests.

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
- bounded key capacity, expired-entry cleanup, no eviction bypass, timer shutdown,
  and semaphore release on success/error/AbortSignal;
- invalid/disabled production configuration fails closed as designed.

### 12.2 Authentication and privacy

- known user, unknown user, and wrong password consume identical login admission
  and expose no account distinction;
- rejected login/register/staff-login calls perform zero real/dummy Argon2,
  age-provider, Session, or persistence work;
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
- Consent acceptance saturation does not consume the independent withdrawal/replay
  lane; exact replay retains its operation ID and receipt semantics;
- logout, Staff revoke/disable, privacy delete, Mood confirmation, and authoritative
  recovery remain available under a saturated new-work policy and remain bounded by
  their own lane;
- no automatic mutation replay is added after 429 or network uncertainty.

### 12.4 Concurrency and integration

- barrier-controlled simultaneous consumes never exceed a bucket's admitted count;
- credential concurrency never exceeds its global limit and has no waiting queue;
- key-capacity and cleanup races do not exceed the configured map bound;
- different users/Staff/network sources do not share principal buckets, while one
  shared NAT intentionally shares the coarse network bucket;
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
3. fixed code-owned route policies and an independently budgeted but not unlimited
   control/recovery lane; and
4. reuse of `RATE_LIMITED` plus optional/advisory `Retry-After`, without a new error
   code or persistent operation ledger.

The example thresholds are implementation fixtures and may be tuned through strict
configuration without changing product quota policy. A material change to the
identity source, persistence, cross-instance guarantee, or exemption semantics
requires review.

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
