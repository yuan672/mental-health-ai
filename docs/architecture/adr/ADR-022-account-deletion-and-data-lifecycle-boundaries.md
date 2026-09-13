# ADR-022: Account Deletion and Data Lifecycle Boundaries

- Status: Accepted
- Date: 2026-09-13
- Accepted scope: a Development/Test-only, controlled single-process account-
  deletion backend for local learning/demo, using the existing User foreign-key
  graph, password reauthentication, bounded process-local coordination, and a
  required content-free deletion Audit
- Refines: ADR-011, ADR-012, ADR-014, ADR-016, ADR-017, ADR-019, and ADR-021
- Supersedes: None

## Context

The repository has separate logout, Consent withdrawal, Conversation deletion,
Mood deletion, Incognito cleanup, Risk/Audit retention, Staff disablement, and
Knowledge withdrawal lifecycles, but no account-deletion operation. The existing
User foreign-key graph can remove ordinary account-owned records, while Risk Event
and Audit records deliberately have independent lifetimes. Process-memory AI and
Incognito state is not removed by a PostgreSQL cascade.

The current target is a controlled, single API process for local learning/demo.
Production retention, backup restoration, third-party processing, multi-instance
coordination, and legal wording are unresolved. The design must not pretend those
matters are solved or retain extra sensitive data merely to provide indefinite
operation replay.

## Decision

### Data lifecycle

Deleting an ordinary User follows the existing database graph:

- cascade identity, password credential, Session, age verification, Consent
  projection/decision, Conversation, Message, AI Turn, Assistant Knowledge
  reference, Mood, and Quota records;
- retain Risk Events until their independently configured deadline, with existing
  User/Conversation/Turn/Message references set null;
- retain a Human Review Queue item only while its Risk Event exists;
- retain existing Audit rows until their independent configured deadlines; and
- leave global Staff identity and Knowledge article/version/source evidence outside
  ordinary account deletion.

Set-null and retained Audit records are not described as anonymous. Existing local
retention settings are not adopted as production or legal policy by this decision.

### Command and authorization boundary

Expose one ordinary-User command only in Development/Test. It requires a current
ordinary Session, trusted Origin, CSRF, a strict request containing a UUID
`operationId`, current-password reauthentication, and explicit irreversible-action
acknowledgement. It accepts no target User ID or email. Staff deletion, delegated
deletion, passwordless recovery, an unauthenticated result reader, and Production
execution are not authorized.

Password verification uses the existing bounded HTTP Argon2-work admission outside
the User lifecycle lock. The permit remains held until the underlying Argon2 Promise
settles.

### Single-process coordination

The owner of the existing non-reentrant `PerUserConsentLock` adds one narrow account-
deletion operation. The lock is acquired exactly once; lock-held code uses no-lock
helpers and must not call a public coordinator method that reacquires it.

Before changing runtime state, reserve fixed-capacity process-local entries for the
authenticated `(userId, operationId)` and an unguessable internal attempt token.
Permit one unresolved deletion attempt per User and a bounded global count. Install
a terminal marker under the User lock, abort pending/bound AI work, and clear idle
and active Incognito contexts. Consent bind/recheck, third-party dispatch,
Incognito creation, output/persistence/completion, and late-result barriers reject
a User while the marker remains.

An unknown marker is not evicted by TTL. The User lock and request waiters are still
released at bounded deadlines, but the marker consumes finite capacity until a
confirmed terminal result. Capacity exhaustion rejects new deletion attempts rather
than silently allowing protected work.

### Database transaction and required Audit

In one short transaction:

1. lock the authenticated User row;
2. lock and revalidate the exact Session, including ownership, revocation, and
   expiry against one database observation time;
3. reject a pre-existing deletion Audit idempotency key;
4. mark the internal attempt as having started its one database mutation;
5. require a newly inserted, content-free `account_deleted` Audit; and
6. delete exactly one User row using `RETURNING`.

Audit insertion and User deletion commit or roll back together. The required path
must not use ordinary `ON CONFLICT DO NOTHING` as success. The Audit uses actor type
`user`, null actor ID, resource type `account_deletion`, resource ID equal to the
operation UUID, idempotency key `account-deleted:<operationId>`, and only bounded
self-service metadata. It does not add the action to Staff Audit-read permissions.

The process-local internal attempt is the only subject binding. A pre-existing or
unowned global key is conflict evidence, never proof for the current User. Different
Users using the same UUID cannot borrow each other's Audit. Once the registry entry
is released or the process restarts, the Audit row alone does not support exact
replay or identify the deleted User.

### Unknown commit result

After the database mutation starts, client disconnect suppresses delivery but does
not start another transaction or abandon server-owned reconciliation. A normal
MVCC read, missing Session, process restart, or currently missing Audit is not proof
that the original transaction rolled back.

Reconciliation uses a new bounded `READ COMMITTED` transaction. It first selects the
same User row `FOR UPDATE`, waiting on the serialization point held by the original
attempt, and then locks/reads the exact Audit key in that confirmation transaction.
Together with the still-live internal attempt token and its own-Audit-inserted
marker, this distinguishes:

- this attempt committed;
- this attempt definitely rolled back;
- another operation deleted the account or evidence is not attributable;
- an unowned operation-key conflict; and
- a true impossible invariant state.

Lock/statement timeout, database outage, lost subject binding, or non-attributable
evidence produces an honest `ACCOUNT_DELETION_RESULT_UNKNOWN`. It retains the
terminal marker and never requeues the original mutation. A confirmed commit or
rollback releases the marker only after owned runtime cleanup/drain; cleared
contexts and aborted executions are not resurrected.

### Response, privacy, and external copies

Return `204 No Content` and expire browser cookies only for a confirmed commit.
Typed rejection, conflict, and unknown errors expose no password, email, Session,
Cookie, CSRF, operation ID, or psychological content in ordinary logs.

Primary-database deletion does not synchronously erase independently retained Risk
or Audit data, log-sink copies, backups, or bytes already received by a Provider.
No public wording may claim otherwise.

## Consequences

- The local/demo operation can delete the ordinary account graph without a new
  table, migration, permanent operation ledger, User tombstone, content copy,
  content hash, Redis, queue, or external dependency.
- Required Audit conflict or failure cannot be bypassed to delete a User.
- Pending and late AI/Incognito work is fail closed in one process.
- Unknown outcomes can intentionally consume bounded capacity and make the affected
  User's AI/Incognito features unavailable.
- Exact replay is deliberately limited to a live, authenticated, process-bound
  attempt. A deleted User cannot authenticate to query a result.
- Process crash, rolling overlap, or another API instance can outlive the marker and
  is not protected. Controlled single-process shutdown/drain is required for the
  accepted demo scope; Production needs a separate durable/cross-instance decision.

## Alternatives considered

### Retain the former User UUID in Audit

Not selected for the demo implementation because it adds long-lived linkability.
It may be reconsidered only with an approved purpose, access model, retention,
encryption, and account-deletion policy.

### Permanent deletion receipt or tombstone

Not selected because it introduces a new sensitive identity and authentication,
retention, cleanup, and backup lifecycle. The accepted tradeoff is bounded replay
and honest uncertainty.

### TTL-expire unknown terminal markers

Rejected. Resource reclamation cannot silently convert an unresolved destructive
operation into permission to start new processing.

### New lifecycle lock, Redis, queue, or distributed transaction

Not selected. A second per-User lock risks inconsistent order or self-deadlock, and
distributed infrastructure is not justified for the controlled single-process
demo. These omissions preclude a Production coordination claim.

## Adoption boundary

This Accepted ADR authorizes only the backend implementation and synthetic tests
described above. It does not authorize implementation-PR merge, user interface,
real account/data deletion, deployment, Production/Staging enablement, production
retention or legal wording, backup manipulation, Provider deletion claims,
cross-instance cancellation, or a public recovery guarantee.

Production Safety Lock remains enforced, Production AI Chat remains disabled,
`productionSafe=false`, and Real Model Safety Evaluation remains Not Evaluated.
