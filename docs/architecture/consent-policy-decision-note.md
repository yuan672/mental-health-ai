# Consent Lifecycle Product and Technical Decision Note

- Status: Engineering/product architecture accepted — backend implementation in
  delivery; Privacy action UI and production policy/legal approvals pending
- Scope: Phase 5C Consent lifecycle design and backend delivery record
- Current source of truth: ADR-016 (Accepted), with the documented narrow partial
  supersession of ADR-011 and ADR-015

## 1. Purpose and limits

This note records the accepted engineering/product lifecycle for accepting,
withdrawing, and later re-accepting a current Consent version. The implementation
change set containing this update supplies the backend lifecycle, database
migration, and single-process runtime coordination. The complete Privacy action
UI and production content are not yet complete. Engineering delivery does not
change production safety state or imply legal approval.

The proposal separates product behavior from legal approval. Policy copy,
third-party AI processing notices, retention, and the legal classification of
each user action still require human product/legal review before production use.

Project control status remains unchanged:

- Overall Phase 5C: not complete
- Production Safety Lock: Enforced
- Production AI Chat: Disabled
- `productionSafe=false`
- Real Model Safety Evaluation: Not Evaluated

## 2. Implemented backend behavior

### Required Consent and registration

- `ConsentPolicyService` defines exactly `terms_of_service` and
  `privacy_policy` as required types.
- Current versions come from validated server configuration:
  `REQUIRED_TERMS_VERSION` and `REQUIRED_PRIVACY_VERSION`.
- Registration accepts only the exact server-defined required set. User,
  credential, age verification, and the initial accepted Consent rows are
  persisted in one transaction.
- `GET /auth/registration-requirements` exposes only the product contract and is
  served with `Cache-Control: no-store`. The client does not decide which version
  is current.

### Current storage and lifecycle

The `consents` table remains one current-state projection per
`(user_id, consent_type, consent_version)` and now carries a monotonic state
revision and effective time. `consent_decisions` stores immutable applied and
`no_change` receipts for registration, acceptance, withdrawal, exact replay, and
concurrency resolution. Same-version re-acceptance creates a new applied decision
without altering earlier accept/withdraw evidence. Migration backfill preserves
legacy rows with `legacy_backfill` source and no invented document identity.

### Effect on AI and other product capabilities

AI admission requires an accepted row for every exact current required version.
A missing, withdrawn, or stale-version authorization blocks new AI requests.
Authentication, Privacy/history views, and ordinary history deletion remain
separate capabilities.

Each AI execution and idle Incognito context binds the exact applied acceptance
decisions used for admission. A withdrawal cancels or clears only runtime work
that depends on its target acceptance. The same-process dispatch guard orders the
final authorization check with the synchronous outbound `fetch()` initiation;
network waiting is outside the lock, and late-result barriers still prevent
delivery and persistence after revocation. Cross-instance cancellation is not
provided.

### Current public surface

- `GET /consents`: authenticated, private/no-store, sanitized current state and
  cursor-paginated history.
- `POST /consents`: authenticated and CSRF-protected accept/withdraw mutation.
- `/app/privacy`: read-only current/history presentation. It has no user-facing
  accept, withdraw, or restore controls.
- Registration requirements expose the exact eligible document identity and
  display metadata, not a policy CMS or production approval record.

These are current implementation facts for the backend delivery. The user-facing
withdraw/re-accept/new-version flows below remain unimplemented until the
dedicated Privacy UI batch lands.

## 3. Recommended product decisions

| Decision                                  | Recommendation                                                                                                                                                                                                                                                      | Alternative                                                     | Impact                                                                                                        | ADR change                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Same-version recovery                     | Permit an explicit new acceptance after the user reopens the current environment-eligible document. Record a new immutable decision; never erase the earlier withdrawal.                                                                                            | Keep withdrawal irreversible until a new policy version exists. | Restores use without inventing a version; requires decision history, concurrency control, and new UI.         | Yes, supersedes only ADR-011's single-lifecycle/no-reaccept Consent rule. |
| Current-version withdrawal                | Effective when its database transaction commits. Reject new AI admission; cancel pending and active executions that depend on the withdrawn decision; clear dependent Incognito contexts. Keep login, Privacy, ordinary history access, save, and delete available. | Sign the user out or delete history automatically.              | Recommended behavior is narrower, explainable, and avoids conflating Consent with authentication or deletion. | Clarifies the changed lifecycle.                                          |
| Historical-version withdrawal             | Persist the decision, but interrupt only an execution that actually depends on that exact decision revision. Do not cancel use authorized solely by a newer current version.                                                                                        | Cancel every user execution on every historical withdrawal.     | Avoids unrelated disruption while preserving an accurate historical decision.                                 | Yes, narrows cancellation semantics.                                      |
| Repeat mutation                           | Require an operation ID. Retrying the same operation returns its original receipt without creating a decision or semantic transition again. A failed local invalidation may be reconciled idempotently; a new stale operation conflicts.                            | Treat every HTTP request as a new action.                       | Safe for double clicks and uncertain network results.                                                         | Yes, part of lifecycle protocol.                                          |
| Terms, privacy notice, processing consent | Present and explain them separately. Do not assume the two current stored types settle their legal meaning. Keep current registration requirements unchanged until product/legal review.                                                                            | Treat every checkbox as interchangeable "consent".              | Avoids misleading UI; a future dedicated AI-processing authorization may be needed.                           | No schema decision now; future type changes need a separate decision.     |
| New policy version                        | Server registry selects current version. Show changes and require explicit acceptance. Refuse stale submissions; never auto-accept.                                                                                                                                 | Silently carry forward acceptance.                              | Preserves version evidence and prevents stale tabs from authorizing a different document.                     | Compatible with ADR-011.                                                  |
| Refuse / later                            | Both create no acceptance. "Later" only dismisses the prompt; AI remains blocked.                                                                                                                                                                                   | Store a new declined workflow state.                            | Keeps the first implementation minimal.                                                                       | No.                                                                       |

The recommended same-version recovery is preferable to the current irreversible
rule because a withdrawal should not force the project to fabricate a policy
version merely to restore use. The cost is a small immutable decision ledger and
optimistic concurrency protocol; it does not require a general event-sourcing or
policy-management platform.

## 4. Terms, privacy, and AI data-processing boundary

The product presentation must distinguish:

1. **Service terms acceptance**: agreement to the rules for using the service.
2. **Privacy notice acknowledgement**: confirmation that the user had a clear
   opportunity to read how information is processed; acknowledgement is not
   automatically the same legal basis as consent.
3. **Consent to a specific processing activity**: an explicit choice where
   consent is the selected legal basis, including a clear consequence of refusal
   or withdrawal.

The current two type names are sufficient to preserve existing compatibility,
but they are not evidence that the final legal classification or copy is correct.
Before adding a third required type such as `ai_data_processing`, product/legal
review must decide whether the existing privacy-policy action already provides a
valid, specific authorization for sending sensitive text to the selected
third-party AI provider. This design does not add a new type or change
registration conditions.

Relevant current official-law review inputs include the Personal Information
Protection Law requirements concerning legal bases, informed consent,
withdrawal, changes to processing purposes/methods/categories, and sensitive
personal information, and the Civil Code requirements for drawing attention to
and explaining standard terms. These inputs do not constitute a completed legal
review or compliance certification.

Official source references for later human review:

- [Personal Information Protection Law of the People's Republic of China —
  National People's Congress](https://www.npc.gov.cn/npc/c2/c30834/202108/t20210820_313088.html),
  particularly Articles 13–17 and 28–30.
- [Personal Information Protection Law — State Administration for Market
  Regulation](https://www.samr.gov.cn/wljys/gzzd/art/2023/art_3ef1e889c1e644d4b65b5f5c7f432386.html),
  including the effect of withdrawal on processing completed before withdrawal.
- [Civil Code of the People's Republic of China — Ministry of Industry and
  Information Technology](https://gdca.miit.gov.cn/zwgk/zcwj/flfg/art/2020/art_573d6ef5018b46b6a4e1f31ca085a710.html),
  including Article 496 on standard terms.

## 5. Versioned document source

Introduce a code-owned `ConsentDocumentRegistry`, not a CMS. Each selectable
document version has an immutable identity:

```text
consentType
consentVersion
documentKey
documentRevision
displayKey
documentUrl
approvalStatus: draft | test_fixture | production_reviewed
effectiveFrom
processingNoticeKey?   // allowlisted reference, not arbitrary HTML
```

- The server chooses the current environment-eligible entry. Development/Test
  may select an explicitly synthetic `test_fixture`; Staging/Production may select
  only `production_reviewed` content.
- Registration requirements, Privacy display, AI admission, and **acceptance**
  validation use the same registry entry.
- An absent, draft, or environment-ineligible document makes registration, new
  acceptance, and AI admission unavailable. It must not fall back to invented
  copy, an unreviewed URL, or a production override boolean.
- Withdrawal does not depend on the Registry entry remaining current, approved,
  or reachable. It targets an existing owned authorization state and obtains any
  document evidence from that stored acceptance rather than client input.
- A decision records the exact `documentKey` and `documentRevision` it covered.
- Document content remains version-controlled and human reviewable. The database
  does not store arbitrary policy HTML.
- An eligible `(consentType, consentVersion)` resolves to exactly one immutable
  `(documentKey, documentRevision)`. Environment-configured required versions
  must resolve to environment-eligible registry entries at startup or
  registration and AI admission fail closed. Replacing document content requires
  a new reviewed identity; the registry cannot silently repoint a used version.

Synthetic entries are engineering fixtures only. Their key, copy, and local
Provider behavior must be visibly synthetic; they can exercise Development/Test
contracts but cannot satisfy Staging/Production readiness or be reclassified by
an environment flag.

Terminology is deliberately separate:

- **Consent/policy version** identifies the policy edition for which the user
  makes a choice.
- **Document revision** identifies the immutable reviewed artifact bound to that
  policy version.
- **State revision** is the per-user, per-type, per-policy-version transition
  counter used for concurrency; it is not a policy or document version.

## 6. Minimal data model

### Current-state projection

Retain `consents` as the fast current-state projection and compatibility surface.
Add:

```text
state_revision integer not null
effective_at timestamp with time zone not null
```

After migration, `accepted_at` and `withdrawn_at` remain compatibility/current-
projection timestamps. They are not the complete lifecycle evidence after
same-version re-acceptance; immutable evidence lives in the decision table.

### Immutable decision ledger

Add `consent_decisions`:

```text
id uuid primary key
consent_id uuid not null
user_id uuid not null
consent_type text not null
consent_version text not null
operation_id uuid not null
decision text not null             // application allowlist: accepted | withdrawn
outcome text not null              // application allowlist: applied | no_change
prior_revision integer not null
resulting_revision integer not null
occurred_at timestamp with time zone not null
document_key text null
document_revision text null
target_acceptance_decision_id uuid null
decision_source text not null       // registration | privacy_ui | legacy_backfill
```

Constraints and indexes:

- unique `(user_id, operation_id)` for mutation retry;
- partial unique `(consent_id, resulting_revision)` for `outcome=applied` state
  transitions;
- add a supporting unique key on
  `consents(id, user_id, consent_type, consent_version)`, then use composite
  source columns
  `consent_decisions(consent_id, user_id, consent_type, consent_version)` to
  reference `consents(id, user_id, consent_type, consent_version)` with
  `ON DELETE CASCADE`. This proves the ledger row belongs to the same user's same
  policy projection and continues the existing
  `users -> consents ON DELETE CASCADE` lifecycle without an independent,
  potentially contradictory user foreign key;
- add a supporting unique key on
  `consent_decisions(id, consent_id, user_id, consent_type, consent_version)`,
  then use the same parent-identity columns in the composite self-reference from
  `target_acceptance_decision_id` with `ON DELETE CASCADE`. This proves a
  withdrawal target belongs to the same user's same projection. Within the locked
  transaction, the service must additionally validate that the target is
  `decision=accepted` and `outcome=applied`; this value constraint is not claimed
  to be enforced by the foreign key alone;
- application Zod/TypeScript allowlists for decision and source values. Public
  `action=accept|withdraw` maps explicitly to ledger
  `decision=accepted|withdrawn`;
- an accepted decision has no target; new registration/Privacy acceptance must
  have both document fields, while legacy accepted backfill may have both null;
- a withdrawn decision has a target acceptance and stores both document fields
  as null. The service derives the applicable document identity through the
  target instead of copying or trusting it from the withdrawal request;
- `outcome=applied` increments state revision by one; `outcome=no_change`
  preserves it.

`legacy_backfill` is an explicit evidence limitation, not an approved policy
document. If a reviewed deployment artifact proves a legacy
`(consentType, consentVersion)` mapping, migration may preserve that mapped
identity; otherwise both document fields remain null and the UI says the exact
historical document is unavailable. It must never guess the source or document.

An unmapped legacy `accepted` projection does **not** satisfy the post-migration
AI authorization gate for the current document by default. It has
`authorizationStatus=confirmation_required`: login, Privacy, and ordinary history
capabilities remain available, but Provider dispatch remains blocked. The user
may explicitly accept the current environment-eligible document through the
normal mutation,
which appends a new document-bound `accepted` decision and increments the state
revision without inventing a withdrawal. A product/legal decision may later
approve a specifically evidenced grandfather mapping, but broad implicit
grandfathering is not the safe default.

A new withdrawal of that legacy authorization is still allowed. It is a new
`decision=withdrawn`, `decision_source=privacy_ui` operation targeting the legacy
acceptance decision. The target truthfully carries unknown document identity;
the new withdrawal must not be mislabeled as `legacy_backfill` and must not
require the user to accept a replacement document first.

Do not store IP address, user agent, session or cookie values, psychological
text, content fingerprints, arbitrary metadata, or rendered policy bodies.

### Immutability, deletion, and replay lifetime

Normal accept, withdraw, and recovery operations are append-only and cannot
alter earlier decisions. That application immutability does not prohibit a
separately authorized lifecycle deletion.

The recommended engineering relationship is to continue the current account
cascade: deleting a user deletes its Consent projections, which cascade to their
decision ledger; deleting a projection through an approved lifecycle path also
deletes its decisions. The self-reference cascade removes dependent withdrawal
receipts with their target and creates no orphan. This is an engineering deletion
relationship, not approval of a production account-deletion or legal-retention
policy.

Operation replay is guaranteed only while its ledger row remains. An approved
cleanup must never delete the effective acceptance decision needed to authorize
an existing projection. Historical decisions may be deleted only as a
dependency-closed set under a future approved policy; after deletion their old
operation IDs are no longer replayable and must not be described as protected
forever. No 90-day Conversation or 180-day RiskEvent period is reused here.

Exact Consent-decision, account-deletion, backup, and post-account-deletion
retention policies remain production blockers. The first implementation adds no
automatic ledger purge, export, account-deletion feature, or retention platform;
absence of automatic purge is not a promise of permanent retention.

## 7. Lossless migration design

Use a new forward-only Drizzle migration; do not edit historical migrations.
Within one migration transaction:

1. Create `consent_decisions` and add projection revision fields.
2. Load an optional, reviewed legacy document mapping. Never infer it from the
   current environment version alone.
3. For each legacy accepted row, insert one immutable `accepted` decision using
   its original `accepted_at`, `decision_source=legacy_backfill`, and either a
   verified mapped identity or explicit null document fields, with
   `outcome=applied`; then set projection revision to 1.
4. For each legacy withdrawn row, insert an `accepted` decision at the original
   `accepted_at` and a `withdrawn` decision at the original `withdrawn_at`, both
   marked `legacy_backfill` with the same evidence limitation and
   `outcome=applied`. The withdrawal references the backfilled acceptance; then
   set projection revision to 2.
5. Keep projection timestamps as the current-state compatibility view. A later
   re-accept sets `accepted_at` and `effective_at` to the new decision time and
   clears `withdrawn_at` only after the immutable earlier decisions exist. A later
   withdrawal retains the latest `accepted_at` and sets `withdrawn_at` and
   `effective_at` to the withdrawal time.
6. Preserve every existing identifier, type, version, timestamp, and status.
7. Add and validate constraints only after successful backfill.

After migration, a new withdrawal of an unmapped legacy acceptance is an ordinary
`decision_source=privacy_ui` operation. It targets the legacy acceptance decision
and therefore truthfully inherits unknown document evidence; the new withdrawal
itself must not be relabelled as `legacy_backfill`.

Migration must fail atomically on impossible legacy state. It must not delete
rows, synthesize a new policy version, rewrite timestamps, silently repair
conflicts, manufacture a document/source claim, or mark a failed migration as
applied. Tests use an explicitly guarded `*_test` database and cover accepted,
withdrawn, verified/unmapped legacy evidence, mixed-user/version, invalid,
rollback, and migration-from-zero cases.

## 8. API proposal

### Read

Keep `GET /consents` authenticated and `Cache-Control: private, no-store`.
Extend each current item only with product-safe fields:

```text
stateRevision
effectiveAt
documentKey: string | null
documentRevision: string | null
documentUrl: string | null
displayKey
authorizationStatus: active | confirmation_required | inactive
acceptanceEnabled
withdrawalEnabled
```

History entries represent immutable decisions rather than only projection rows.
They expose document identity only when verified and label `legacy_backfill`
evidence without implying exact document proof. `documentUrl` is present only for
a verified registry identity; `displayKey` labels the Consent type and is not
historical document evidence.

`authorizationStatus` is server-derived:

- `active`: the latest effective decision is accepted and has verified document
  identity matching the current environment-eligible registry entry;
- `confirmation_required`: the projection is accepted but its effective evidence
  is an unmapped legacy decision; and
- `inactive`: the required projection is missing/withdrawn, or the record is not
  the current required policy version.

`acceptanceEnabled` is true only when the server can present the exact current
environment-eligible document. `withdrawalEnabled` is independently true for an
existing owned accepted authorization, including historical and legacy-unmapped
records, and does not depend on current Registry eligibility or URL availability.

Do not expose internal database IDs, runtime execution IDs, reviewer metadata,
provider internals, or sensitive logs.

### Mutate

Keep `POST /consents` authenticated, session-cookie protected, and CSRF checked.
The request is an action-discriminated union.

Acceptance binds the exact server-advertised document:

```json
{
  "operationId": "client-generated UUID",
  "action": "accept",
  "consentType": "bounded type",
  "consentVersion": "server-advertised version",
  "documentKey": "server-advertised key",
  "documentRevision": "server-advertised revision",
  "expectedRevision": 3
}
```

Withdrawal targets an existing authorization state and carries no client-supplied
document identity:

```json
{
  "operationId": "client-generated UUID",
  "action": "withdraw",
  "consentType": "bounded type",
  "consentVersion": "existing owned policy version",
  "expectedRevision": 3
}
```

The withdrawal shape rejects `documentKey` and `documentRevision`. The server
loads the targeted owned projection for the authenticated user and resolves its
effective `targetAcceptanceDecisionId`; the client cannot manufacture or
overwrite document identity. A target may be historical or no longer current,
and its Registry document may now be unavailable or environment-ineligible.

An applied acceptance success, for example, returns its immutable document-bound
receipt and latest state:

```json
{
  "success": true,
  "data": {
    "receipt": {
      "operationId": "uuid",
      "action": "accept",
      "outcome": "applied",
      "consentType": "bounded type",
      "consentVersion": "version",
      "documentKey": "server-advertised key",
      "documentRevision": "server-advertised revision",
      "priorRevision": 3,
      "resultingRevision": 4,
      "occurredAt": "RFC 3339 timestamp"
    },
    "current": "latest product-safe Consent state"
  }
}
```

An applied withdrawal success, for example, returns the server-resolved target
evidence when it exists; legacy unknown evidence remains explicitly null:

```json
{
  "success": true,
  "data": {
    "receipt": {
      "operationId": "uuid",
      "action": "withdraw",
      "outcome": "applied",
      "consentType": "bounded type",
      "consentVersion": "version",
      "targetDocumentKey": null,
      "targetDocumentRevision": null,
      "priorRevision": 3,
      "resultingRevision": 4,
      "occurredAt": "RFC 3339 timestamp"
    },
    "current": "latest product-safe Consent state"
  }
}
```

Rules:

- Same `operationId` and identical mutation returns the original immutable
  receipt plus the latest current projection. It creates no second decision or
  semantic transition. For withdrawal, the server may safely re-enter the
  idempotent local invalidation coordinator.
- Same `operationId` with different normalized request fields is a conflict. A
  withdrawal's server-resolved target is stored in its receipt and is not a
  client comparison field.
- A stale `expectedRevision` returns `CONSENT_STATE_CHANGED` (409) and the client
  must reload; it is never silently applied.
- Acceptance requires the server's currently acceptable policy/document identity.
  A stale/non-current/environment-ineligible/missing document returns
  `CONSENT_POLICY_CHANGED` (409) or a fail-closed unavailable error.
- Withdrawal validates an existing owned target and expected revision, but does
  not require the policy to remain current, the Registry entry to remain
  environment-eligible, or its URL to remain available. It never requires
  accepting a new document first.
- Withdrawal targets the effective acceptance decision of that policy projection.
  Its runtime effects are scoped to that acceptance decision ID.
- A new accept operation against an already active, exact document authorization
  stores a durable `outcome=no_change` receipt without changing state revision or
  runtime dependencies. That receipt remains exactly replayable.
- A new withdrawal operation against an already withdrawn projection likewise
  stores a durable `no_change` receipt targeting the acceptance recorded by the
  most recent applied withdrawal and may re-enter only scoped, idempotent cleanup.
- Every withdrawal target is the projection's latest
  `decision=accepted,outcome=applied` authorization. An accepted `no_change`
  receipt is replay evidence only and never becomes an execution dependency or
  withdrawal target.
- A successful response contains an immutable decision receipt and current state.
- Registration generates its initial decision records server-side in its existing
  atomic transaction; the browser cannot manufacture operation/document facts.

Registry absence or an environment-ineligible document blocks acceptance,
registration, and third-party AI admission. It does not block withdrawal, login,
Privacy/history reads, or ordinary history deletion.

No new public debug, cancellation, or policy-management endpoint is needed.

## 9. Transaction and concurrency protocol

Operation replay precedes all rules that can change over time:

```text
authenticate + user scope + CSRF
validate discriminated request shape and operationId

BEGIN
  lookup operation by (authenticated_user_id, operation_id)
  if found:
    compare stored normalized semantic fields
    mismatch -> CONSENT_OPERATION_CONFLICT
    exact -> return original receipt + latest current state

  // Only a genuinely new operation reaches current policy rules.
  accept -> validate current environment-eligible Registry document
  withdraw -> load owned target; do not require a current/eligible Registry entry

  lock the existing user/type/version projection row
  re-query operation after any lock wait
  exact concurrent winner -> return its receipt + latest state
  mismatched concurrent winner -> CONSENT_OPERATION_CONFLICT

  missing accept projection -> require expectedRevision=0 and insert under
    the existing user/type/version unique constraint
  existing projection -> require expectedRevision to match
  append an applied or no_change immutable operation receipt
  update projection only for an applied transition
COMMIT

withdraw -> reconcile cleanup scoped to receipt.targetAcceptanceDecisionId
```

Normalized semantics stored for replay are:

- acceptance: action, type, policy version, expected revision, document key, and
  document revision;
- withdrawal: action, type, policy version, and expected revision; the server-
  resolved target acceptance decision ID is also stored in the receipt.

This gives the following results:

- A policy or document update after an acceptance does not invalidate exact replay
  of that already committed operation, because replay is resolved before current
  Registry validation. The response includes the original receipt and latest
  current state; it does not claim the old acceptance is currently sufficient.
- Replaying an older withdrawal after same-version re-acceptance returns the old
  receipt. Cleanup is limited to its original target acceptance decision, so it
  cannot abort executions or clear contexts bound to the newer acceptance.
- Two identical first submissions may initially both observe no operation. The
  projection lock/re-query and operation unique constraint produce one commit;
  the loser re-queries and returns the same receipt instead of a generic stale
  conflict.
- If an operation unique violation is discovered after the transaction is marked
  failed, the server rolls it back and re-queries `(user_id, operation_id)` in a
  fresh transaction before mapping the result.
- Reusing an operation ID for a different action, Consent type/version, expected
  revision, or acceptance document identity returns
  `CONSENT_OPERATION_CONFLICT`, regardless of later state. The existing receipt's
  server-resolved withdrawal target is returned as stored; it is not re-derived
  before replay resolution.
- A new accept operation while the exact current document is already active writes
  a durable `no_change` receipt with `priorRevision=resultingRevision`. It does
  not create a new authorization dependency or cancel existing work.
- A new withdrawal operation while the target is already withdrawn also writes a
  durable `no_change` receipt pointing to the acceptance recorded by the most
  recent applied withdrawal and performs only scoped idempotent cleanup.
- A late old withdrawal/acceptance using a new operation ID fails expected-revision
  validation and cannot change a later state.
- The first acceptance of a new projection starts at revision 0 and commits
  revision 1. A concurrent projection insert winner is resolved through the same
  operation re-query when IDs match; otherwise it is `CONSENT_STATE_CHANGED`.
- A database error with a confirmed rollback means no operation or projection
  change committed. A connection/acknowledgement loss around commit is instead an
  **unknown result**: the server or client re-queries/replays the same operation ID.
  It must not assert that the database was unchanged until that lookup resolves.
- If an unknown result remains unresolved, the API returns a safe retryable
  `CONSENT_RESULT_UNKNOWN` response and the UI keeps its prior state marked
  uncertain. It does not generate a replacement operation ID.
- If post-commit local cleanup reports a failure, authorization remains withdrawn
  and future admission fails closed. Exact replay re-enters only scoped idempotent
  cleanup, never the database transition.

The coordinator does not need a second persistent effect state: aborting an
already aborted execution and clearing an already cleared matching context are
defined as idempotent. A retry may invoke those operations again, but it cannot
create a second lifecycle decision or revive/retarget an execution.

The UI may disable buttons for usability, but correctness comes from database
constraints, row locking, revisions, and operation replay.

### AI-admission race linearization

The guarantee is deliberately an application-process ordering guarantee, not an
atomic database/network claim. The linearization point for dispatch is when the
API process synchronously invokes the configured transport/native `fetch`; it is
not DNS completion, TLS completion, response headers, first token, or proof that a
byte reached the third party.

The narrow internal contract is:

```ts
type ConsentDependency = Readonly<{
  consentId: string;
  acceptanceDecisionId: string;
  stateRevision: number;
  consentType: ConsentType;
  consentVersion: string;
}>;

type ThirdPartyDispatchKind = 'input_classification' | 'generation' | 'output_classification';

type ConsentBoundExecution = Readonly<{
  id: string;
  userId: string;
  sessionId: string;
  dependencies: readonly ConsentDependency[];
  signal: AbortSignal;
  deadlineAt: Date;
}>;

interface ConsentDispatchGuard {
  start<T>(
    execution: ConsentBoundExecution,
    kind: ThirdPartyDispatchKind,
    startTransport: (signal: AbortSignal) => T,
  ): Promise<{ readonly transport: T }>;

  assertStillUsable(execution: ConsentBoundExecution): Promise<void>;
}
```

`startTransport` must be synchronous and do only the final transport invocation.
The wrapper object is intentional: returning a raw `Promise<Response>` from an
async mutex callback would assimilate it and incorrectly hold the lock until
response headers arrive.

The SiliconFlow adapter applies the guard at its actual native-fetch boundary:

```ts
const { transport: responsePromise } = await dispatchGuard.start(execution, kind, (signal) =>
  fetcher(url, { ...requestInit, signal }),
);

// DNS, TLS, response headers, body and tokens are awaited outside the lock.
const response = await responsePromise;
```

`streamChat()` is currently an async generator. Constructing its
`AsyncIterable` or iterator does not start a request. The first `iterator.next()`
enters `fetchCompletion`; the guard must therefore live around the `fetcher(...)`
call inside `fetchCompletion`, not around iterator construction or the full
`next()` promise. Calling native fetch occurs under the lock; awaiting its promise
does not. `chat()`, `classifyRisk()`, and the output classifier's `chat()` call use
the same guarded fetch path. Provider health checks carry no psychological
content and use a separate explicit content-free path.

For each dispatch, `start()` performs under the per-user lock:

```text
wait with execution AbortSignal and existing total deadline
final database check of every bound acceptance decision/state revision
reject pending, revoked, stale, or aborted execution
synchronously invoke native fetch with the execution AbortSignal
mark this dispatch kind started
release lock
```

This produces the only two supported local-process orderings:

1. Withdrawal acquires the lock first, commits and publishes revocation; later
   fetch invocation is rejected.
2. Dispatch acquires the lock first and invokes fetch; withdrawal later commits,
   treats the request as in-flight, aborts it, and relies on signal, output,
   persistence, turn-state, and context-generation guards to reject late results.

The system does not claim atomic control over database commit and network-byte
delivery and does not claim that withdrawal recalls previously transmitted data.

## 10. Consent admission and runtime cancellation

Introduce `ConsentExecutionCoordinator` around existing application boundaries:

1. Register an execution as pending before Consent lookup. Pending state records
   user/session, the server-required policy keys, an observed local Consent epoch,
   AbortSignal/deadline, and no authorization snapshot yet.
2. Under the per-user lock, validate exact current accepted decisions and bind a
   bounded snapshot of their acceptance decision IDs/state revisions. If a
   current required withdrawal changed the epoch while the execution waited, bind
   fails closed. A historical withdrawal that is not a required dependency does
   not cancel an unrelated pending execution.
3. Every input-classifier, generation, and output-classifier fetch passes through
   `ConsentDispatchGuard.start()` above.
4. Incognito context creation stores the same bounded acceptance-decision
   dependencies on the otherwise existing in-memory context. An idle context
   still containing text is cleared when any of those dependencies is withdrawn.
   A later claim also revalidates them before dispatch.
5. Withdrawal acquires the user lock before opening its transaction, locks Consent
   rows in stable `(consentType, consentVersion, id)` order, commits the decision,
   releases database row locks, publishes the revoked acceptance-decision marker,
   synchronously aborts matching pending/bound executions and clears matching
   contexts, then releases the user lock.
6. Cleanup callbacks only set AbortController/in-memory termination state while
   the lock is held; they do not start database work or recursively acquire the
   Consent lock. More complex disposal runs after lock release.
7. Existing turn identity, AbortSignal, total deadline, database turn state, and
   Incognito generation ID checks call `assertStillUsable()` before emit/append/
   completion and continue rejecting late results.

If abort or context cleanup reports failure after commit, the revoked-decision
marker remains effective. Future dispatch fails its database/marker check, and a
matching context is rejected and purged on its next access. Exact withdrawal
replay may re-enter scoped cleanup. The marker lives while a local execution or
context references that acceptance decision and is removed when the reference
count reaches zero; a configured cap no longer than the maximum execution/context
lifetime protects against faulty cleanup without permitting late results beyond
their existing deadlines.

All coordination structures are bounded and releasable:

- Per-user locks use FIFO waiters with configured per-user/global queue caps.
  Lock acquisition observes the execution AbortSignal and existing total deadline;
  cancelled/timed-out waiters remove listeners/timers and never run the callback.
- Lock map entries are deleted when they have no holder or waiter.
- Active execution dependencies are released on existing timeout/dispose. The
  implementation also adds configured global/per-user active-registration caps
  and rejects overload rather than evicting live work.
- Incognito dependencies live inside the already globally/user/session/context-
  bounded store; scoped withdrawal may scan that bounded store rather than create
  an unbounded reverse index.
- Revoked markers use acceptance-decision ID plus live-reference count and are
  removed after the last bounded execution/context releases them.

The only lock order is:

```text
per-user Consent lock
  -> Consent database transaction / stable row-lock order
  -> commit and release database row locks
  -> publish marker + synchronous abort/clear
release per-user Consent lock
  -> asynchronous disposal if needed
```

AI-turn transactions, Incognito store mutations, and abort listeners must never
acquire the Consent lock in reverse order. Acceptance, withdrawal, binding, and
dispatch all use this order; no lock is held across DNS, TLS, headers, model
generation, output streaming, or an external acknowledgement.

Re-acceptance authorizes only new admission. It never resumes an old generation,
recreates an Incognito context, or permits reuse of an old `clientRequestId`.

This is a documented single-process guarantee. Cross-instance cancellation and
context invalidation remain a production-readiness blocker; this phase does not
add Redis, a queue, or a distributed lock.

## 11. Policy-version flow

1. The server registry publishes the current environment-eligible document
   identity. Development/Test may use only a visibly synthetic fixture;
   Staging/Production requires production-reviewed content.
2. Privacy shows the change and the exact document; no automatic acceptance.
3. The user may accept, refuse, or choose later. Refuse/later leaves AI blocked.
4. A page holding an older identity receives `CONSENT_POLICY_CHANGED`, refreshes,
   and asks for a new explicit decision.
5. New AI admission requires the new current authorization snapshot.
6. Activating a new required version invalidates the older version for new
   admission. The recommended rollout also aborts pending/in-flight local-process
   executions still bound to the superseded required revision as soon as
   practical; it does not claim to recall data already sent. With the current
   environment-config/restart deployment, process restart naturally terminates
   in-memory executions. Any future dynamic rollout must implement this explicit
   invalidation rather than relying on a stale page.
7. History links each decision to the immutable document identity and timestamp
   that applied at that time when verified. A legacy-unmapped entry instead shows
   that exact document evidence is unavailable.

## 12. Privacy UI flow

| State                            | UI behavior                                                                                                                                                                                                                        |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Loading                          | Show a labelled loading state; do not expose stale controls.                                                                                                                                                                       |
| Current accepted                 | Show document link/revision when evidenced and a concise consequence statement. Offer Withdraw even if the Registry later removes the document or its URL is unavailable.                                                          |
| Historical accepted              | Show the stored evidence when available. Permit withdrawal of this owned authorization without requiring the historical document to remain current, approved, or reachable.                                                        |
| Legacy confirmation required     | Preserve the accepted historical record, explain that the exact current document was not evidenced, block AI, permit withdrawal of that authorization, and offer a fresh acceptance only when an eligible current document exists. |
| Current withdrawn                | Show when it changed and explain that new AI use is blocked. Offer explicit Re-accept only when an environment-eligible current document can be displayed.                                                                         |
| Current not accepted/new version | Show what changed and the eligible document, then offer Accept, Refuse, and Later. If no eligible document exists, show an unavailable state and no Accept control. AI remains blocked.                                            |
| Submitting                       | Disable duplicate interaction for usability and retain the operation ID for retry.                                                                                                                                                 |
| Success                          | Replace state from the server response; announce the result without claiming third-party deletion.                                                                                                                                 |
| Definite failure                 | Keep prior known state and present a retryable, non-sensitive error.                                                                                                                                                               |
| Network result uncertain         | Do not guess. Retry with the same operation ID or reload current state.                                                                                                                                                            |
| Stale multi-tab state            | Explain that Consent changed elsewhere, reload, and require a fresh explicit action.                                                                                                                                               |
| Exact operation replay           | Show the original receipt outcome together with refreshed current state; do not present an old receipt as the current authorization decision.                                                                                      |

### Withdrawal interaction

The confirmation explains only that:

- future AI requests requiring this authorization will be blocked;
- active local-process AI work depending on it will be cancelled;
- affected Incognito runtime context will be cleared and cannot be restored;
- previously sent data is not thereby recalled from a third party;
- ordinary login, Privacy, history viewing, and history deletion remain available.

The flow should be clear and short. It must not introduce unnecessary friction,
hide the action, bundle unrelated choices, promise backup deletion, or claim that
all RiskEvent/Audit records disappear.

### Recovery and multi-tab behavior

When AI is blocked because a current version is withdrawn, the Chat UI links to
Privacy. Re-acceptance requires viewing the current environment-eligible document
identity and a new affirmative action. It creates a new operation ID and state
revision; it does not reuse a failed turn. If no eligible document is available,
the UI remains fail closed while still allowing withdrawal and ordinary non-AI
account capabilities.

Optionally use `BroadcastChannel` to publish a generic "consent state changed"
invalidation signal between tabs. Do not include policy bodies, psychological
content, session values, or authorization details, and do not persist Consent
state in localStorage/sessionStorage/IndexedDB. Server state remains authoritative.
An invalidation signal only prompts a reload; a stale tab still submits
`expectedRevision` and cannot win through client-side timing. A result-unknown
state keeps the original operation ID until the server resolves its receipt or
the user explicitly abandons that action.

## 13. Implementation slices

1. **Decision and content foundation**
   - Accept the narrowly scoped ADR after product review.
   - Add the environment-aware document registry, synthetic test fixtures, and
     public product-safe DTOs.
2. **Persistence and service protocol**
   - Add decision ledger and projection revision through a lossless migration.
   - Implement transactional operation replay and concurrency conflicts.
3. **Admission and cancellation hardening**
   - Bind exact Consent revision snapshots to persistent and Incognito executions.
   - Make withdrawal invalidation dependency-scoped and idempotent.
4. **Privacy product flow**
   - Add current/history, withdraw, same-version re-accept, policy-change, and
     uncertain-result UI states.
5. **Documentation and production review**
   - Bind approved content and third-party AI disclosure; retain unresolved legal,
     retention, and cross-instance blockers explicitly.

Each slice uses its own feature branch/PR and CI boundary where practical. No
Phase 5D/5E/6 work is implied.

## 14. Acceptance plan

### Migration and persistence

- Empty database applies all migrations.
- A database at the prior migration upgrades without changing existing IDs,
  status, or timestamps.
- Accepted and withdrawn rows backfill into one/two immutable decisions.
- Invalid legacy state fails and rolls back without partial schema/data changes.
- Repeated cycles preserve all decision evidence.
- History ordering and cursoring use `(occurred_at DESC, id DESC)` with a new
  cursor version; legacy entries expose absent verified document identity instead
  of fabricating it.
- An unmapped legacy current acceptance yields `confirmation_required`, blocks
  third-party dispatch, and can be followed by a new document-bound acceptance
  without a synthetic withdrawal or policy version.
- An unmapped legacy authorization can still be withdrawn. The new withdrawal
  targets the backfilled acceptance, uses `decision_source=privacy_ui`, preserves
  the target's unknown document identity, and never fabricates evidence.
- An authorization remains withdrawable when its Registry entry is missing,
  environment-ineligible, superseded, or its document URL is unavailable.
- The ledger and projection foreign keys use the documented cascades and create
  no orphan rows; lifecycle deletion is tested separately from normal immutable
  decision operations.
- Composite foreign-key tests reject a ledger row whose user/type/version differs
  from its projection and reject a withdrawal target from another user or policy
  projection. Repository tests reject a same-projection target that is not an
  applied acceptance.
- A failed migration or backfill rolls back both schema and data changes and is
  not marked applied.

### Lifecycle and concurrency

- Same-version withdraw then re-accept creates ordered revisions and history.
- Exact operation retry returns one receipt and creates no second lifecycle
  decision; local invalidation may be re-entered idempotently without producing
  a new semantic cancellation.
- Exact replay of an old acceptance still returns its receipt after a Registry or
  policy update, while the accompanying current state accurately reports whether
  it remains sufficient for admission.
- Conflicting operation-ID reuse is rejected.
- Two concurrent first submissions of the same normalized operation create one
  receipt and both resolve to it; they do not degrade into one success plus an
  ordinary stale conflict.
- Concurrent different accept/withdraw operations from the same revision yield
  one winner and one explicit stale-state result.
- Late withdrawal cannot revoke later acceptance; late acceptance cannot bypass
  later withdrawal.
- Replaying an older withdrawal after re-acceptance returns the older receipt and
  reconciles only the old acceptance dependency; it cannot cancel executions or
  contexts bound to the later acceptance.
- A new accept against an already active exact document and a new withdraw against
  an already withdrawn target create durable, exactly replayable `no_change`
  receipts without inventing state transitions.
- An accepted `no_change` receipt cannot become a later withdrawal target or
  execution dependency; both resolve to the latest applied acceptance.
- Failed database transaction changes neither effective authorization nor runtime
  state.
- A lost commit acknowledgement is treated as an unknown result, not a confirmed
  rollback. Re-query/retry with the original operation ID resolves it without a
  second decision.
- Historical withdrawal does not cancel work authorized only by a newer version.
- If withdrawal commits before guarded dispatch, Provider start is refused. If
  guarded dispatch starts first, withdrawal records an in-flight request, aborts
  it, and the late-result barriers prevent delivery or persistence.
- Withdrawal during classification/generation aborts work and rejects late output.
- Re-acceptance does not revive cancelled turns, contexts, or request IDs.

### Runtime regression

- Persistent and Incognito Consent gates remain before third-party dispatch.
- Input classification, generation, and output classification all use the same
  guarded final Consent check and synchronous outbound-request handoff.
- A pending execution without a bound snapshot is rejected if a required Consent
  changes before binding; an unrelated historical withdrawal does not cancel it.
- Withdrawal clears an idle Incognito context that still contains text and is
  bound to the withdrawn acceptance, not only an actively generating context.
- When immediate cleanup fails, the revoked-dependency marker still rejects late
  output and future dispatch; later access/replay completes scoped cleanup.
- Per-user lock entries, queued waiters, execution registrations, revoked markers,
  and Incognito dependency references release after abort, timeout, completion,
  context deletion, or TTL cleanup and remain within configured bounds.
- Logout/session expiry/current withdrawal cleanup remains correct.
- Existing quota/idempotency, safety, late callback, and memory-capacity tests pass.
- Single-process coverage is labelled accurately; cross-instance behavior is not
  claimed.

### Web and browser P0

- View current state and immutable history.
- Withdraw, confirm consequences, and recover with a new same-version acceptance.
- New version accept/refuse/later and stale-tab refresh.
- Network-uncertain retry uses the same operation ID.
- A missing/environment-ineligible/current-document change disables acceptance
  but does not disable withdrawal, login, Privacy, history viewing, or history
  deletion.
- A user can withdraw an unmapped legacy authorization and receives history that
  distinguishes its unknown legacy evidence from the newly recorded withdrawal.
- Active persistent/Incognito generation is cancelled and no stale content appears.
- Existing Persistent/Incognito P0 tests remain green.

### Privacy and security

- Auth, ownership, CSRF, no-store, Zod validation, and structured error envelopes
  remain enforced.
- The action union rejects missing/stale document identity on acceptance and
  rejects any client-supplied document identity on withdrawal.
- Development/Test accepts only visibly synthetic `test_fixture` entries;
  Staging/Production rejects them and accepts only `production_reviewed` entries.
  No environment boolean can promote a fixture.
- Logs contain no policy form body, psychological text, Cookie, CSRF token,
  Provider payload, or arbitrary DTO.
- Decision records contain only the allowlisted evidence fields.

## 15. Accepted implementation basis and remaining decisions

The engineering/product architecture is accepted for implementation with
synthetic Development/Test documents:

1. Same-version re-acceptance creates a new immutable applied decision and
   narrowly supersedes ADR-011's single-lifecycle rule.
2. Historical withdrawal is dependency-scoped instead of cancelling unrelated
   current work.
3. Mutations use the action-discriminated contract, operation-first replay,
   projection/ledger relationships, and single-process dispatch coordination.
4. The code-owned Registry enforces `test_fixture` versus
   `production_reviewed` environment isolation.

The following are independent production-enablement decisions, not blockers to
implementing and testing the architecture with synthetic fixtures:

- Product/legal determination of the meaning and approved wording for service
  terms, privacy acknowledgement, and third-party AI processing authorization,
  including whether a future dedicated Consent type is required.
- Approval of authoritative production document identities, content, links, and
  release governance.
- Consent decision/account-deletion/backup retention and deletion policy.
- Cross-instance cancellation requirements and implementation.

These production-only decisions do not prevent engineering validation with
synthetic fixtures, but they continue to keep production acceptance and AI use
fail closed. The backend implementation and migration now enforce ADR-016 on this
delivery branch; Phase 5C remains incomplete until the Privacy action UI is
implemented and reviewed.
