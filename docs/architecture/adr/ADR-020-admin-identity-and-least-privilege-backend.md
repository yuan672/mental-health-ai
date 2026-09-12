# ADR-020: Admin Identity and Least-Privilege Backend Boundaries

- Status: Accepted
- Date: 2026-09-12
- Accepted scope: separate staff identity/session domain and metadata-only initial
  Safety Review and AI Quality Review, including the Batch 1 lifecycle contracts
- Related: ADR-004, ADR-007, ADR-011, ADR-014, ADR-016, ADR-018, ADR-019
- Supersedes: None

## Context

HANDOFF section 45 includes Admin Authentication, Risk Event review, Human Review
Queue, Knowledge Management, Audit Log, and AI Quality Review. Phase 4 already
created minimal Risk Event, queue, Audit, and default-deny reviewer service
boundaries. Phase 5E already created exact-version Knowledge publication commands.
There is no trusted staff identity or Admin HTTP surface.

Adding an `is_admin` flag or role to an ordinary user would couple pseudonymous
product access to high-sensitivity operational access. A broad administrator role
would also conflict with the requirement that ordinary administrators cannot read
all psychological conversations.

## Decision

### Separate staff security domain

Use separate staff principals, credentials, sessions, cookies, origin allowlist,
and CSRF validation. Ordinary `users` and ordinary sessions never carry or imply
staff authority. Existing Argon2id, random opaque-token, SHA-256 verifier, strict
validation, safe-error, and redacted-logging implementations may be reused as code
patterns or internal utilities, not as a shared security context.

There is no public staff registration, email-domain auto-promotion, ordinary-user
upgrade, default account, wildcard permission, or universal administrator.

### Fixed roles and code-owned permissions

Use bounded roles `access_administrator`, `safety_reviewer`, `knowledge_editor`,
`knowledge_source_reviewer`, `knowledge_publisher`, `audit_reader`, and
`ai_quality_reviewer`. A code-owned map expands each role to finite typed
permissions. Roles do not inherit and are not editable through a generic policy
engine.

`access_administrator` manages staff access only. It gains no Risk, queue,
Knowledge, Audit, AI Quality, or psychological-content permission automatically.
Knowledge edit, source verification, and publication are separate permissions.
Holding a management role never creates source-verification evidence.

The initial `safety_reviewer` and `ai_quality_reviewer` contracts are metadata-only.
No initial role can read user or assistant message bodies, prompts, Incognito text,
or Provider payloads. A future content-bearing workflow requires a separate
decision and permission.

### Session and access lifecycle

Staff sessions are opaque, fixed-expiry, revocable records bound to the principal's
current authorization revision. A role grant, role revocation, or principal
disablement atomically increments that revision, revokes existing staff sessions,
and appends a bounded Audit record. Session validation requires an active principal
and an exact revision match.

An explicit revoke-sessions operation uses the same principal lock and revision
boundary. An applied revocation increments revision, revokes the locked visible
session set, and audits atomically even when that set is empty. The command has no
`no_change` result because the revision advance is the replay-safety boundary.
Login takes the same lock for its final active/revision recheck and session insert.
An old expected revision therefore cannot revoke a session created after an earlier
unknown-result revocation.

The first access administrator is created by a restricted offline bootstrap command
with an explicit role and no credential logging. A fixed PostgreSQL transaction
advisory lock serializes its availability check and atomic
principal/credential/role/Audit creation, including concurrent first-bootstrap
attempts with different emails. A partial unique index on the retained bootstrap
grant also prevents a second bootstrap after commit, including after later
disablement or role revocation. Later principals require an authenticated
`access_administrator`, a caller-generated principal UUID, normalized email, and an
initial password; principal, Argon2id credential, and Audit are created atomically
before roles are granted separately. Production bootstrap, MFA, recovery, and
offboarding remain operational prerequisites rather than synthetic-test claims.

### Persistence

Add `staff_principals`, `staff_password_credentials`, `staff_sessions`, and
`staff_role_grants` through a forward-only Drizzle migration. Active role grants
are unique; revocation retains their original grant evidence. Role keys are strict
application/Zod values rather than a database-configurable authorization language.
Each role grant carries a bounded `bootstrap | staff` source so a future actor-FK
`SET NULL` cannot be mistaken for bootstrap; only one retained bootstrap grant is
permitted.

The caller-generated principal UUID is the bounded creation-confirmation key while
that row exists. A retry for the same ID/email never overwrites the stored password;
duplicate ID/email mismatches conflict. A status read after an unknown result is
current state, not an immutable creation receipt or proof that a missing transaction
cannot still commit. No permanent operation ledger, password fingerprint, or
default credential is added.

Staff account disablement is the first implementation's terminal action. It is not
account deletion and does not decide production retention.

### Service-level authorization and audit

Controller guards authenticate a staff session, but every protected application
service calls a typed authorizer for one permission. Sensitive read, permission
validation, and access-audit append share one short database transaction. Audit
failure means no sensitive result is returned.

Staff-directory reads containing normalized login email and access state are also
sensitive reads and require their own successful allowlisted access Audit before a
response is returned.

The database-backed reviewer authorizer replaces the Phase 4 default-deny
implementation only when the staff foundation is installed. Otherwise default deny
remains. A plain principal ID, ordinary user ID, or frontend-hidden route never
constitutes authorization.

Installing that authorizer is not sufficient to mark the Safety Gate production
ready or change `productionSafe`; real staff identity, least-privilege access,
validated production configuration, and every other existing Safety readiness
condition must still be satisfied.

Audit actions and metadata remain application allowlists. Logs and Audit metadata
exclude credentials, email, session/CSRF material, psychological text, prompt,
Knowledge body/source payload, Provider payload, arbitrary DTO, and arbitrary
Error.

### Domain boundaries

- Risk Review initially exposes minimal Risk/Queue metadata and existing atomic
  claim/resolve transitions. It does not expose chat bodies or Incognito content.
- Knowledge Management preserves immutable versions, frozen sources,
  exact-version commands, environment isolation, and real human review evidence.
  Reviewer identity/time is server-derived; publisher authority is not review
  authority.
- Audit Read returns allowlisted Audit rows and cannot dereference resources into
  sensitive content. Its own access must be audited before a page is returned.
- AI Quality Review initially exposes bounded operational metadata only. It does not
  authorize a real-model run or content review.

The implementation is split into independently reviewable backend batches:
identity/session/authorization; Risk/Queue APIs; Knowledge Management APIs; and
Audit/AI Quality metadata APIs. No batch requires an Admin UI.

## Consequences

### Benefits

- Ordinary user compromise or account registration cannot create staff authority.
- Revoked permissions do not survive in old staff sessions.
- Staff access is explicit, narrowly scoped, and auditable.
- Existing Phase 4 and Knowledge invariants are reused instead of duplicated.
- Local synthetic API/integration tests can validate the backend without claiming
  production identity or safety readiness.

### Costs and limitations

- Four staff tables and separate cookie/CSRF handling add implementation work.
- Role changes require re-login because they invalidate existing sessions.
- Metadata-only Safety/AI Quality review provides less context until a lawful,
  purpose-bound content-access decision exists.
- A single-application database authorization path is not an external enterprise
  identity provider and does not provide production MFA/recovery by itself.

## Alternatives considered

### Add `is_admin` or roles to ordinary users

Rejected because it creates a direct privilege-escalation path from the public
account lifecycle and conflates product Consent/age identity with staff access.

### One universal administrator role

Rejected because it violates least privilege and would let account-management or
content-management staff browse unrelated psychological records.

### Database-configurable permission rules

Rejected for V1 because it creates a generic authorization platform, makes review
of effective access harder, and is unnecessary for the small fixed role set.

### Reuse the Phase 4 fake reviewer principal in production

Rejected. Test injection proves service behavior but is not authentication and
must not become a production principal provider.

## Acceptance boundary

Acceptance of this ADR authorizes only the backend architecture and the first
identity/session/authorization implementation batch. It does not approve an Admin
UI, production staff enrollment, MFA, staff retention, access to psychological
message bodies, formal source review, candidate-article publication, Production AI
enablement, or real-model evaluation.
