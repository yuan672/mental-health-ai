# ADR-011: Identity and Access Lifecycle

- Status: Accepted
- Date: 2026-09-09
- Refines: ADR-004 Authentication Strategy (does not supersede it)

## Context

ADR-004 selects server-side opaque sessions and separates authentication from age
verification. Phase 2A needs the concrete identity lifecycle, persistence boundaries,
and browser protections needed to implement that direction without collecting data
for hypothetical future features.

Registration must not leave a usable account when adult-age verification or any
required database write fails. The only Phase 2A age provider is a development and
test mock; a future external provider may require a materially different redirect,
callback, or asynchronous lifecycle.

## Decision

### Atomic verified registration

`POST /auth/register` validates the request, generates a candidate user ID, and asks
the configured `AgeVerificationProvider` to verify request-local evidence. A failed
adult-age check rejects registration before any account data is written. Provider
unavailability returns a safe service-unavailable error.

After successful verification, one PostgreSQL transaction creates the user, password
credential, successful age-verification result, and all required consent records.
Any insert failure rolls back the whole transaction. Registration does not create a
session; the client authenticates through `POST /auth/login` after registration.

There is no pre-registration receipt or verification-attempt table. Without a real
provider requiring redirects, callbacks, asynchronous completion, or replay-safe
pre-registration tokens, such a table would add unused expiry, consumption, and
replay semantics. A future requirement for that lifecycle needs a new ADR.

### Data model and minimization

Use five tables with database `snake_case` names and TypeScript `camelCase` fields:

- `users`: opaque user ID and lifecycle timestamps only;
- `password_credentials`: one row per user, unique normalized email, Argon2id hash,
  and credential timestamps;
- `sessions`: many rows per user, unique SHA-256 token hash, creation, fixed expiry,
  and optional revocation timestamp;
- `age_verifications`: one successful result per user, containing only
  `age_verified`, `verification_method`, and `verified_at`;
- `consents`: versioned policy decisions per user.

Do not persist birth date, asserted age, provider evidence, identity-document data,
real name, address, school, employer, gender, diagnosis, or profile analytics.

Foreign keys use `ON DELETE CASCADE` so deleting a user cannot orphan credentials,
sessions, age verification, or consents. `password_credentials.user_id` and
`age_verifications.user_id` are primary keys, enforcing the one-to-one relations.
`sessions.token_hash` is unique; indexes on `sessions.user_id` and
`sessions.expires_at` support validation, cleanup, and future revoke-all behavior.

### Password authentication

Passwords use Argon2id through a maintained library; no project-specific
cryptographic construction is allowed. Registration enforces the Phase 2A password
policy before hashing. Password hashes are never returned or logged.

Unknown-account and wrong-password login attempts return the same HTTP status, error
code, and message. Both execute an Argon2 verification operation; unknown accounts
use a process-local dummy Argon2id hash.

### Sessions and cookies

Successful login generates a 32-byte cryptographically random token. Only the raw
opaque token is sent to the browser. PostgreSQL stores
`SHA-256(raw session token)`; HMAC is not used because the uniformly random 256-bit
token is already infeasible to guess, and adding a verifier secret would introduce a
secret-rotation lifecycle without addressing a current threat.

Sessions have a fixed seven-day lifetime configured as validated
`SESSION_TTL_SECONDS`. Phase 2A has no sliding expiration, refresh token, or
remember-me flow. Logout immediately sets `revoked_at`; lookup rejects expired or
revoked sessions. The model and user index permit a future revoke-all operation, but
Phase 2A exposes no such endpoint.

The session cookie is `HttpOnly`, `SameSite=Lax`, `Path=/`, and `Secure` in
production. It has no `Domain`. `Max-Age` and `Expires` match the server-side
expiration. Cookie values and raw tokens are excluded from application and security
logs.

### CSRF

All state-changing cookie-authenticated endpoints require all of:

1. an `Origin`, or an HTTPS `Referer` origin fallback, in the environment-configured
   web-origin allowlist;
2. a readable SameSite=Lax CSRF cookie; and
3. an equal `x-csrf-token` header (double submit).

Tokens are compared in constant time. Login and registration are not yet
cookie-authenticated, so they require the trusted-origin check to prevent login CSRF
but not the double-submit token. The CSRF header, cookies, and tokens are redacted
from logs. This design does not require Redis or a separate CSRF service.

### Age-verification provider

`AgeVerificationProvider` is an internal port with `verify` and `healthCheck`.
Registration passes the candidate user ID and request-local provider evidence. The
provider returns only the minimum decision and method required by the use case.

`MockAgeVerificationProvider` is selectable by validated configuration only in
development and test. Configuring it in production fails during startup. A mock
success is test behavior, not evidence of real-world age verification. Phase 2A does
not expose an age-verification endpoint.

### Consent lifecycle and constraints

Each consent has `user_id`, `consent_type`, `consent_version`, `status`,
`accepted_at`, and nullable `withdrawn_at`. Status is either `accepted` or
`withdrawn`.

The database has a unique constraint on
`(user_id, consent_type, consent_version)` and an index on `(user_id, status)`.
Checks require a withdrawn record to have `withdrawn_at` and an accepted record to
have no `withdrawn_at`. Withdrawal updates the matching row while preserving its
original `accepted_at`.

Phase 2A rejects re-acceptance of the same withdrawn type/version. A new policy
version creates a new row. This keeps one explainable lifecycle per version without
an event-sourcing workflow. Any future legal requirement for repeated
accept/withdraw cycles within one version requires a separate lifecycle decision.

Registration accepts only the server-configured current required consent types and
versions. It does not trust the client to define which policies are current.

### Security logging boundary

Authentication modules use a typed `SecurityLoggingService` over the existing Pino
structured logger. Its methods accept allowlisted metadata such as user ID, session
ID, event name, and fixed failure reason. It never accepts arbitrary request bodies,
email addresses, passwords, raw session tokens, Cookie/Authorization headers, CSRF
tokens, or provider evidence. Phase 2A adds no log database, audit table, or logging
service.

## Consequences

- Verified registration is all-or-nothing and cannot create credential or consent
  orphans.
- Database compromise does not directly reveal reusable session bearer tokens.
- Fixed sessions and immediate revocation keep the first implementation predictable.
- Browser state-changing requests have explicit origin and double-submit defenses.
- The mock provider cannot silently become the production verification mechanism.
- Re-accepting a withdrawn policy version is intentionally unsupported in Phase 2A.
- Redirect or asynchronous age verification remains a future design problem rather
  than unused current infrastructure.

## Alternatives considered

### Pre-registration age-verification receipts

Not selected because there is no external flow that currently requires them. They
would introduce temporary persistence, expiry, consumption, and replay behavior.

### HMAC session verifiers

Not selected because session tokens contain 256 bits of cryptographic randomness.
SHA-256 hides the stored bearer value without adding a verifier-secret lifecycle.

### JWT access and refresh tokens

Not selected for Web V1; ADR-004 already establishes server-side sessions and their
revocation advantages.

### Consent event sourcing

Not selected because Phase 2A requires a small versioned lifecycle, not a general
policy workflow engine.
