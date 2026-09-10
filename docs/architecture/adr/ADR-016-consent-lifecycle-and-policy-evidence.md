# ADR-016: Consent Lifecycle and Policy Evidence

- Status: Proposed
- Date: 2026-09-10
- Decision owners: Product, Privacy/Legal, and Engineering
- Related: ADR-011, ADR-013, ADR-014, ADR-015

## Context

ADR-011 defines a single row and a single accept/withdraw lifecycle for each
user, Consent type, and version. A withdrawn version cannot be accepted again.
That is implemented and remains authoritative.

Phase 5C needs a user-understandable recovery path after withdrawal without
inventing a policy version. It also needs durable evidence of every affirmative
decision, safe retries, multi-tab concurrency control, exact policy-document
binding, and cancellation that affects only executions dependent on the withdrawn
authorization.

The current mutable row cannot represent repeated decisions without erasing or
overwriting prior evidence. The current broad cancellation behavior also
interrupts work after withdrawal of an unrelated historical version.

## Proposed decision

If accepted, this ADR would partially supersede only the Consent lifecycle and
same-version re-acceptance constraints in ADR-011. It would also narrowly
supersede the ADR-015 Phase 5C addendum rule that every withdrawal cancels all of
a user's executions and Incognito contexts, replacing that rule with
authorization-revision-scoped cancellation. ADR-015's remaining Conversation,
Incognito, client-data, and public-protocol decisions remain unchanged.

### Same-version re-acceptance

A user may explicitly re-accept the current approved version after withdrawal.
Each acceptance and withdrawal is a new immutable decision. Earlier timestamps
and decisions are never cleared, overwritten, or deleted to simulate recovery.

Re-acceptance authorizes only later requests. It does not revive cancelled AI
executions, recreate cleared Incognito context, or make an old client request ID
reusable.

### Projection and decision ledger

Keep `consents` as the current-state projection and introduce an immutable
`consent_decisions` ledger. The projection has a monotonically increasing state
revision. The ledger records the user, type, version, decision, operation ID,
prior/resulting revisions, source, time, and—when evidence exists—the exact
approved document identity.

Legacy rows do not contain document identity or decision source. Backfill marks
them with a bounded `legacy_backfill` source and leaves document identity absent
unless a separately reviewed deployment artifact proves the exact immutable
mapping. Migration must not invent evidence. Every new registration or Privacy
decision requires a complete document identity.

Document key and revision are either both present or both absent; absence is
allowed only for `legacy_backfill`. An unmapped legacy acceptance does not satisfy
the current post-migration third-party AI gate by default. It is retained as
history while the user may create a new, document-bound accepted decision from
the existing accepted projection without a fabricated withdrawal. Any
grandfathering requires separate product/legal approval and verified evidence.

Do not store policy bodies, IP addresses, user agents, session values,
psychological content, content fingerprints, or arbitrary metadata.

### Retry and concurrency

Every user mutation has a stable operation ID and expected state revision.
Database uniqueness, row locking, and a transaction guarantee one decision per
operation and ordered state transitions. Exact retries return the original
receipt plus current state; they create no second lifecycle transition. A failed
local runtime invalidation may be reconciled idempotently without repeating the
database decision. Conflicting reuse and stale state fail explicitly.

The first acceptance of a missing projection uses expected revision 0 and commits
revision 1. Concurrent insert conflicts are mapped to stale state. Projection
timestamps describe only the latest state; earlier timestamps remain in the
ledger. History uses stable `(occurred_at, id)` ordering and a versioned cursor.

### Effective withdrawal and execution dependency

Withdrawal becomes effective when the database transaction commits. AI execution
binds the exact required Consent decision revisions before Provider dispatch.
A committed withdrawal cancels pending executions and active executions dependent
on that revision, and clears matching Incognito contexts. Withdrawal of a
historical revision does not cancel an execution authorized solely by a newer
revision.

Re-acceptance cannot race an old withdrawal because both require the expected
revision. Database failure changes neither effective state nor runtime state.

Execution registers as cancellable before Consent validation. Before every
third-party dispatch carrying user-derived or Provider-generated psychological
content, admission performs its final database revision/snapshot check, abort
check, and actual Provider-dispatch handoff under the same per-user local critical
section used by withdrawal. Withdrawal holds that section from before its
transaction through commit, local revoked-revision publication, and abort/clear
reconciliation. If withdrawal commits first, later dispatch is refused. If
Provider dispatch begins first, the later withdrawal aborts it and
output/persistence guards reject the revoked snapshot, without claiming data
already received by the Provider was recalled.

Constructing a lazy stream iterable is not Provider dispatch. The adapter must
give the coordinator a bounded acknowledgement that its outbound HTTP request has
actually started, without holding the critical section until the first model
token.

The first implementation guarantees this coordination only within one API
process. Cross-instance cancellation remains a production-readiness blocker; no
Redis, queue, or distributed lock is introduced by this ADR.

### Policy-document registry

One code-owned, version-controlled registry supplies the server-authoritative
Consent type/version, immutable document key/revision, display key, URL, approval
state, and effective time. Registration, Privacy display, and mutation validation
use that same identity. Draft or unapproved content cannot be accepted.

An approved `(consentType, consentVersion)` resolves to exactly one immutable
document key/revision. Required environment versions must resolve to approved
registry entries or registration and AI admission fail closed. A used version
cannot silently point to replacement content.

This registry is not a policy CMS. Approved legal copy and third-party AI
processing disclosures remain a human product/legal prerequisite.

### Product/legal classification

The UI must distinguish service-terms acceptance, privacy-notice acknowledgement,
and consent to a specific processing activity. This ADR does not decide that the
existing two Consent types are legally sufficient, add a new required type, or
change registration requirements. Those changes require separate approval.

## Unchanged ADR-011 decisions

This proposal does not supersede ADR-011 decisions concerning:

- atomic age-verified registration;
- separation of users, credentials, sessions, age verification, and Consent;
- Argon2id password hashing;
- opaque server-side sessions and SHA-256 token verifiers;
- fixed session expiration and cookie policy;
- CSRF origin/referer and double-submit protections;
- mock age-verification restrictions; or
- data minimization outside the Consent decision evidence described here.

ADR-011 remains Accepted in full unless and until this proposed ADR is approved.

## Consequences

### Benefits

- Users can make a new informed choice without a fake policy version.
- Every accept/withdraw decision remains interpretable.
- Operation replay and state revisions resolve duplicate, late, and multi-tab
  mutations without relying on UI button state.
- Runtime cancellation follows the authorization actually used by an execution.
- Registration, Privacy, and mutations bind to one approved document identity.

### Costs and limitations

- A new table, migration backfill, transaction protocol, and UI states are needed.
- Consent decision retention and account-deletion treatment remain undecided.
- Single-process cancellation is not a cross-instance guarantee.
- Product/legal review must approve document content and determine whether a
  dedicated third-party AI-processing authorization is required.

## Alternatives considered

### Keep same-version withdrawal irreversible

This preserves the current schema but provides no recovery path without a policy
version change. Creating a fake version solely to restore use would weaken the
meaning of versioned evidence.

### Reset the existing row on re-acceptance

Rejected because clearing `withdrawn_at` or overwriting `accepted_at` destroys the
earlier decision history and makes retry/concurrency behavior ambiguous.

### Store only events and derive all state at read time

Rejected for the current scope. A projection plus a small immutable ledger gives
clear evidence and efficient admission without adopting general event sourcing.

### Cancel all user activity for every historical withdrawal

Rejected because it interrupts executions that do not depend on the withdrawn
authorization. Dependency-scoped cancellation is the minimum accurate behavior.

## Adoption condition

This ADR must remain Proposed until product, Privacy/Legal, and Engineering accept
the decision. Acceptance requires an implementation plan for lossless migration,
document governance, concurrency tests, runtime cancellation regression, and the
remaining production blockers. Until then ADR-011 remains authoritative.
