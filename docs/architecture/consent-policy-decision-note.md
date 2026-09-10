# Consent Lifecycle Product and Technical Decision Note

- Status: Proposed — product/legal decision pending
- Scope: Phase 5C Consent lifecycle design only
- Current source of truth: ADR-011 remains Accepted and unchanged
- Related proposal: ADR-016 (Proposed)

## 1. Purpose and limits

This note proposes a concrete, implementable lifecycle for accepting,
withdrawing, and later re-accepting a current Consent version. It does not change
the current application, database schema, registration requirements, production
safety state, or any Accepted ADR.

The proposal separates product behavior from legal approval. Policy copy,
third-party AI processing notices, retention, and the legal classification of
each user action still require human product/legal review before production use.

Project control status remains unchanged:

- Overall Phase 5C: not complete
- Production Safety Lock: Enforced
- Production AI Chat: Disabled
- `productionSafe=false`
- Real Model Safety Evaluation: Not Evaluated

## 2. Current implemented behavior

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

The `consents` table has one row per
`(user_id, consent_type, consent_version)`. The row stores `accepted_at`, current
`status`, and optional `withdrawn_at`.

- Accepting a missing current version inserts an accepted row.
- Accepting an already accepted version is idempotent.
- Withdrawing an accepted current or historical row changes it to `withdrawn`.
- Repeating withdrawal returns the same public result, but currently invokes the
  runtime cancellation coordinator again.
- A withdrawn version cannot be re-accepted because the unique row already
  exists and the application returns a conflict.
- A later policy version creates a separate row.

This one-row model cannot preserve more than one accept/withdraw cycle for the
same version.

### Effect on AI and other product capabilities

AI admission requires an accepted row for every exact current required version.
A missing, withdrawn, or stale-version authorization blocks new AI requests.
Authentication, Privacy/history views, and ordinary history deletion remain
separate capabilities.

On every successful withdrawal of a known owned Consent row, including a
historical version, the current process aborts all active AI executions for that
user and clears all of that user's Incognito contexts. Execution registration
before Consent validation and late-result guards prevent Provider output from
being delivered after cancellation. Cross-instance cancellation is not provided.

### Current public surface

- `GET /consents`: authenticated, private/no-store, sanitized current state and
  cursor-paginated history.
- `POST /consents`: authenticated and CSRF-protected accept/withdraw mutation.
- `/app/privacy`: read-only current/history presentation. It has no user-facing
  accept, withdraw, or restore controls.
- Registration requirements provide display keys, not an approved policy-content
  repository.

These are current implementation facts. The same-version recovery flow below is
only a proposal.

## 3. Recommended product decisions

| Decision                                  | Recommendation                                                                                                                                                                                                                                                      | Alternative                                                     | Impact                                                                                                        | ADR change                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Same-version recovery                     | Permit an explicit new acceptance after the user reopens the current approved document. Record a new immutable decision; never erase the earlier withdrawal.                                                                                                        | Keep withdrawal irreversible until a new policy version exists. | Restores use without inventing a version; requires decision history, concurrency control, and new UI.         | Yes, supersedes only ADR-011's single-lifecycle/no-reaccept Consent rule. |
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
approvalStatus: draft | approved
effectiveFrom
processingNoticeKey?   // allowlisted reference, not arbitrary HTML
```

- The server chooses the current approved entry.
- Registration requirements, Privacy display, and mutation validation use the
  same registry entry.
- An absent, draft, or unapproved document makes acceptance unavailable; it must
  not fall back to invented copy or an unreviewed URL.
- A decision records the exact `documentKey` and `documentRevision` it covered.
- Document content remains version-controlled and human reviewable. The database
  does not store arbitrary policy HTML.
- An approved `(consentType, consentVersion)` resolves to exactly one immutable
  `(documentKey, documentRevision)`. Environment-configured required versions
  must resolve to approved registry entries at startup or registration and AI
  admission fail closed. Replacing document content requires a new reviewed
  identity; the registry cannot silently repoint a used version.

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
prior_revision integer not null
resulting_revision integer not null
occurred_at timestamp with time zone not null
document_key text null
document_revision text null
decision_source text not null       // registration | privacy | legacy_backfill
```

Constraints and indexes:

- unique `(user_id, operation_id)` for mutation retry;
- unique `(consent_id, resulting_revision)` for ordered state transitions;
- foreign key to the projection row with a deletion policy decided alongside
  account deletion/retention policy;
- application Zod/TypeScript allowlists for decision and source values;
- a database check that `document_key` and `document_revision` are either both
  present or both null, are present for every new registration or Privacy
  decision, and may be null only for `legacy_backfill`.

`legacy_backfill` is an explicit evidence limitation, not an approved policy
document. If a reviewed deployment artifact proves a legacy
`(consentType, consentVersion)` mapping, migration may preserve that mapped
identity; otherwise both document fields remain null and the UI says the exact
historical document is unavailable. It must never guess the source or document.

An unmapped legacy `accepted` projection does **not** satisfy the post-migration
AI authorization gate for the current document by default. It has
`authorizationStatus=confirmation_required`: login, Privacy, and ordinary history
capabilities remain available, but Provider dispatch remains blocked. The user
may explicitly accept the current approved document through the normal mutation,
which appends a new document-bound `accepted` decision and increments the state
revision without inventing a withdrawal. A product/legal decision may later
approve a specifically evidenced grandfather mapping, but broad implicit
grandfathering is not the safe default.

Do not store IP address, user agent, session or cookie values, psychological
text, content fingerprints, arbitrary metadata, or rendered policy bodies.

### Retention boundary

Decision records are sensitive evidence and must not default silently to forever.
Exact Consent-decision, account-deletion, backup, and post-account-deletion
retention policies remain production blockers. The implementation must make
purge/export policies possible but must not invent a legal retention duration.

## 7. Lossless migration design

Use a new forward-only Drizzle migration; do not edit historical migrations.
Within one migration transaction:

1. Create `consent_decisions` and add projection revision fields.
2. Load an optional, reviewed legacy document mapping. Never infer it from the
   current environment version alone.
3. For each legacy accepted row, insert one immutable `accepted` decision using
   its original `accepted_at`, `decision_source=legacy_backfill`, and either a
   verified mapped identity or explicit null document fields; then set projection
   revision to 1.
4. For each legacy withdrawn row, insert an `accepted` decision at the original
   `accepted_at` and a `withdrawn` decision at the original `withdrawn_at`, both
   marked `legacy_backfill` with the same evidence limitation; then set projection
   revision to 2.
5. Keep projection timestamps as the current-state compatibility view. A later
   re-accept sets `accepted_at` and `effective_at` to the new decision time and
   clears `withdrawn_at` only after the immutable earlier decisions exist. A later
   withdrawal retains the latest `accepted_at` and sets `withdrawn_at` and
   `effective_at` to the withdrawal time.
6. Preserve every existing identifier, type, version, timestamp, and status.
7. Add and validate constraints only after successful backfill.

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
```

History entries represent immutable decisions rather than only projection rows.
They expose document identity only when verified and label `legacy_backfill`
evidence without implying exact document proof. `documentUrl` is present only for
a verified registry identity; `displayKey` labels the Consent type and is not
historical document evidence.

`authorizationStatus` is server-derived:

- `active`: the latest effective decision is accepted and has verified document
  identity matching the current approved registry entry;
- `confirmation_required`: the projection is accepted but its effective evidence
  is an unmapped legacy decision; and
- `inactive`: the required projection is missing/withdrawn, or the record is not
  the current required policy version.

Do not expose internal database IDs, runtime execution IDs, reviewer metadata,
provider internals, or sensitive logs.

### Mutate

Keep `POST /consents` authenticated, session-cookie protected, and CSRF checked.
A mutation includes:

```json
{
  "operationId": "client-generated UUID",
  "action": "accept | withdraw",
  "consentType": "bounded type",
  "consentVersion": "server-advertised version",
  "documentKey": "server-advertised key",
  "documentRevision": "server-advertised revision",
  "expectedRevision": 3
}
```

Rules:

- Same `operationId` and identical mutation returns the original immutable
  receipt plus the latest current projection. It creates no second decision or
  semantic transition. For withdrawal, the server may safely re-enter the
  idempotent local invalidation coordinator.
- Same `operationId` with different fields is a conflict.
- A stale `expectedRevision` returns `CONSENT_STATE_CHANGED` (409) and the client
  must reload; it is never silently applied.
- A stale/non-current document on acceptance returns
  `CONSENT_POLICY_CHANGED` (409).
- Withdrawal may target the current accepted state revision of an owned current
  or historical policy version. Its dependency effects are scoped to that exact
  Consent decision state revision.
- A successful response contains an immutable decision receipt and current state.
- Registration generates its initial decision records server-side in its existing
  atomic transaction; the browser cannot manufacture operation/document facts.

No new public debug, cancellation, or policy-management endpoint is needed.

## 9. Transaction and concurrency protocol

Each mutation performs:

```text
authenticate + authorize + CSRF
validate request against ConsentDocumentRegistry
BEGIN
  lookup (user_id, operation_id)
  if exact replay: skip the database transition
  lock the user's existing projection row for type/version
  if accepting a missing projection: require expected_revision = 0,
    insert under the existing user/type/version unique constraint,
    and map a concurrent winner to CONSENT_STATE_CHANGED
  require expected state_revision
  append immutable decision
  update projection and increment state_revision
COMMIT
for withdrawal, reconcile idempotent local runtime invalidation
```

This gives the following results:

- Double click and network retry with one operation ID create one decision.
- Two tabs starting from the same revision have one winner; the loser reloads.
- A late old withdrawal cannot revoke a later accepted state because its expected
  revision is stale.
- A late old acceptance cannot bypass a later withdrawal for the same reason.
- A replay of an old completed operation returns its historical receipt and the
  latest current state, so the UI cannot mistake the receipt for current status.
- The first acceptance of a new version starts at revision 0 and commits revision
  1. Concurrent insert conflict is a stale-state result, not a generic database
     failure.
- A database failure commits neither decision nor projection. No runtime
  cancellation occurs before commit.
- If post-commit local cancellation reports a failure, authorization remains
  withdrawn and future admission fails closed; the server records safe
  operational metadata. An exact operation replay always re-enters only the
  idempotent local invalidation reconciliation, never the database transition.

The coordinator does not need a second persistent effect state: aborting an
already aborted execution and clearing an already cleared matching context are
defined as idempotent. A retry may invoke those operations again, but it cannot
create a second lifecycle decision or revive/retarget an execution.

The UI may disable buttons for usability, but correctness comes from database
constraints, row locking, revisions, and operation replay.

### AI-admission race linearization

Admission and withdrawal use the same per-user local critical section:

- An execution first registers a cancellable pending record. Before **each**
  third-party dispatch that can carry user text (input classifier, generation, or
  output classifier), it enters the critical section, performs a final database
  revision/snapshot validity check, checks its AbortSignal, and initiates the
  outbound request with that signal before releasing the section.
- Withdrawal enters the section before its database transaction and holds it
  through commit, publication of the locally revoked decision revision, and
  abort/clear reconciliation. It releases the section only after no new local
  dispatch can cross the committed withdrawal boundary.
- If withdrawal commits first, later admission observes the withdrawn projection
  and cannot dispatch.
- If admission initiates Provider dispatch first, a later withdrawal may commit
  and abort that registered execution. Output/persistence guards also reject the
  revoked snapshot. The product does not claim that data already received by the
  third party has been recalled.
- Provider dispatch cannot occur after an unregistered Consent read. Re-acceptance
  creates eligibility for a new execution; it never removes the aborted state
  from the old one.

The current Provider stream is lazy. Merely constructing an `AsyncIterable` is
not the dispatch linearization point. Implementation must either advance it to a
bounded adapter-level "outbound request started" acknowledgement inside the
critical section or make the adapter expose an equivalent eager-start handle.
It must not hold the lock until the first model token, and it must not release the
lock before the HTTP request has actually crossed the application dispatch
boundary.

The locally revoked-revision marker is a fail-closed guard if Abort propagation or
context cleanup itself reports an error. This is still a single-process guarantee.

## 10. Consent admission and runtime cancellation

Introduce a narrow `ConsentExecutionCoordinator` around existing application
boundaries:

1. Register an execution as pending before reading psychological text into any
   third-party request path.
2. In a per-user single-process critical section, validate all exact current
   Consent decision state revisions and bind the resulting authorization snapshot
   to the execution.
3. Only after the snapshot is bound may a Provider request start, and each later
   classifier/generation dispatch revalidates that bound snapshot as described
   above.
4. A committed withdrawal enters the same critical section, aborts pending
   executions and executions bound to the withdrawn revision, and clears
   Incognito contexts carrying that revision dependency.
5. Existing turn generation identity, AbortSignal, deadline, stale-turn, and late
   callback guards continue to prevent cancelled work from emitting or persisting.

Re-acceptance authorizes only new admission. It never resumes an old generation,
recreates an Incognito context, or permits reuse of an old `clientRequestId`.

This is a documented single-process guarantee. Cross-instance cancellation and
context invalidation remain a production-readiness blocker; this phase does not
add Redis, a queue, or a distributed lock.

## 11. Policy-version flow

1. The server registry publishes an approved current document identity.
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

| State                            | UI behavior                                                                                                                                                                           |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Loading                          | Show a labelled loading state; do not expose stale controls.                                                                                                                          |
| Current accepted                 | Show document link/revision and a concise consequence statement; offer Withdraw.                                                                                                      |
| Legacy confirmation required     | Preserve the accepted historical record, explain that the exact current document was not evidenced, block AI, and offer a fresh explicit acceptance of the approved current document. |
| Current withdrawn                | Show when it changed, explain that new AI use is blocked, and offer explicit Re-accept only when the current document is approved.                                                    |
| Current not accepted/new version | Show what changed, document link, Accept, Refuse, and Later. AI remains blocked.                                                                                                      |
| Submitting                       | Disable duplicate interaction for usability and retain the operation ID for retry.                                                                                                    |
| Success                          | Replace state from the server response; announce the result without claiming third-party deletion.                                                                                    |
| Definite failure                 | Keep prior known state and present a retryable, non-sensitive error.                                                                                                                  |
| Network result uncertain         | Do not guess. Retry with the same operation ID or reload current state.                                                                                                               |
| Stale multi-tab state            | Explain that Consent changed elsewhere, reload, and require a fresh explicit action.                                                                                                  |

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
Privacy. Re-acceptance requires viewing the current document identity and a new
affirmative action. It creates a new operation ID and state revision; it does not
reuse a failed turn.

Optionally use `BroadcastChannel` to publish a generic "consent state changed"
invalidation signal between tabs. Do not include policy bodies, psychological
content, session values, or authorization details, and do not persist Consent
state in localStorage/sessionStorage/IndexedDB. Server state remains authoritative.

## 13. Implementation slices

1. **Decision and content foundation**
   - Accept the narrowly scoped ADR after product review.
   - Add the approved document registry and public product-safe DTOs.
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

### Lifecycle and concurrency

- Same-version withdraw then re-accept creates ordered revisions and history.
- Exact operation retry returns one receipt and creates no second lifecycle
  decision; local invalidation may be re-entered idempotently without producing
  a new semantic cancellation.
- Conflicting operation-ID reuse is rejected.
- Concurrent accept/withdraw from the same revision yields one winner.
- Late withdrawal cannot revoke later acceptance; late acceptance cannot bypass
  later withdrawal.
- Failed database transaction changes neither effective authorization nor runtime
  state.
- Historical withdrawal does not cancel work authorized only by a newer version.
- Current withdrawal blocks Provider start in the admission race window.
- Withdrawal during classification/generation aborts work and rejects late output.
- Re-acceptance does not revive cancelled turns, contexts, or request IDs.

### Runtime regression

- Persistent and Incognito Consent gates remain before third-party dispatch.
- Logout/session expiry/current withdrawal cleanup remains correct.
- Existing quota/idempotency, safety, late callback, and memory-capacity tests pass.
- Single-process coverage is labelled accurately; cross-instance behavior is not
  claimed.

### Web and browser P0

- View current state and immutable history.
- Withdraw, confirm consequences, and recover with a new same-version acceptance.
- New version accept/refuse/later and stale-tab refresh.
- Network-uncertain retry uses the same operation ID.
- Active persistent/Incognito generation is cancelled and no stale content appears.
- Existing Persistent/Incognito P0 tests remain green.

### Privacy and security

- Auth, ownership, CSRF, no-store, Zod validation, and structured error envelopes
  remain enforced.
- Logs contain no policy form body, psychological text, Cookie, CSRF token,
  Provider payload, or arbitrary DTO.
- Decision records contain only the allowlisted evidence fields.

## 15. Decisions still requiring confirmation

Only these decisions are needed before implementation:

1. Approve same-version re-acceptance as a new immutable decision and the partial
   supersession of ADR-011.
2. Approve dependency-scoped historical withdrawal rather than cancelling all
   current executions.
3. Product/legal determination of the meaning and approved wording for service
   terms, privacy acknowledgement, and third-party AI processing authorization,
   including whether a future dedicated Consent type is required.
4. Approve the authoritative document source, exact document identities, and
   draft-versus-approved release process.
5. Decide Consent decision/account-deletion/backup retention and cross-instance
   cancellation requirements before production enablement.

Until these are decided, current ADR-011 behavior remains authoritative.
