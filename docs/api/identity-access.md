# Phase 2A Identity and Access API

All endpoints return JSON and use the shared error contract in
docs/api/error-format.md. The only public Phase 2A endpoints are:

| Method | Path                            | Authentication | CSRF requirement             |
| ------ | ------------------------------- | -------------- | ---------------------------- |
| GET    | /auth/registration-requirements | No             | None (read-only)             |
| POST   | /auth/register                  | No             | Trusted Origin/Referer       |
| POST   | /auth/login                     | No             | Trusted Origin/Referer       |
| POST   | /auth/logout                    | Session cookie | Origin + double-submit token |
| GET    | /auth/session                   | Session cookie | None (read-only)             |
| POST   | /consents                       | Session cookie | Origin + double-submit token |
| GET    | /consents                       | Session cookie | None (read-only)             |

There is no public age-verification endpoint. Registration invokes the
configured provider internally.

`GET /auth/registration-requirements` is a public, read-only product contract.
It returns only whether registration is enabled, the minimum age, and the current
environment-eligible Consent type/version/document identity/display information.
Development/Test document values are visibly synthetic fixtures; they are not
production policy evidence. It never returns the configured
provider, internal readiness blockers, credentials, or policy internals. When a
real registration prerequisite is unavailable, it returns
`registrationEnabled=false`; `POST /auth/register` then fails closed with
`REGISTRATION_UNAVAILABLE`.

## Registration

POST /auth/register accepts an email, password, provider evidence and the
server-required current consent versions:

    {
      "email": "person@example.com",
      "password": "a strong 12+ character password",
      "ageVerification": {
        "evidenceToken": "provider-specific request evidence"
      },
      "consents": [
        {
          "consentType": "terms_of_service",
          "consentVersion": "1.0",
          "documentKey": "server-advertised immutable document key",
          "documentRevision": "server-advertised immutable revision",
          "accepted": true
        },
        {
          "consentType": "privacy_policy",
          "consentVersion": "1.0",
          "documentKey": "server-advertised immutable document key",
          "documentRevision": "server-advertised immutable revision",
          "accepted": true
        }
      ]
    }

Adult-age verification occurs before persistence. A single transaction then
creates the user, credential, successful verification result and required
consents. Any failure rolls back every write. Registration does not create a
session; use /auth/login afterward.

For local Development/Test only, the mock provider recognizes mock-adult,
mock-underage, and mock-provider-error. These values are test fixtures and are
not real age verification. Configuring the mock provider in Staging or
Production is rejected. An unconfigured provider keeps non-registration API
capabilities available while registration remains disabled.

## Login and session

POST /auth/login accepts email and password. Unknown accounts and wrong
passwords both return the same 401 INVALID_CREDENTIALS response and both run an
Argon2 verification path.

Successful login sets:

- mh_session: HttpOnly opaque session token;
- mh_csrf: JavaScript-readable double-submit token.

Both cookies use SameSite=Lax, Path=/, no Domain, and matching server/client
expiration. Production also sets Secure. The database contains only the
SHA-256 session-token hash.

State-changing authenticated requests send the mh_csrf value in the
x-csrf-token header and must come from a configured trusted origin.

## Consent

`POST /consents` uses an action-discriminated mutation contract. Both actions
carry a client-generated UUID `operationId`, the owned type/version and
`expectedRevision`. `accept` additionally carries the exact server-advertised
`documentKey` and `documentRevision`; `withdraw` rejects those document fields.
Exact retries reuse `operationId`, return the original immutable receipt and do
not append another decision. Reusing an operation ID for different semantics or
submitting a stale revision returns a bounded 409 error.

`GET /consents?limit=20&cursor=...` returns a newest-first, bounded page of the
authenticated user's known consent history:

    {
      "success": true,
      "data": {
        "currentRequiredConsents": [
          {
            "consentType": "privacy_policy",
            "consentVersion": "1.0",
            "status": "accepted",
            "stateRevision": 1,
            "effectiveAt": "2026-09-10T00:00:00.000Z",
            "acceptedAt": "2026-09-10T00:00:00.000Z",
            "withdrawnAt": null,
            "documentKey": "synthetic.privacy-policy",
            "documentRevision": "test-revision-1",
            "documentUrl": "https://example.invalid/mental-health-ai/synthetic/privacy/1.0",
            "displayKey": "consent.privacyPolicy",
            "authorizationStatus": "active",
            "acceptanceEnabled": true,
            "withdrawalEnabled": true
          }
        ],
        "consents": [
          {
            "operationId": "31f2fe6a-28db-4efb-ae51-15b273af2362",
            "action": "accept",
            "outcome": "applied",
            "consentType": "privacy_policy",
            "consentVersion": "1.0",
            "documentKey": "synthetic.privacy-policy",
            "documentRevision": "test-revision-1",
            "priorRevision": 0,
            "resultingRevision": 1,
            "occurredAt": "2026-09-10T00:00:00.000Z",
            "decisionSource": "registration"
          }
        ],
        "nextCursor": null
      }
    }

`currentRequiredConsents` is derived from the same environment-aware document
registry used by registration and AI admission. An accepted legacy projection
without verified document identity is exposed as `confirmation_required` and
does not authorize third-party AI dispatch. History entries are immutable
decision receipts ordered by `(occurredAt, id)` behind a versioned opaque cursor.
The page limit defaults to 20 and is capped at 50. Responses exclude persistence
IDs and `userId`, and use `Cache-Control: private, no-store`.

ADR-016 permits a new explicit acceptance of the same current version after
withdrawal. Applied transitions increment state revision; state-preserving
operations create durable `no_change` receipts. Production document content,
legal classification and Consent retention remain separate readiness decisions.
