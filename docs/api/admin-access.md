# Admin Identity and Access API

The Batch 1 Admin backend is a separate staff security domain. It is disabled by
default and is restricted to Development/Test until production enrollment, MFA,
recovery, offboarding, retention, and origin configuration are approved.

Ordinary `mh_session`/`mh_csrf` cookies never authenticate these routes. Staff uses
`mh_staff_session` (HttpOnly) and `mh_staff_csrf`, both scoped to `/admin` with
`SameSite=Strict`; mutations also require `x-staff-csrf-token` and a trusted
`ADMIN_WEB_ORIGINS` origin. Every Admin HTTP request, including read-only requests,
must carry a configured Admin origin. The API does not grant Admin CORS access to
ordinary `WEB_ORIGINS`; a controlled non-browser HTTP caller must also supply an
allowed Admin `Origin`, while the offline bootstrap command remains the no-Origin
administrative path. Every response is `private, no-store`.

## Session routes

- `POST /admin/auth/login` — `{ email, password }`; returns staff principal ID,
  bounded role keys, authorization revision, session ID and expiry.
- `GET /admin/auth/session` — validates the staff session and exact authorization
  revision.
- `POST /admin/auth/logout` — revokes only the current staff session.

Unknown email and wrong password share the same public error. Passwords, email,
tokens, cookies, CSRF values, and request bodies are excluded from logs and Audit.

## Access-administrator routes

- `POST /admin/staff-principals`
- `GET /admin/staff-principals?limit=20&cursor=<opaque>`
- `GET /admin/staff-principals/:id`
- `PUT /admin/staff-principals/:id/roles/:roleKey`
- `DELETE /admin/staff-principals/:id/roles/:roleKey`
- `POST /admin/staff-principals/:id/disable`
- `POST /admin/staff-principals/:id/revoke-sessions`

Creation accepts `{ staffPrincipalId, email, initialPassword }`. The caller UUID is
a row-lifetime confirmation key: the same ID/email returns `no_change` without
replacing the password; mismatched ID/email returns 409. A missing status read
after a network-unknown result is not proof that the original transaction cannot
still commit.

Role, disable, and session-revocation requests use
`{ expectedAuthorizationRevision }`. Role changes are desired-state operations and
may return `no_change`. Before any `no_change` response returns current email/access
state, the same transaction appends a bounded staff-directory access Audit; Audit
failure prevents that sensitive response without changing the lifecycle state. An
explicit session revocation is always `applied` at the
current revision, including when it revokes zero sessions. Applied access changes
advance the revision, revoke existing sessions, and append an allowlisted Audit row
in one transaction.

Role keys are fixed by ADR-020. There is no wildcard or universal administrator.
`access_administrator` grants staff-access management only and does not grant Risk,
Knowledge, Audit, AI Quality, or psychological-content access.

## Offline initialization and synthetic fixtures

`pnpm --filter @mental-health/api admin:bootstrap` accepts one JSON object through
protected standard input using the create-principal fields. It is restricted to
Development/Test in this batch, takes a database advisory lock, and can create only
one retained bootstrap `access_administrator` grant.

`admin:seed-fixture` is test-only, requires `APP_ENV=test` and a database name ending
in `_test`, and creates a visibly synthetic account. It is not production staff
enrollment or security evidence.

## Explicitly outside Batch 1

There are no Admin pages and no Risk/Queue, Knowledge Management, Audit Read, or AI
Quality HTTP routes in this batch. The database-backed Safety reviewer adapter is
installed only when Admin Auth is enabled and accepts a validated staff-session
context; otherwise the existing default-deny implementation remains active.
