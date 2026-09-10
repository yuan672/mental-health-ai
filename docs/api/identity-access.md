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
required consent type/version/display key pairs. It never returns the configured
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
          "accepted": true
        },
        {
          "consentType": "privacy_policy",
          "consentVersion": "1.0",
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

`POST /consents` accepts `consentType`, `consentVersion`, and `action` (`accept`
or `withdraw`). Only the known `terms_of_service` and `privacy_policy` types are
accepted. `accept` is valid only for the server-configured current version;
clients cannot define which policy version is current. `withdraw` remains valid
for an existing known historical version owned by the authenticated user.

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
            "acceptedAt": "2026-09-10T00:00:00.000Z",
            "withdrawnAt": null
          }
        ],
        "consents": [
          {
            "consentType": "privacy_policy",
            "consentVersion": "1.0",
            "status": "accepted",
            "acceptedAt": "2026-09-10T00:00:00.000Z",
            "withdrawnAt": null
          }
        ],
        "nextCursor": null
      }
    }

`currentRequiredConsents` is derived from the server-configured required policy
versions and uses `not_accepted` when the current version has no lifecycle record.
The history page limit defaults to 20 and is capped at 50. The cursor is an opaque,
versioned pagination token. The response deliberately excludes persistence IDs
and `userId`, and uses `Cache-Control: private, no-store`.

A withdrawn type/version cannot be accepted again under ADR-011. A newly
configured policy version creates a new lifecycle record. Product implications
and unapproved alternatives are recorded in
`docs/architecture/consent-policy-decision-note.md`.
