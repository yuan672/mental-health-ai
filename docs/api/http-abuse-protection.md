# HTTP Abuse Protection Contract

- Status: implemented on `feature/http-abuse-protection-backend`; pending review
- Architecture: ADR-021
- Scope: single-process Development/Test HTTP admission

## Public response

An application request rejected by the local limiter returns the existing error
envelope with HTTP 429 and `RATE_LIMITED`. This is distinct from the product-level
daily AI result `QUOTA_EXCEEDED`.

Token-bucket rejection includes a bounded `Retry-After` header. The header is
exposed to an allowed credentialed browser origin together with the existing
Knowledge capability header. Credential-work or active-execution saturation has no
exact release time and can omit `Retry-After`.

Clients must not automatically replay a state-changing request merely because it
received 429. A connection loss remains subject to that domain's existing
unknown-result protocol.

## Admission layers

- Every route except `GET /health` first consumes one code-selected network lane.
  Standard, control/recovery, and mixed-request ingress use hard-separated token
  and key partitions.
- Login, registration, Staff login, and public registration-requirements reads
  additionally consume their fixed network policy.
- Authenticated routes consume a user or Staff principal policy after the existing
  authentication guards. IDs remain ephemeral process-memory limiter keys.
- Consent mutation and AI chat use a bounded classification probe and an
  owner-scoped lookup. Only that server lookup selects recovery versus ordinary/new
  work; no request flag or header can select a privileged lane.
- All HTTP-reachable Argon2 work shares one non-queued concurrency bound. Once a
  native operation starts, its permit is held until the Promise actually settles,
  even if the request disconnects.

Rate rejection does not authenticate, authorize, validate ownership, check AI
Safety, or imply a crisis response. Admitted work continues through every existing
Session, CSRF, Consent, Quota, Safety, Audit, and persistence boundary.

## Privacy and logging

The limiter uses the normalized direct socket peer before authentication and the
internal user/Staff principal ID after authentication. It does not trust
`Forwarded` or `X-Forwarded-For`. These values are not persisted, audited, returned,
or written to operational logs.

A rejection log contains only the fixed event, policy group, identity kind, and
saturation reason. It contains no address, principal ID, route, query, body,
credential, Mood value, chat text, prompt, provider payload, or arbitrary error.

## Runtime configuration

Configuration is validated at startup:

- `HTTP_RATE_LIMIT_KEY_TTL_SECONDS`
- `HTTP_RATE_LIMIT_SWEEP_INTERVAL_SECONDS`
- `HTTP_RATE_LIMIT_MAX_KEYS_PER_POLICY`
- `HTTP_RATE_LIMIT_MAX_TOTAL_KEYS`
- `HTTP_RATE_LIMIT_CAPACITY_SCALE`
- `HTTP_CREDENTIAL_MAX_CONCURRENCY`
- `HTTP_CREDENTIAL_OPERATION_TIMEOUT_MS`

The policy names and relative policy definitions are code-owned. The capacity scale
is a bounded test/deployment tuning input; it does not change product Quota. There
is no runtime switch that silently removes admission.

## Guarantee boundary

Counters and keys are process-local, bounded, and erased on shutdown/restart. Each
API instance enforces independently. Direct peer identity behind an unapproved
proxy can group unrelated users. This layer does not protect TLS, connection,
slow-body, or distributed volumetric capacity and is not production DoS evidence.
Production thresholds, proxy trust, privacy review of address processing, edge
controls, multi-instance enforcement, and load evaluation remain blockers.
