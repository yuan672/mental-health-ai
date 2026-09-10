# ADR-016: Consent Lifecycle and Policy Evidence

- Status: Accepted
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

## Decision

This ADR partially supersedes only the Consent lifecycle and same-version
re-acceptance constraints in ADR-011. It also narrowly supersedes the ADR-015
Phase 5C addendum rule that every withdrawal cancels all of a user's executions
and Incognito contexts, replacing that rule with authorization-revision-scoped
cancellation. ADR-015's remaining Conversation, Incognito, client-data, and
public-protocol decisions remain unchanged.

### Same-version re-acceptance

A user may explicitly re-accept the current environment-eligible version after
withdrawal. Each applied acceptance and withdrawal is a new immutable decision;
an operation that changes no state still receives an immutable `no_change`
receipt. Earlier timestamps and decisions are never cleared, overwritten, or
deleted to simulate recovery.

Re-acceptance authorizes only later requests. It does not revive cancelled AI
executions, recreate cleared Incognito context, or make an old client request ID
reusable.

### Projection and decision ledger

Keep `consents` as the current-state projection and introduce an append-only
`consent_decisions` ledger. The projection has a monotonically increasing state
revision. The ledger records the user, type, version, action, applied/no-change
outcome, operation ID, prior/resulting revisions, source, time, and—when the
target acceptance has evidence—the exact reviewed document identity.

Legacy rows do not contain document identity or decision source. Backfill marks
them with a bounded `legacy_backfill` source and leaves document identity absent
unless a separately reviewed deployment artifact proves the exact immutable
mapping. Migration must not invent evidence. Every new registration or Privacy
**acceptance** requires a complete document identity.

The public mutation is an action-discriminated union:

- `accept` carries the server-advertised Consent type/version, document key and
  document revision, plus `operationId` and `expectedRevision`. The server accepts
  it only when that exact document is currently eligible in the environment.
- `withdraw` carries only the owned Consent type/version, `operationId`, and
  `expectedRevision`. It rejects client-supplied document identity. The server
  resolves the target acceptance decision from the owned projection and does not
  require the document to remain current, reviewed, or reachable.

Accepted decisions have no target; new accepted decisions have both document
fields while legacy accepted backfill may have neither. Withdrawn decisions
reference their target acceptance and store no separate document identity. A new
withdrawal targeting an unmapped legacy acceptance is sourced as `privacy_ui`,
not `legacy_backfill`; the target truthfully retains unknown document identity.
Public `action=accept|withdraw` maps explicitly to ledger
`decision=accepted|withdrawn`.

An unmapped legacy acceptance does not satisfy the post-migration third-party AI
gate by default. It remains withdrawable and is retained as history while the
user may create a new, document-bound accepted decision from the existing
projection without a fabricated withdrawal. Any grandfathering requires separate
product/legal approval and verified evidence.

Add a supporting unique key on
`consents(id, user_id, consent_type, consent_version)`, then enforce composite
source columns
`consent_decisions(consent_id, user_id, consent_type, consent_version)` to
reference `consents(id, user_id, consent_type, consent_version)` with
`ON DELETE CASCADE`. This proves each ledger row belongs to the same user's same
policy projection and continues the current `users -> consents` lifecycle without
an independent, potentially contradictory user foreign key. A supporting unique
key on the decision ID plus those parent-identity columns allows a withdrawal's
composite self-reference to prove it points into the same projection; that
reference also uses `ON DELETE CASCADE`. Inside the locked transaction, the
service additionally requires the target to be
`decision=accepted,outcome=applied`, because the foreign key alone does not prove
those values. These are engineering lifecycle relationships, not approval of
production account-deletion or legal-retention policy.

Do not store policy bodies, IP addresses, user agents, session values,
psychological content, content fingerprints, or arbitrary metadata.

### Retry and concurrency

Every user mutation has a stable operation ID and expected state revision. After
authentication, user scoping, CSRF, request-shape, and operation-ID validation,
the transaction first looks up `(user_id, operation_id)` **before** applying
current Registry or state rules. An exact semantic match returns the original
receipt plus latest state even after policy or document changes. Reusing the ID
for different normalized request fields is a conflict. A withdrawal's
server-resolved target is stored in the receipt and is not a client comparison
field or re-derived prerequisite for replay.

Only a new operation performs current business validation, locks the projection,
and re-queries the operation after any lock wait. Two identical concurrent first
submissions therefore create one receipt and both resolve to it; they do not
degrade into one success and one ordinary stale conflict. If uniqueness wins only
after a transaction is marked failed, the loser rolls back and re-queries in a
fresh transaction. Different operations from one expected revision produce one
winner and one explicit stale-state result.

The first acceptance of a missing projection uses expected revision 0 and commits
revision 1. A new acceptance of the already active exact document, or a new
withdrawal of an already withdrawn projection, writes a durable `no_change`
receipt without incrementing state revision. The withdrawal receipt points to the
acceptance recorded by the most recent applied withdrawal. Projection timestamps
describe only the latest state; earlier timestamps remain in the ledger. History
uses stable `(occurred_at, id)` ordering and a versioned cursor.

A withdrawal target is always the projection's latest
`decision=accepted,outcome=applied` authorization. An accepted `no_change`
receipt is replay evidence only and never becomes an execution dependency or
withdrawal target.

A confirmed rollback changes neither decision nor projection. A lost commit
acknowledgement is an unknown result: the client/server re-queries or retries the
same operation ID and does not claim the database was unchanged. Replaying an old
withdrawal after re-acceptance returns its original receipt and may reconcile
cleanup only for its original target acceptance; it cannot cancel work authorized
by the later acceptance.

### Effective withdrawal and execution dependency

Withdrawal becomes effective when the database transaction commits. AI execution
binds the exact required Consent decision revisions before Provider dispatch.
A committed withdrawal cancels pending executions and active executions dependent
on that revision, and clears matching Incognito contexts. Withdrawal of a
historical revision does not cancel an execution authorized solely by a newer
revision.

Re-acceptance cannot revive old work. New operations remain ordered by expected
revision, while replay of a committed operation remains available independently
of later revisions.

Execution registers as cancellable before Consent validation. Pending execution
records contain required policy keys and a local Consent epoch until they bind a
bounded snapshot of exact acceptance decision IDs/state revisions. A required
change before binding fails closed; an unrelated historical withdrawal does not
cancel the pending execution. Idle Incognito contexts containing text store the
same bounded dependencies and are cleared when a dependency is withdrawn.

Before input classification, generation, and output classification, the
application uses one narrow per-user `ConsentDispatchGuard`:

```ts
interface ConsentDispatchGuard {
  start<T>(
    execution: ConsentBoundExecution,
    kind: 'risk_classification' | 'generation' | 'output_classification',
    startTransport: (signal: AbortSignal) => T,
  ): Promise<{ readonly transport: T }>;
}
```

Inside the critical section, the guard performs the final database snapshot,
revoked-marker, deadline, and `AbortSignal` checks, then invokes
`startTransport`. For the current SiliconFlow adapter that invocation is the
native `fetch(...)` call. Its `Promise<Response>` is returned inside an object so
the lock helper does not assimilate and await it. DNS, TLS, response headers,
first token, and the rest of the response are awaited only after releasing the
lock.

Constructing `streamChat()`'s lazy `AsyncIterable`, or calling
`[Symbol.asyncIterator]()`, is not dispatch. The guarded handoff occurs when the
first iterator advance reaches the adapter's actual `fetch(...)`. Non-streaming
input/output classification uses the same boundary around its actual fetch.

Withdrawal acquires the same per-user lock, locks Consent projections in a stable
order, commits the decision, releases database locks, publishes the revoked
acceptance-decision marker, synchronously aborts matching executions and clears
matching contexts, then releases the user lock. Slow disposal occurs outside the
lock. If withdrawal commits first, later dispatch is refused. If dispatch starts
first, withdrawal treats it as in-flight, attempts abort, and output,
persistence, turn-state, and context-generation barriers reject late results.
The design does not claim atomic ordering between a database commit and network
bytes reaching a third party, nor recall of bytes already received.

Cleanup failure does not restore authorization: the revoked marker keeps future
dispatch and late output fail closed, matching context is purged on later access,
and exact operation replay may reconcile only that scoped cleanup. The per-user
FIFO lock queue observes the existing deadline/abort signal, has configured
global/per-user bounds, removes listeners and timers, and deletes idle lock
entries. Execution registrations, revoked markers, and Incognito dependency
references are similarly bounded and released after abort, timeout, completion,
context removal, or TTL. No callback acquires the Consent lock in reverse order.

The first implementation guarantees this coordination only within one API
process. Cross-instance cancellation remains a production-readiness blocker; no
Redis, queue, or distributed lock is introduced by this ADR.

### Policy-document registry

One code-owned, version-controlled registry supplies the server-authoritative
Consent type/version, immutable document key/revision, display key, URL,
`draft | test_fixture | production_reviewed` status, and effective time.
Development/Test may use visibly synthetic fixtures. Staging/Production may use
only production-reviewed entries; an environment switch cannot promote a test
fixture.

Registration, Privacy display, AI admission, and acceptance validation use the
same eligible identity. Missing or ineligible content makes those operations fail
closed. It does not block withdrawal, login, Privacy/history reads, or ordinary
history deletion. An eligible `(consentType, consentVersion)` resolves to exactly
one immutable document key/revision; a used version cannot silently point to
replacement content.

This registry is not a policy CMS. Approved legal copy and third-party AI
processing disclosures remain a human product/legal prerequisite.

### Decision lifecycle and retention

Normal acceptance, withdrawal, recovery, and replay do not alter earlier ledger
rows. A separately authorized data-lifecycle deletion is not such a mutation and
may delete a dependency-closed set according to a future approved policy.
Cleanup must never remove the effective acceptance evidence required by a still
active projection. Operation replay is guaranteed only while its receipt remains;
the operation ID is not an indefinite misuse-prevention record.

The first implementation does not create a new retention platform or default to
permanent retention. It does not reuse Conversation's 90-day or RiskEvent's
180-day policy. Production Consent-decision, account-deletion, backup, and
post-account-deletion retention remain separate decisions.

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

ADR-011 remains Accepted except for the narrowly superseded Consent lifecycle and
same-version re-acceptance constraints identified above.

## Consequences

### Benefits

- Users can make a new informed choice without a fake policy version.
- Every accept/withdraw decision remains interpretable.
- Operation replay and state revisions resolve duplicate, late, and multi-tab
  mutations without relying on UI button state.
- Runtime cancellation follows the authorization actually used by an execution.
- Registration, Privacy display, AI admission, and acceptance bind to one
  environment-eligible document identity while withdrawal remains available for
  an owned historical authorization.

### Costs and limitations

- A new table, migration backfill, transaction protocol, and UI states are needed.
- Consent decision retention, account deletion, and backup treatment remain
  undecided; replay is not guaranteed after authorized lifecycle deletion.
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

## Accepted scope and remaining approvals

The accepted engineering/product architecture covers same-version re-acceptance,
action-discriminated mutations, the projection/ledger model and deletion
relationships, operation replay, dependency-scoped cancellation, the
single-process dispatch guarantee, and clearly labelled Development/Test
synthetic document fixtures. Implementation must still complete lossless
migration, exact-replay/concurrency tests, runtime cancellation/cleanup
regression, and the documented environment isolation before this Phase 5C backend
batch is complete.

Acceptance of this ADR does **not** approve legal copy, certify the two existing
Consent types as legally sufficient, approve production document identities or
retention/account-deletion/backup policy, provide cross-instance cancellation,
enable Production AI, or satisfy production readiness. Those remain independent
human product/legal and production-enablement decisions. No approval record for
those matters is implied or created by this ADR.
