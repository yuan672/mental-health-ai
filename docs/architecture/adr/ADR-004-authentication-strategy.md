# ADR-004: Authentication Strategy

- Status: Accepted (architecture only; implementation belongs to Phase 2)
- Date: 2026-09-09

## Context
V1 requires registered users, pseudonymous use and 18+ verification, but no completely registration-free guest mode. The system must support deletion, quotas, risk events and auditability.

## Decision
For the Web client, use **server-side opaque sessions carried in Secure, HttpOnly cookies**.

Phase 2 design:
- email/password or another explicitly approved account identifier;
- password hashes using Argon2id;
- random high-entropy session token shown only to the client;
- store only a hash of the session token server-side;
- session revocation and rotation supported;
- `Secure`, `HttpOnly`, appropriate `SameSite` cookie flags;
- CSRF protection using same-site deployment assumptions plus Origin/Referer validation and an explicit anti-CSRF mechanism for state-changing requests where needed;
- authorization enforced server-side using roles/permissions;
- age verification is a separate service and is not inferred from authentication.

## Why this fits
- Revocation is simple and explicit for a sensitive application.
- Browser JavaScript never needs to read long-lived credentials.
- Avoids pretending JWTs are automatically safer or simpler.
- Server-side session records support security investigations and logout/revocation semantics.

## Alternatives
### Access JWT + refresh token
Useful for multi-client APIs.

**Not selected now:** token rotation, revocation and browser storage/cookie details add complexity without a current native-app client.

### Third-party hosted identity platform
Can reduce implementation work.

**Not selected now:** mainland-China availability, data handling and vendor dependency must be evaluated before binding core identity to one vendor.

## Future impact
Authentication should expose a transport-neutral application interface. A future native client may add OAuth/OIDC or access/refresh tokens without changing user, age-verification or authorization domain models.
