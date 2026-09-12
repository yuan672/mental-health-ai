# ADR-021: Minimum HTTP Rate Limiting and Abuse Protection

- Status: Accepted
- Date: 2026-09-12
- Accepted scope: bounded single-process HTTP admission for Development/Test,
  partitioned standard/control/mixed capacity, and non-queued HTTP Argon2 work
  admission; production thresholds, proxy trust, cross-instance enforcement, and
  production enablement remain unapproved
- Related: ADR-007, ADR-009, ADR-011 through ADR-020
- Supersedes: None

## Context

HANDOFF section 35 requires Rate Limit. The backend already has PostgreSQL AI quota,
AI active-execution limits, Consent coordination bounds, Incognito context bounds,
and provider-429 handling, but these do not limit general HTTP request frequency or
concurrent Argon2 work.

The current product target is a single API process for local learning/demo. The
design must reduce accidental loops and short-burst abuse without persisting network
identifiers, adding an email-derived lockout key, or prematurely introducing Redis,
a queue, or a distributed rate-limit service. It must also preserve access to
bounded logout, Consent withdrawal, Incognito end, deletion, and unknown-result
confirmation paths.

## Proposed decision

### Process-local admission

Use bounded in-memory token buckets driven by a monotonic clock. A synchronous
consume operation is atomic within the Node.js event loop. Every policy has a fixed
code-owned key, capacity/refill configuration, idle TTL, and bounded key count.
Hard-partition standard, control, and mixed-route ingress token/key capacity. The
process maximum is the validated sum of partitions, not a first-come map that
ordinary traffic can fill. Expired cleanup is bounded and timers are released at
shutdown. Process restart resets counters; multiple instances do not share them.

Add a non-queued global credential-work semaphore around every HTTP-reachable
Argon2 operation: ordinary registration/login, Staff login, and Staff-principal
creation. Once native work starts, it owns the permit until its actual Promise
settles; request cancellation suppresses downstream work but cannot release the
permit early because the current hasher accepts no `AbortSignal`. Startup dummy-hash
initialization and restricted offline bootstrap remain separate explicit scopes.

Do not add another AI semaphore: retain the existing `ActiveAiExecutionRegistry`
and map its capacity failures to the bounded public `RATE_LIMITED` contract.

### Identity boundary

Before authentication, key only by a normalized direct socket address. Do not trust
forwarded headers by default and do not key by email, raw Session/Cookie/CSRF,
client-supplied identifier, raw path, URL, or message content. After authentication,
key by the internal user or Staff principal ID in a separate policy namespace.

Network addresses and principal IDs remain ephemeral process-memory data and are
not logged, audited, persisted, or returned. They are not described as anonymous.
A production proxy-address trust decision is explicitly deferred.

### Policy boundary

Use a small set of fixed policies: standard network, control network, mixed-route
network probe, public read, ordinary credential, registration, Staff credential,
mixed-request classification probe, principal general, new AI work, Staff
sensitive, and control/recovery. A request may consume both network and principal
buckets.

Control/recovery capacity is independent from new-work/general capacity but is not
unlimited. It covers logout, Consent withdrawal/exact replay, Incognito end,
privacy deletion, Staff authority reduction, and fixed authoritative-result reads.
Pure control routes use the reserved control ingress. Mixed Consent/AI POST routes
use a separately reserved mixed ingress, then Auth, CSRF, strict union parsing, a
bounded owner-scoped lookup, and only then a server-selected downstream policy.
The server does not trust a client "recovery" marker. Saturation returns 429; no
route bypasses Auth, Origin, CSRF, ownership, Staff permission, or required Audit.

Standard-route traffic cannot consume control or mixed-route token/key reservations.
A direct flood of a control or mixed route can still exhaust that route's finite
lane; this design does not claim unconditional termination availability.

New AI admission occurs before durable resource creation, quota consumption, Risk
classification, or Provider dispatch. No admitted AI path skips Safety. A request
rejected before admission is not safety-assessed and must not be represented as a
crisis-service response. Once SSE begins, no HTTP limiter converts it to JSON 429;
existing deadlines, cancellation, backpressure, and Safety govern the stream.

The current persistent orchestration registers and Consent-binds an active AI
execution before it repeats the existing-turn lookup. The HTTP classifier does not
bypass that accepted lifecycle. Therefore an admitted metadata replay can still
receive bounded 429 while `ActiveAiExecutionRegistry` is full. This proposal accepts
that limitation for the local/demo target rather than adding another AI semaphore,
reordering Accepted lifecycle checks, or adding a recovery endpoint. Bound
Conversation recovery and Incognito non-replay semantics remain unchanged.
Consent exact replay likewise remains subject to ADR-016's bounded coordination
queue, deadline, and dependency-scoped cleanup; the HTTP lane is not an unlimited
shortcut around those controls.

### Response and logging

Reuse HTTP 429 `RATE_LIMITED`. It remains distinct from the daily product policy
error `QUOTA_EXCEEDED`. Local token-bucket responses include a bounded
`Retry-After` hint and expose that header to allowed browser origins. The body does
not expose policy configuration, identity keys, token state, or provider details.

Use a typed security event containing only a fixed policy group, identity kind, and
saturation reason. Do not log addresses, principal IDs, emails, URLs, request
bodies, psychological content, credentials, or arbitrary errors. Do not append one
database Audit row per rejection.

### Data and infrastructure

The initial implementation adds no database schema/migration, Redis, external
service, browser state, or runtime dependency. Strict environment configuration
controls fixed policy values. Production may not silently disable the control after
it becomes a readiness requirement.

## Consequences

### Benefits

- protects every HTTP Argon2 path and common request paths from local bursts;
- composes with existing quota, Consent, AI concurrency, Incognito, and Staff
  controls rather than replacing them;
- prevents unrelated standard traffic from consuming reserved control/mixed-route
  tokens or key slots;
- keeps limiter identity data bounded and ephemeral;
- leaves authority-reducing and recovery work separately reachable; and
- can be tested deterministically with a fake monotonic clock and synthetic data.

### Costs and limitations

- restart resets counters and each API instance enforces only its own limits;
- direct-address keying behind an unconfigured proxy can over-limit all clients;
- shared NATs share each applicable network-lane bucket;
- application guards do not protect connection/TLS/slow-body exhaustion;
- a direct control/mixed-route flood or existing AI-registry saturation can still
  return 429 on a recovery attempt; and
- no per-email key means distributed account-specific guessing still needs a
  production edge/identity strategy.

These limitations prevent a production DoS-resistance claim but are proportionate
to the current local learning/demo deployment.

## Alternatives considered

### PostgreSQL rate-limit rows

Not selected. They add hot-row write load, retention, cleanup, and network-identity
persistence to protect a single local process.

### Redis or a managed edge limiter now

Not selected without a multi-instance or deployment-platform decision. Either can
be evaluated before production without changing domain APIs.

### Email/account keyed login lockout

Not selected initially because it retains an identity-derived key and lets an
attacker deliberately lock a victim account. Network and global credential-work
limits are the bounded first step.

### Unlimited exemption for control routes

Rejected because a valid Session could turn it into an unbounded database workload.
An independent refillable lane provides availability without removing limits.

## Adoption boundary

Accepting this ADR would authorize only the bounded single-process backend control
described above and its synthetic tests, including the finite recovery limitations
and the rule that a started Argon2 Promise retains its permit until settlement. It
would not approve a persistent-turn lookup reorder or recovery API, production
thresholds, proxy trust, address-processing policy, distributed enforcement,
deployment, a real attack evaluation, Production AI, Knowledge publication, or
frontend work.
