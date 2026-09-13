# Data Lifecycle and Account Deletion Decision Design

- Status: Proposed for review
- Scope: NF-02 data-lifecycle and account-deletion decision design
- Baseline: `develop@bc7f4a72adcfd44a8cc3e2e36cf4d5740874ad6c`
- Delivery: documentation only; no API, schema, migration, scheduler, backup, or
  retention-policy change is implemented by this document
- Source priority: `docs/HANDOFF.md`, Accepted ADRs, current schema/migrations and
  code, then API/status documents

This document separates current engineering facts from a candidate account-deletion
contract. It is not a legal-retention conclusion, a production privacy promise, or
evidence that account deletion already exists.

## 1. Scope and terminology

This review covers User identity, Consent, Conversation, AI, Mood, Quota, Safety,
Audit, Staff, Knowledge, Incognito runtime state, application logs, backups, and
third-party data boundaries. It does not design a user interface, export feature,
generic retention platform, distributed cancellation service, or a permanent
deletion-operation ledger.

The following terms are deliberately distinct:

- **logically hidden**: normal reads exclude a row, although it still exists;
- **body hard-deleted**: sensitive content rows are physically removed;
- **metadata purged**: a later cleanup physically removes remaining rows;
- **cascade**: PostgreSQL removes dependent rows through a foreign key;
- **set null**: PostgreSQL removes one live relationship but retains the child row;
- **independent retention**: a row follows its own deadline rather than its former
  parent lifecycle; and
- **external copy**: logs, backups, or data already delivered to a provider are not
  erased merely because the primary PostgreSQL row is deleted.

`ON DELETE SET NULL` is not anonymization. A retained Risk Event or Audit row can
remain sensitive because its bounded metadata, timestamps, resource identifiers,
and surrounding records may still be linkable.

## 2. Current implementation facts

### 2.1 Existing user-visible lifecycle operations

| Operation                   | Current effect                                                                                                                                                                       | What it does not do                                                                                                                  | Evidence                                                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Logout                      | Revokes the current Session, aborts that Session's active AI executions, and clears its Incognito contexts.                                                                          | It does not delete the User, other Sessions, Consent, history, Mood, Quota, Safety, or Audit data.                                   | `SessionsService.revoke`; `ActiveAiExecutionRegistry.abortSession`; `IncognitoContextStore.clearSession`; ADR-011. |
| Required-Consent withdrawal | Appends a Consent decision, changes the projection when applicable, blocks work dependent on that acceptance, aborts matching AI executions, and clears matching Incognito contexts. | It is not logout, history deletion, account deletion, provider-data recall, or automatic retraction of previously delivered results. | `ConsentLifecycleRepository.mutate`; `ConsentExecutionCoordinator.coordinateMutation`; ADR-016.                    |
| Delete one Conversation     | In one transaction, marks the active owned Conversation deleted, immediately deletes its Message rows, and appends a content-free Audit record.                                      | It does not immediately remove the Conversation metadata row, Risk Event, Audit record, backup, or provider copy.                    | `ConversationRepository.delete`; ADR-012; `conversation-access.integration.spec.ts`.                               |
| Delete all Conversations    | Marks every not-yet-deleted owned Conversation, deletes their Messages, and appends one aggregate Audit record. Saved and expired rows are included.                                 | It does not delete the User, Mood, Consent, Risk Event, Audit history, or backups.                                                   | `ConversationRepository.deleteAll`; ADR-015.                                                                       |
| Delete Mood                 | Hard-deletes one row at its revision, or every owned Mood row, with a content-free Audit record in the same transaction.                                                             | It does not delete the User or rewrite retained Audit.                                                                               | `MoodRepository.delete`/`deleteAll`; ADR-017.                                                                      |
| End Incognito context       | Aborts its active generation and clears its process-memory text/context state.                                                                                                       | It cannot recall data already sent to a provider and does not delete permitted Safety/Audit records.                                 | `IncognitoContextStore.end`; ADR-015 and ADR-016.                                                                  |
| Disable Staff principal     | Makes Staff access terminal for the delivered batch, advances authorization revision, revokes Sessions, and audits the change.                                                       | It is not Staff hard deletion and does not decide Staff evidence retention.                                                          | `StaffAccessService.disable`; ADR-020.                                                                             |

There is no public account-deletion route, account-deletion service, account state,
deletion receipt, or account-deletion cleanup command in the current codebase.
The fact that `DELETE FROM users` can be exercised by integration tests proves
foreign-key behavior only; it is not a complete product operation.

### 2.2 User and authentication data

| Data                   | Stored content and identifiers                                                                                                         | Current visibility/lifetime                                                              | Physical-delete/FK behavior                    | Existing cleanup and unresolved policy                                                                                                                                     |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users`                | UUID and creation timestamp.                                                                                                           | Exists until a future account lifecycle removes it.                                      | Root row for the ordinary account graph.       | No account-delete service or retention command exists.                                                                                                                     |
| `password_credentials` | User UUID, normalized email, Argon2id password hash, creation time.                                                                    | Used for login and Profile email.                                                        | `user_id` primary FK uses `ON DELETE CASCADE`. | No independent cleanup; email becomes reusable after the row is deleted. Production re-registration/recovery policy is not approved.                                       |
| `sessions`             | Session UUID, User UUID, SHA-256 token hash, creation/expiry/revocation times. Raw bearer and CSRF tokens are not stored in the table. | Fixed seven-day expiry; validation rejects expired/revoked rows. Logout revokes one row. | User FK uses `ON DELETE CASCADE`.              | There is no expired/revoked Session purge command or production schedule. A rejected row can therefore remain physically present until account deletion or future cleanup. |
| `age_verifications`    | User UUID, verified boolean, bounded method, verification timestamp.                                                                   | Read by the minimal Profile.                                                             | User FK uses `ON DELETE CASCADE`.              | No independent retention policy; production verifier and evidence policy remain unresolved.                                                                                |

Evidence: `database/src/schema.ts`, `UsersRepository`, `SessionsService`,
`ProfileRepository`, ADR-011, and ADR-017.

### 2.3 Consent, user content, and quota

| Data                           | Stored content and identifiers                                                                                                                                                                                                                       | Current visibility/lifetime                                                                                                                                                  | Physical-delete/FK behavior                                                                                                                                                    | Existing cleanup and unresolved policy                                                                                                  |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `consents` projection          | User/type/version, accepted/withdrawn status, revision and effective timestamps.                                                                                                                                                                     | Current and historical projections remain while the account exists.                                                                                                          | User FK cascades.                                                                                                                                                              | No independent purge. Production Consent evidence retention/account-deletion treatment is explicitly undecided in ADR-016.              |
| `consent_decisions` ledger     | Projection/User/type/version, operation UUID, bounded decision/outcome/source, revisions, timestamps, document identity or withdrawal target. It contains no policy body, IP, user agent, Session token, psychological text, or content fingerprint. | Normal accept/withdraw operations append decisions and do not rewrite previous decisions. Exact operation replay is guaranteed only while authorized lifecycle data remains. | Composite projection FK and target-acceptance self-FK cascade. Deleting the User cascades projection then ledger.                                                              | No independent purge. The current FK is an engineering relationship, not production legal-retention approval.                           |
| `conversations`                | User UUID, creation/expiry, saved flag, short-lived deletion timestamp.                                                                                                                                                                              | Unsaved rows are logically hidden after 90 elapsed days. Saved rows have no automatic expiry. Deleted rows are immediately hidden.                                           | User FK cascades. The explicit purge physically deletes expired/deleted rows.                                                                                                  | `pnpm data:purge-conversations` exists; no production scheduler is wired.                                                               |
| `messages`                     | Conversation UUID, role, sequence, psychological text, timestamp.                                                                                                                                                                                    | Lifetime derives entirely from the parent Conversation.                                                                                                                      | Conversation FK cascades. Explicit Conversation deletion hard-deletes Messages immediately.                                                                                    | No independent retention or tombstone.                                                                                                  |
| `ai_turns`                     | User/Conversation/client-request IDs, state, prompt key/version, optional Message references, failure/lease/timestamps. No prompt or answer body.                                                                                                    | Follows the ordinary Conversation lifecycle.                                                                                                                                 | User and Conversation FKs cascade; optional Message FKs set null. In normal Conversation purge the Conversation cascade removes the Turn.                                      | No independent turn-retention command. Its idempotency boundary disappears when the Turn is purged.                                     |
| Assistant Knowledge references | Assistant Message UUID, exact immutable Knowledge-version UUID, ordinal.                                                                                                                                                                             | Follows the Assistant Message lifecycle.                                                                                                                                     | Message FK cascades; Knowledge-version FK restricts version deletion while referenced. Deleting the Message removes the reference before any Knowledge deletion is considered. | No independent retention. It is not a permanent citation ledger.                                                                        |
| `mood_entries`                 | User/client-request IDs, score, optional bounded emotion/note, revision, timestamps.                                                                                                                                                                 | Account lifetime unless explicitly hard-deleted; not subject to Conversation's 90-day rule.                                                                                  | User FK cascades. Explicit Mood deletion hard-deletes rows.                                                                                                                    | No automatic Mood expiry. Production account/backup policy is undecided.                                                                |
| `daily_usage_quotas`           | User, Asia/Shanghai date, configured limit snapshot, count, timestamps.                                                                                                                                                                              | PostgreSQL source of truth for each day.                                                                                                                                     | User FK cascades.                                                                                                                                                              | No retention cleanup is defined. The fixture limit is not production policy.                                                            |
| `quota_consumptions`           | User, original usage date, content-free idempotency key and timestamp.                                                                                                                                                                               | Row supports cross-day replay while present. A qualifying refund deletes it and decrements its original-day aggregate.                                                       | User FK cascades.                                                                                                                                                              | Refund/idempotency is deliberately bounded; deletion of the row removes that guarantee. No general quota-history cleanup policy exists. |

Evidence: `database/src/schema.ts`, `ConversationRepository`, `MoodRepository`,
`QuotaRepository`, ADR-012, ADR-013, ADR-016, ADR-017, and ADR-019.

### 2.4 Safety and Audit data

| Data                       | Stored content and identifiers                                                                                                                                                                                                                                   | Current visibility/lifetime                                                                                                        | Physical-delete/FK behavior                                                                                                                   | Existing cleanup and unresolved policy                                                                                                                                                                     |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `risk_events`              | Nullable User/Conversation/AI-Turn/Message references; client-request ID; Incognito flag; bounded risk level/categories/reason codes; policy/classifier identity; timestamps. It contains no Message body, prompt, Provider payload, reasoning, or content hash. | Independent configured retention. The current engineering/default value is 180 days, not a legal requirement.                      | User, Conversation, Turn, and Message FKs use `ON DELETE SET NULL`. The row survives those parent deletions.                                  | `pnpm data:purge-safety` removes expired rows in batches; no production scheduler/policy approval exists. Set-null rows remain sensitive and may remain linkable.                                          |
| `human_review_queue_items` | Risk Event UUID, priority/state, optional opaque reviewer ID, workflow timestamps and bounded resolution.                                                                                                                                                        | Has value only with its Risk Event.                                                                                                | Risk Event FK uses `ON DELETE CASCADE`; one queue item per event.                                                                             | Removed when Risk Event is purged. No independent retention.                                                                                                                                               |
| `audit_logs`               | Actor type and optional actor ID, action, resource type/UUID, idempotency key, timestamp, action-specific allowlisted metadata, retention deadline.                                                                                                              | Independent configured retention; `.env.example` currently supplies 90 days for Development/Test. This is not production approval. | It intentionally has no User, Staff, Risk, Conversation, Mood, or Knowledge FK. Deleting those records does not rewrite or delete Audit rows. | `pnpm data:purge-safety` removes expired rows in batches; no production scheduler is wired. Existing rows may retain User/Staff/resource UUIDs in `actor_id`, `resource_id`, or internal idempotency keys. |

The Audit writer validates action/resource/metadata through `audit.types.ts`.
Examples include content-free Conversation/Mood deletion metadata, bounded review
state, Staff authorization revision, and Knowledge version/draft revision. Arbitrary
DTOs, errors, chat text, Mood content, credentials, or Provider payloads are not
accepted. `actor_id`, `resource_id`, and `idempotency_key` are nevertheless
correlation identifiers and must be covered by production retention policy.

Evidence: `RiskEventRepository`, `AuditLogRepository`,
`RiskEventRetentionPolicy`, `AuditRetentionPolicy`, `purge-safety-data.ts`,
`audit.types.ts`, ADR-014, and `ai-safety.integration.spec.ts` retention tests.

### 2.5 Staff and Knowledge evidence

| Data                                | Stored content and identifiers                                                                                                            | Current visibility/lifetime                                                                                                                               | Physical-delete/FK behavior                                                                                                                                                                   | Existing cleanup and unresolved policy                                                                                                                                                                                |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `staff_principals`                  | Staff UUID, active/disabled status, authorization revision and timestamps.                                                                | Disablement is terminal in the current batch; disabled rows remain.                                                                                       | Root of the Staff identity graph.                                                                                                                                                             | No Staff hard-delete API or retention cleanup. Production offboarding/MFA/recovery/retention remain unresolved.                                                                                                       |
| Staff credentials/Sessions          | Normalized email, Argon2id hash; separate Session UUID/token hash/revision/expiry/revocation.                                             | Session validation requires active principal and exact revision.                                                                                          | Principal FK cascades for credentials and Sessions.                                                                                                                                           | No expired/revoked Staff Session purge command.                                                                                                                                                                       |
| Staff role grants                   | Role/source/grant and optional revocation actor/time evidence.                                                                            | Revocation is retained; trigger prevents changing grant evidence or a completed revocation.                                                               | Principal FK cascades for owned grants; grant/revoke actor FKs set null.                                                                                                                      | No hard-delete or retention policy. Set-null actor fields are not anonymization.                                                                                                                                      |
| Knowledge articles/versions/sources | Stable article key; versioned body blocks; content origin; review/publication state; opaque reviewer label/time; ordered source evidence. | Verified/published/withdrawn evidence is immutable. Withdrawal hides a version but does not erase it. No automatic content-version retention is selected. | Article to versions and version to sources cascade. Source/version triggers freeze reviewed evidence. A referenced version cannot be deleted until all Assistant Message references are gone. | No Knowledge purge command. `reviewed_by` is an opaque string, not a Staff FK, so Staff deletion would not erase or authenticate historical review evidence. Production publication still requires real human review. |

Global Knowledge data is not owned by an ordinary User account and is not part of
ordinary account deletion. Staff identity is a separate security domain; deleting
an ordinary User can never grant, revoke, or remove Staff authority.

Evidence: migrations `0007`, `0008`, `0009`, and `0010`; `database/src/schema.ts`;
ADR-018, ADR-019, and ADR-020.

### 2.6 Process memory and external boundaries

| Boundary                                 | Current fact                                                                                                                                                                                                                                             | Deletion implication                                                                                                                                                                                                                  |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Incognito context                        | Whole recent messages and used request IDs are held only in a bounded process-memory store. TTL defaults to 30 minutes, capped by Session expiry; explicit end/logout/invalid Session/Consent withdrawal clear matching state. Process restart loses it. | A future account delete must call `clearUser` and abort its active generation before/while deleting the database account. Database cascade alone cannot clear memory. Permitted Risk/Audit metadata is separate.                      |
| Active AI and Consent coordination       | Active/pending executions, dependency epochs, revoked markers, and per-user waiters are bounded process memory. Consent protects final dispatch and late output only inside one API process.                                                             | Account deletion must share a user-scoped coordination order, block new dispatch, abort existing work, and reject late output. Cross-instance cancellation remains unimplemented.                                                     |
| HTTP abuse protection                    | Direct-network/principal keys and token state are bounded process memory and not persisted or logged.                                                                                                                                                    | Account deletion requires no database erasure for this state; keys expire/refill or disappear on process restart. They are not claimed to be anonymous.                                                                               |
| Application/Security/AI operational logs | Structured stdout metadata can include internal User, Session, Conversation, Message, Turn, or Risk Event IDs. Redaction prevents bodies, credentials, and Provider payloads.                                                                            | The repository owns no log sink, retention schedule, or erasure API. Primary-database deletion cannot prove sink deletion. Production sink retention/access must be approved separately.                                              |
| Backups                                  | No production backup/restore/deletion policy or verified restore run exists.                                                                                                                                                                             | Primary deletion does not immediately remove historical backup copies. A restored backup could reintroduce rows unless restore procedures reapply approved deletion state before service. No such mechanism is currently implemented. |
| Third-party provider                     | Consent-gated classification/generation can send bounded user content to the configured Provider.                                                                                                                                                        | The service cannot recall bytes already received by the Provider or claim Provider-side deletion. Provider retention/privacy/security terms and deletion mechanisms require separate review.                                          |

Evidence: `IncognitoContextStore`, `ActiveAiExecutionRegistry`,
`ConsentExecutionCoordinator`, `ProcessLocalTokenBucketStore`, ADR-007, ADR-013,
ADR-015, ADR-016, ADR-019, and ADR-021.

## 3. Candidate account-deletion contract

The recommendation below is proportionate to the current single-process local
learning/demo target. It must be accepted before implementation and does not close
production retention, backup, provider, or multi-instance requirements.

### 3.1 Recommended public command

Use one authenticated command endpoint rather than overloading logout or Consent:

```http
POST /account/deletion
Content-Type: application/json
Origin: <allowed Web origin>
X-CSRF-Token: <double-submit value>

{
  "operationId": "<uuid>",
  "currentPassword": "<password>",
  "acknowledgeIrreversible": true
}
```

Recommendations:

- require a current ordinary Session, trusted Origin, CSRF, strict Zod parsing, and
  current-password reauthentication through the existing bounded Argon2 admission;
- never accept a target User ID or email from the body;
- never log the body, password, Cookie, CSRF, operation ID, or email;
- make the command unavailable to Staff and keep Staff offboarding separate;
- use `204 No Content` after a confirmed commit and expire both browser cookies;
- do not add a public deletion-status endpoint or a permanent receipt/tombstone in
  the first implementation; and
- treat `operationId` as a bounded command correlation/Audit idempotency value, not
  an access credential, a caller-authentication mechanism, or indefinite proof that
  a prior attempt committed.

Before the destructive boundary, a bounded process-local attempt registry reserves
both the global `operationId` and one active deletion slot for the authenticated
User. Its unguessable internal attempt token, not the client UUID alone, binds the
User, request, terminal marker, mutation phase, and any evidence inserted by that
attempt. A same-User/same-ID concurrent exact request may wait for or reconcile that
attempt after independently passing Auth, CSRF, request validation, and password
reauthentication. A different User using the same ID, or a different ID for a User
whose deletion attempt is unresolved, fails closed without entering the destructive
transaction. No response discloses whether the colliding ID exists or which User
previously used it.

The command shape makes the point of no return explicit and avoids relying on a
JSON body on `DELETE`. `DELETE /account` remains a reasonable alternative if the
project prefers resource-style routing; it does not change the required security,
coordination, transaction, or unknown-result semantics.

### 3.2 Recommended coordination and transaction order

There is one process lock, not two. Extend the service that owns
`PerUserConsentLock` with a narrow `coordinateAccountDeletion` entry point. It
acquires that existing non-reentrant lock exactly once and calls only no-lock
helpers while held. The account service must not call `coordinateMutation`,
`reconcileWithdrawal`, `createIncognitoContext`, or another public coordinator
method from inside the callback, because each would try to reacquire the same
User lock and self-deadlock.

Conceptual ordering:

```text
trusted Origin + current Session + CSRF + strict body
  -> bounded Argon2 permit and password verification (outside the User lock)
  -> reserve bounded (operationId, userId, internalAttemptToken)
  -> PerUserConsentLock.runExclusive(userId)
       -> install terminal marker before changing runtime state
       -> abortUser + clearUser through no-lock owned helpers
       -> short PostgreSQL transaction
            -> lock users row
            -> lock/re-read the exact Session
            -> require revoked_at IS NULL and expires_at > database observation time
            -> reject any pre-existing account-deletion Audit key
            -> mark this internal attempt dbMutationStarted exactly once
            -> appendRequired account_deleted Audit
            -> remember in process that this attempt inserted its own Audit
            -> DELETE the locked users row and require one RETURNING row
          COMMIT
       -> confirm commit, rollback, or begin serialized reconciliation
  -> clear cookies and return 204 only for this attempt's confirmed commit
```

Detailed rules:

1. **Admission before mutation.** Authentication, Origin/CSRF/body validation, and
   current-password verification occur before a terminal marker. The Argon2 Promise
   retains its credential-work permit until the underlying computation settles,
   even if the HTTP request is cancelled. Cancellation before attempt reservation
   or before `dbMutationStarted` prevents the destructive transaction from starting.
2. **Capacity before state change.** Reserve the attempt and terminal-marker slots
   before installing the marker or aborting work. At capacity, reject without
   changing runtime or database state. Permit at most one unresolved deletion
   attempt per User and enforce a fixed global maximum.
3. **One linearization lock.** Under the single `PerUserConsentLock`, install the
   terminal marker first. Every Consent bind/recheck, third-party dispatch,
   Incognito create, and AI completion/append barrier must reject that User while
   it is present. `registerPending` may remain a bounded synchronous early
   registration: a registration racing after `abortUser` is still denied and
   disposed at its first lock-protected bind/recheck, before dispatch.
4. **Runtime termination.** Abort pending/bound Persistent and Incognito AI
   executions and clear both idle and active Incognito contexts. Existing aborted
   signals, generation identity checks, Conversation/Turn state checks, and
   context absence reject late classifier, generation, output-classifier, SSE,
   Message/reference, completion, and quota callbacks.
5. **Final database authority.** In one short transaction, lock the authenticated
   `users` row first and then the exact Session. Recheck User/Session ownership,
   `revoked_at IS NULL`, and expiry against one database observation time. This is
   the destructive operation's Session linearization point: if logout/revocation
   wins its Session-row order, deletion is rejected; if this check wins, a later
   logout waits for or observes the User cascade. An early Guard result alone is
   insufficient.
6. **Atomic evidence and deletion.** Locking User precedes Audit/deletion. Use the
   required Audit insertion path, then delete the User in that transaction. Existing
   cascades remove credentials, Sessions, age verification, Consent projection and
   ledger, Conversations/Messages/Turns/references, Mood, and Quota. Risk Event
   references become null; Queue items and independent Audit rows follow their own
   retention. Audit conflict/failure, missing User/Session, or a failed delete rolls
   back everything.
7. **No external wait under the lock.** The process lock and database transaction
   never wait for Provider, DNS, TLS, streams, browser acknowledgement, or Argon2.
   A database commit/reconciliation wait is bounded by its own lock and statement
   deadlines. Client disconnect after `dbMutationStarted` suppresses the response
   but does not start a second transaction or abandon server-owned outcome
   reconciliation.
8. **Release by evidence, not age.** A confirmed commit may release the marker only
   after owned executions/context cleanup is complete; authentication then fails
   because User Sessions are gone. A confirmed rollback may release it after the
   aborted registrations are disposed; cleared contexts and old executions never
   revive. An unresolved result retains the terminal marker and attempt slot. A TTL
   must not silently convert unknown to active. Fixed capacity makes this bounded;
   saturation fails closed for new deletion attempts rather than evicting an active
   protection.

Lock waiters keep the existing per-User/global bounds, `AbortSignal`, deadline,
timer cleanup, and shutdown behavior. Request waiters can leave without cancelling
the server-owned attempt after mutation starts. On process shutdown, all active AI
work is aborted and Incognito text is cleared; discarding process memory is not an
outcome proof. A replacement process must not overlap an old process that may still
own a database transaction. Crash/rolling overlap and cross-instance protection
remain Production blockers; this proposal claims only the controlled single-process
local/demo lifecycle.

### 3.3 Proposed deletion Audit shape

To avoid creating a new long-lived User linkage solely for deletion, recommend:

- action: `account_deleted`;
- resource type: `account_deletion`;
- resource ID: the command `operationId`, not the deleted User UUID;
- actor: `user` with null actor ID, accurately recording an authenticated
  self-service action without retaining the deleted User UUID; and
- safe metadata: `{ "initiator": "self_service" }` only.

The internal idempotency key is `account-deleted:<operationId>`. The record follows
the existing Audit retention policy and is not permanent. Under the proposed
application transaction, it records that one authenticated self-service deletion
committed for that operation ID. The row alone cannot independently prove which
User or process attempt created it; subject binding exists only in the bounded
internal attempt registry. The Audit retains no email, content, password-derived
value, or account tombstone and does not prove that every external copy was erased.

This deliberate minimization narrows replay guarantees:

- before mutation, query the global Audit key only as a collision check; any
  existing row is untrusted for this caller and causes
  `ACCOUNT_DELETION_OPERATION_CONFLICT` without deleting a User;
- inside the transaction, call `appendRequiredWithinTransaction`, not the ordinary
  conflict-ignoring append. Exactly one returned insert is mandatory before User
  deletion. A unique conflict, including a cross-User UUID collision, rolls back;
- only the still-live internal attempt token plus its `ownAuditInserted` phase may
  treat the matching Audit as evidence during commit confirmation;
- a same-User/same-ID concurrent HTTP request can join that bounded internal attempt
  only after independently passing authentication and reauthentication; it does not
  use the UUID as a bearer credential; and
- after the attempt binding is released or the process restarts, a matching Audit
  row is collision evidence, not proof that the authenticated caller owns the prior
  operation. A deleted account cannot perform an authenticated replay at all.

The existing Staff Audit reader remains unchanged. Adding the action/resource to
the write allowlist does not add it to Admin read filters or projections. Any later
operator access needs its own least-privilege decision and required access Audit.

Alternative: retain the former User UUID as Audit actor/resource for stronger
operator correlation. This expands post-deletion linkability, can reconnect other
Audit/Risk metadata, and therefore requires an explicit production retention and
access decision. It is not the default recommendation.

### 3.4 Concurrency outcomes

| Order                                                             | Required outcome                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AI dispatch gate wins first                                       | The outbound request is in flight. Account deletion publishes the terminal marker, aborts it, then deletes. Existing Safety/quota rules settle that execution; late output cannot emit or persist. The service does not claim bytes already sent to the Provider were deleted.                                                |
| Account-deletion gate wins first                                  | New input classification, generation, output classification, and Incognito creation/claim do not dispatch. The User deletion commits before authentication can succeed again.                                                                                                                                                 |
| Mood/Conversation/Quota child write commits first                 | The later User delete cascades the committed child row.                                                                                                                                                                                                                                                                       |
| User deletion locks/deletes first                                 | A later child insert cannot retain an orphan: it waits or fails ownership/FK validation after deletion.                                                                                                                                                                                                                       |
| Same User and same operation ID overlap                           | Both requests authenticate independently. The bounded attempt registry chooses one mutation owner; the other waits for/reconciles that exact in-process attempt. At most one required Audit and one User deletion occur.                                                                                                      |
| Same User and different operation IDs overlap                     | Only one unresolved deletion slot exists per User. The later operation receives conflict/busy and cannot start a second transaction. It does not inherit the first operation's result.                                                                                                                                        |
| Different Users and same operation ID overlap                     | Global attempt reservation rejects one locally. A database unique conflict remains the cross-process backstop: required Audit insertion fails and that User deletion rolls back. Neither caller receives the other's state.                                                                                                   |
| Original operation and a different operation delete the same User | The User row serializes mutations. If the different operation commits, the original operation's confirmation may observe User absence without its own proven Audit; that is a non-attributable/other-operation outcome, not proof of the original operation's success or rollback and not automatically an invariant failure. |
| Consent withdrawal overlaps deletion                              | Both operations acquire the same `PerUserConsentLock` exactly once before their database User/Consent order. Whichever gets the lock first completes its bounded operation; account deletion remains terminal and withdrawal cannot resurrect or preserve work.                                                               |
| Logout/Session expiry overlaps deletion                           | The destructive transaction locks and revalidates the exact Session. Revocation first rejects deletion; final Session validation first permits the account transaction to linearize, after which Session deletion/revocation observes the cascade.                                                                            |
| Re-registration with the same normalized email                    | It creates a fresh User UUID, fresh verification/Consent, fresh Quota and no access to old rows. Reusing the email is not restoration, authorization replay, or linkage to old Safety/Audit evidence.                                                                                                                         |

### 3.5 Cancellation, rollback, retry, and unknown result

- Before password verification and lifecycle admission finish, cancellation means no
  deletion mutation starts.
- `dbMutationStarted` is set once, while the internal attempt owns the User lock and
  immediately before the first Audit/delete mutation. After that point the attempt
  cannot defer, restart, or schedule a replacement mutation. Client disconnect does
  not roll it back merely to improve response certainty; it suppresses delivery while
  the server completes or resolves the one database attempt.
- A **confirmed rollback** leaves the User and all database children unchanged and
  creates no deletion Audit. Runtime AI may already have been aborted and Incognito
  context cleared; neither is resurrected. The terminal marker can be released and
  the authenticated account remains usable.
- A **confirmed commit** removes the User graph according to the FK matrix, retains
  independent Risk/Audit data according to their policies, and returns success only
  if the response channel is still available.
- A **commit acknowledgement loss** is not a rollback. A normal MVCC read, process
  restart, expired Session, or currently missing Audit row does not prove the
  original database transaction ended. Confirmation uses a new short
  `READ COMMITTED` transaction with bounded `lock_timeout` and `statement_timeout`.
  It first selects the same User row `FOR UPDATE`, the serialization point that the
  original attempt locked before Audit/delete. If the original backend is still
  deciding, this statement waits; after commit it sees no User, and after rollback
  it locks the surviving User. It then locks/reads the exact Audit key in the same
  confirmation transaction. No independent pre-lock read may classify the result.
- Confirmation interprets the consistent post-wait state together with the live
  internal attempt token and `ownAuditInserted` marker:
  - User absent + this attempt's proven Audit present: this attempt committed;
  - User present + this attempt's Audit absent: this attempt rolled back;
  - User absent + no proven Audit for this attempt: the account was deleted by
    another operation, the evidence expired/unavailable, or binding was lost; it is
    not success/rollback evidence for this attempt;
  - User present + a pre-existing/unowned Audit: operation-ID conflict; and
  - a state impossible under this attempt's required-Audit-plus-delete transaction,
    such as User present with its own proven committed Audit, is an invariant failure.
- A lock/statement timeout, database outage, lost internal subject binding, or
  otherwise non-attributable state returns/records
  `ACCOUNT_DELETION_RESULT_UNKNOWN`. It retains the terminal marker and attempt
  slot, makes no success/failure claim, and permits a later authenticated exact
  retry to join only while that process-local binding still exists. A request wait
  timing out does not cancel the underlying server-owned confirmation.
- The same `operationId` can suppress duplicate work while the authenticated request
  and process-local subject-bound attempt are reachable. The retained Audit alone is
  insufficient. After deletion, ordinary Session auth fails; there is intentionally
  no unauthenticated receipt lookup. A network-lost client may therefore be unable
  to prove the result through this API. This is the explicit cost of not adding a
  durable public tombstone/recovery channel.
- A new operation ID does not cancel or prove the result of an earlier uncertain
  request. An Account/Mood/Consent/AI operation must retain its own domain-specific
  retry semantics.

The terminal marker is a single-process safety boundary, not a timed cache entry.
Confirmed outcomes release it under the same User lock after cleanup; unknown
outcomes retain it and consume fixed capacity. The lock itself is always released
after the bounded operation or wait, so other requests can acquire the lock only to
observe the terminal state and fail closed. If confirmation remains unavailable,
the affected User cannot start AI/Incognito work in that process and new deletion
attempts may receive a capacity error rather than evicting protection.

If the process restarts, the absence of its marker is not proof of commit or
rollback. A surviving User can only retry after normal authentication and a new
User-row-serialized check; an absent User cannot authenticate or use the operation
ID as a credential. A replacement process overlapping an old database backend can
still admit work from a pre-commit snapshot because no durable account-terminal
marker exists. Preventing that requires controlled single-process shutdown/drain or
a separately approved durable/cross-instance design and remains a Production
blocker.

### 3.6 Quota and historical-reference effects

- Do not invent account-deletion-specific quota refunds. Existing AI settlement
  decides refund/retain based on dispatch, cancellation, and approved delivery.
  A successful User cascade then removes both quota aggregate and consumption rows.
- If deletion rolls back, the existing AI settlement remains authoritative and
  must keep ledger/aggregate consistency.
- Deleting Conversations cascades Messages, Turns, and Assistant Knowledge
  references. Their old client-request IDs no longer prove recovery. A new account
  with the same email has a different User ID and cannot replay or recover them.
- Knowledge versions and source evidence are global and remain. Removing the final
  Message reference may make a future dependency-closed Knowledge purge possible,
  but account deletion must not itself rewrite or withdraw Knowledge evidence.
- Consent operation replay ends when the User/Consent/decision rows are deleted.
  This matches ADR-016's current engineering relationship and is not an indefinite
  evidence-retention promise.

## 4. Production-policy boundary

### 4.1 Recommendation for the local learning/demo implementation

If account deletion is implemented before public deployment, follow the existing
FK graph without adding retained account identity:

- cascade User identity, Consent, Conversation/Message/Turn/reference, Mood, and
  Quota rows;
- retain Risk Events with nullable references until their configured deadline;
- retain Queue items only with their Risk Event;
- retain existing Audit rows until their configured deadline;
- add only the operation-scoped, content-free deletion Audit described above; and
- clear same-process AI/Incognito runtime state.

This provides a coherent engineering exercise while preserving Accepted ADR-014,
ADR-016, ADR-017, and ADR-019 relationships. It is not approval for public
production wording or legal retention.

### 4.2 Alternatives requiring explicit approval

| Topic                                   | Recommended direction                                                                           | Alternative                                                                    | Impact/decision owner                                                                                                                                                                              |
| --------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Consent evidence after account deletion | Follow current cascade for the local/demo implementation.                                       | Retain a separately governed, minimized/pseudonymized Consent evidence record. | Retention could support dispute/compliance evidence but requires purpose, fields, access, encryption, retention, deletion, and linkage decisions. Product/legal review required before Production. |
| Risk Event after account deletion       | Keep the existing independent deadline and set User/chat references null.                       | Delete immediately with the account.                                           | Immediate deletion weakens the accepted independent safety lifecycle; changing it requires a superseding ADR and policy review.                                                                    |
| Existing Audit after account deletion   | Keep until its configured deadline; do not rewrite append evidence in the deletion transaction. | Redact/delete User-linked Audit immediately.                                   | Immediate rewrite can damage audit integrity; continued UUID linkage is sensitive. Production purpose/retention/access must be approved.                                                           |
| Deletion Audit identity                 | Operation-scoped UUID, no deleted User UUID/email.                                              | Retain former User UUID for operator correlation.                              | Alternative increases linkability and needs explicit approval.                                                                                                                                     |
| Unknown-result recovery                 | Honest unknown state; bounded server reconciliation; no public unauthenticated reader.          | Durable deletion receipt/status channel.                                       | Alternative requires a new security/privacy design and storage lifecycle; not justified for local/demo.                                                                                            |
| Same-email registration                 | Allow as a new account with a fresh User UUID and all prerequisites.                            | Cooldown or retained email tombstone.                                          | Tombstone adds personal-data retention and needs a policy; not recommended now.                                                                                                                    |

No new production day count is selected here. Conversation's 90 days, Risk
Event's current 180-day engineering setting, and Development/Test Audit values
must not be copied to Consent, Staff, Sessions, Quota, logs, backups, or deletion
receipts without a separate decision.

### 4.3 Backup and restore condition

Primary-database deletion is not backup deletion. Before any production account-
deletion promise, the deployment needs:

1. an approved backup retention and access policy;
2. an isolated restore procedure that never exposes a restored snapshot directly;
3. an approved deletion-suppression/reapplication source or an equivalent method
   that prevents deleted accounts from becoming visible after restore;
4. a restore test proving cascades, independent Risk/Audit treatment, and post-
   restore login denial; and
5. documented treatment for backup copies that expire naturally versus copies that
   can be selectively erased.

This design does not create a deletion ledger to solve restore. Selecting such a
source would itself require a privacy, security, retention, and recovery decision.

### 4.4 Third-party and logging condition

Account deletion wording must state that the service stops new authorized processing
and deletes the primary account graph according to the accepted policy. It must not
state that already-delivered Provider bytes, downstream records controlled by a
third party, operational-log sink copies, or backups were synchronously recalled.
Provider terms, log-sink retention, production Consent text, and user-facing wording
require accountable human review.

## 5. Decision summary

The repository already has several separate deletion and expiry operations, but it
does not have account deletion. The proposed account command therefore composes
existing lifecycle rules; it must not redefine each domain's retention policy.

| Decision area               | Current implemented fact                                                                 | Recommended implementation decision                                                                                                                                                                        | Still requires approval                                                                  |
| --------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Account command             | No account-delete API exists.                                                            | Add one Session-bound, password-reauthenticated, CSRF-protected command with a caller-generated UUID and no caller-selected target.                                                                        | User-facing copy and the production result-recovery promise.                             |
| Main account graph          | User-owned identity, Consent, chat, Mood, and Quota tables already cascade from `users`. | Preserve the current cascades; do not copy content into a deletion ledger.                                                                                                                                 | Whether Production must retain minimized Consent evidence after account deletion.        |
| Safety                      | Risk references use set-null and Queue follows Risk Event.                               | Preserve the independently expiring Risk Event/Queue lifecycle.                                                                                                                                            | Production purpose, access, exact retention, account-deletion treatment, and encryption. |
| Audit                       | Audit has an independent deadline, global idempotency key, and no resource FK.           | Keep existing records to their deadline; require one content-free operation Audit in the account transaction; reject any unowned/pre-existing key instead of borrowing it as proof.                        | Production retention and whether a former User identifier may be retained.               |
| Runtime                     | AI and Incognito state is process-local and separately cleared today.                    | Extend the owner of the existing non-reentrant Consent User lock with one no-nesting account-lifecycle operation, a bounded terminal marker, and a subject-bound attempt registry.                         | Multi-instance cancellation and recovery before Production.                              |
| Unknown result              | No durable account-delete receipt exists.                                                | Wait on the original User-row serialization point, then interpret User/Audit state only with the still-live internal attempt binding; otherwise report unknown honestly and retain fail-closed protection. | Whether a durable privacy-reviewed status channel is required for a public product.      |
| Backups/providers/log sinks | No repository operation controls these external copies.                                  | State the boundary accurately and keep Production deletion claims disabled until policies and procedures are approved and tested.                                                                          | Backup/restore/deletion, provider, and log-sink decisions.                               |

No Accepted ADR is changed by this document. An implementation should either add a
new ADR for the accepted account-deletion contract or record an explicit decision
that the scoped implementation is a composition of ADR-011, ADR-012, ADR-014,
ADR-016, ADR-017, ADR-019, and ADR-021. This document must not be treated as that
acceptance.

## 6. Minimal implementation split and rollback boundaries

### 6.1 Batch A: account command and database lifecycle

Scope:

- shared request/error contract;
- authenticated password reauthentication and bounded credential-work admission;
- account-deletion application service and narrow user-lifecycle coordinator;
- one transaction containing the deletion Audit and `users` deletion;
- integration tests for all existing FKs and independent Risk/Audit rows; and
- API/runbook documentation that distinguishes primary-database deletion from
  external copies.

Rollback boundary: disable/remove the new route and service before use. The schema
requires no new table under the recommended local/demo design. A successfully
committed account deletion is deliberately irreversible; application rollback
cannot restore deleted rows.

### 6.2 Batch B: production policy and recovery readiness

This is not an automatic follow-on implementation. It starts only after accountable
owners decide:

- Consent, Risk Event, Audit, Staff, Knowledge, Session, Quota, and account-deletion
  retention purposes and deadlines;
- backup expiry, access, restore, and deletion-suppression/reapplication behavior;
- provider and log-sink processing/deletion capabilities;
- account re-registration and result-recovery wording; and
- whether durable deletion receipts are justified and, if so, their authentication,
  fields, retention, encryption, and cleanup.

Rollback boundary: Production account deletion remains unavailable until every
claimed behavior has a tested operational procedure. This batch must not weaken the
existing Production AI Safety Lock.

### 6.3 Explicitly deferred work

- account-deletion UI, data export, account recovery, email tombstones, and generic
  Privacy Center work;
- cross-instance locks, queues, distributed cancellation, or a deletion event bus;
- a general retention scheduler/platform;
- selective backup mutation or home-grown field encryption; and
- Staff-account hard deletion and Knowledge-content retirement policy changes.

## 7. Engineering acceptance matrix

All fixtures must be synthetic and all destructive database tests must validate the
project's protected `_test` database guard before setup.

| Scenario                             | Required verification                                                                                                                                    | Expected result                                                                                                                                                                                                                                                            |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication/CSRF/reauthentication | API tests for missing/expired Session, untrusted Origin, invalid CSRF, invalid password, Staff credential, and malformed body.                           | Rejected before lifecycle coordination or data mutation; no secret/body logging.                                                                                                                                                                                           |
| Successful deletion                  | PostgreSQL integration test seeds every User-owned table plus Risk, Queue, Audit, and Knowledge/reference relations, then invokes the real service.      | User graph cascades; Conversation bodies, Mood, Consent, credentials, Sessions, Quota, and message references are gone; Risk survives with null references; Queue survives with Risk; existing Audit and global Knowledge survive; one content-free deletion Audit exists. |
| Audit failure                        | Inject a transaction-bound Audit failure.                                                                                                                | User and all dependent rows remain; no partial deletion.                                                                                                                                                                                                                   |
| User-delete failure                  | Inject a database constraint/statement failure after Audit insert.                                                                                       | Whole transaction rolls back, including the deletion Audit.                                                                                                                                                                                                                |
| AI dispatch wins                     | Barrier around the existing final dispatch boundary.                                                                                                     | Already-started external request is aborted best-effort; no later SSE, Message, reference, completion, or quota mutation bypasses the terminal/turn guards. No provider recall is claimed.                                                                                 |
| Account deletion wins                | Same barrier with deletion marker/transaction first.                                                                                                     | No classifier/generation/output-classifier dispatch starts afterward in that process; pending work is aborted and late callbacks are rejected.                                                                                                                             |
| Incognito idle/active state          | Seed both kinds, including full-capacity bookkeeping.                                                                                                    | All owned contexts and used-request registrations are cleared; capacity is released; late work cannot recreate the context.                                                                                                                                                |
| Concurrent child write               | Hold the User deletion row lock and race Conversation, Mood, Consent, Session, and Quota writes.                                                         | Each write is either included before commit or rejected/rolled back after parent deletion; no orphan survives.                                                                                                                                                             |
| Same User/same ID                    | Submit two independently authenticated commands with one process barrier.                                                                                | One subject-bound attempt owns mutation; the other joins/reconciles it. At most one Audit/delete occurs.                                                                                                                                                                   |
| Same User/different IDs              | Submit both before either transaction starts.                                                                                                            | Per-User attempt reservation admits at most one; the other is busy/conflict and cannot infer the first result.                                                                                                                                                             |
| Different Users/same ID              | Race process reservation, then separately exercise a database unique conflict as a cross-instance backstop.                                              | One can own the global ID. The other performs no User deletion, returns no foreign result, and does not treat the existing Audit as its evidence.                                                                                                                          |
| Pre-existing Audit key               | Seed a syntactically valid but unowned `account-deleted:<operationId>` row.                                                                              | New command fails conflict before deletion; required Audit cannot be skipped.                                                                                                                                                                                              |
| Required Audit failure/conflict      | Inject append failure and `ON CONFLICT` zero-row result.                                                                                                 | The transaction rolls back and the User remains. The ordinary conflict-ignoring append path is never used.                                                                                                                                                                 |
| Consent withdrawal overlap           | Interleave withdrawal, acceptance, and account deletion.                                                                                                 | Account deletion is terminal for the old User; no Consent operation resurrects work or leaves an orphan ledger row.                                                                                                                                                        |
| Uncommitted original then commit     | Hold original User lock after required Audit/delete, start confirmation, prove it waits, then commit.                                                    | Confirmation cannot read old state as rollback; after lock release it observes absent User and this attempt's proven Audit and confirms commit.                                                                                                                            |
| Uncommitted original then rollback   | Same barrier, but roll back the original transaction.                                                                                                    | Confirmation waits, then locks the surviving User and sees no own Audit; rollback is confirmed and the marker is released only after runtime cleanup.                                                                                                                      |
| Confirmation wait timeout            | Hold the original database lock beyond the bounded confirmation deadline.                                                                                | Return unknown, retain the terminal marker/attempt slot, release lock waiter/timer resources, and do not start another delete.                                                                                                                                             |
| Different operation deletes User     | Let operation B commit while operation A is being resolved.                                                                                              | A sees absent User without its own proven Audit and receives a non-attributable unknown/other-operation outcome, never B's success receipt.                                                                                                                                |
| Commit acknowledgement lost          | Commit the original transaction, then inject a transport/repository acknowledgement failure while retaining its internal attempt token.                  | Runtime remains fail closed; serialized confirmation attributes the Audit only because that attempt recorded its own required insert. The API never claims rollback merely because acknowledgement was lost.                                                               |
| Definite rollback                    | Fail before commit and prove rollback.                                                                                                                   | User remains and can authenticate according to normal Session rules after temporary coordination state is safely released; aborted work is not resurrected.                                                                                                                |
| Reconciliation unavailable           | Make the database unavailable after an ambiguous commit result.                                                                                          | Return the bounded unknown-result error, make no deletion/success claim, and retain fixed-capacity local protection. Restart/eviction is not represented as outcome proof.                                                                                                 |
| Session revoke/delete ordering       | Barrier around final locked Session validation and concurrent logout/expiry.                                                                             | Revocation first rejects mutation; valid final check first gives deletion the documented linearization order. No early Guard result substitutes for this check.                                                                                                            |
| Pending/late runtime work            | Race terminal-marker installation with early-authenticated unbound execution, pending/bound execution, idle/active Incognito context, and late callback. | Every path is aborted/cleared or fails its first lock-protected bind/dispatch/completion check; marker capacity is reserved before cleanup and no unresolved marker is expired to make room.                                                                               |
| Re-register same email               | Delete, then use the ordinary registration contract with a new User UUID and current prerequisites.                                                      | New account has no access to old Conversation, Mood, Consent, Quota, AI Turn, or references. Retained Risk/Audit rows are not attached to it.                                                                                                                              |
| Purge and restore                    | Dedicated integration/runbook tests, not the development database.                                                                                       | Domain purges preserve documented FK semantics; a restored snapshot is not exposed before the approved deletion-reapplication/suppression step. Production remains blocked until this procedure exists.                                                                    |
| Privacy/logging                      | Security logger and Audit-schema tests over every error path.                                                                                            | No password, email, Cookie, CSRF, message, prompt, Mood content, provider body, or arbitrary error enters operational/Audit logs.                                                                                                                                          |

Required quality checks for an implementation include frozen install, formatting,
lint, typecheck, unit/API/PostgreSQL integration tests, migration-from-zero and
non-empty upgrade checks when a migration is actually added, existing Chromium P0,
build, and CI on the exact final head. A docs-only decision PR needs formatting,
diff/link checks, and its normal repository CI; it does not manufacture runtime
test evidence.

## 8. Decisions required before implementation

The following choices materially affect the first implementation and remain
Proposed:

1. **Accept or reject the local/demo deletion graph.** The recommendation is to
   cascade the ordinary User-owned graph, retain independently expiring Risk/Audit
   records, and add no retained account identifier or durable public receipt.
2. **Accept the password-reauthenticated command boundary.** The recommendation is
   a current Session plus current password, Origin, and CSRF. An account without a
   usable password credential would need a separately designed strong reauth path;
   none exists today.
3. **Accept operation-scoped Audit without retained User identity.** The
   recommendation binds subject and attempt only in fixed-capacity process memory,
   requires a newly inserted Audit for the destructive transaction, and treats any
   unowned/pre-existing global operation key as conflict. This deliberately gives
   no indefinite exact-replay proof after registry release or restart. Retaining a
   former User UUID would expand sensitive-data retention and needs a separate
   decision.
4. **Accept honest bounded unknown-result handling and its availability cost.**
   Serialized database confirmation waits for the original User-row operation;
   uncertainty retains a terminal marker without a TTL. This can consume finite
   capacity and deny the affected User's new AI/Incognito work. Without a durable
   status/terminal record, a disconnected caller may be unable to prove the result
   after its Session/User or process binding disappears, and crash/rolling overlap
   is not protected. The service must not turn those limitations into a false
   success or failure claim.

The following do not block a local/demo engineering implementation, but they block
public Production claims: exact retention schedules, account-deletion legal text,
Consent-evidence treatment, backup restore/deletion, provider/log-sink handling,
database encryption/key management, multi-instance coordination, and reviewed
account re-registration/recovery policy.

## 9. Status and evidence index

At the baseline commit:

- account deletion is **not implemented**;
- this proposal is **not Accepted architecture**;
- no schema, migration, API, cleanup command, UI, or production policy was changed;
- Phase 5 user-facing features and completed backend/Admin batches keep their
  existing status;
- Production Safety Lock remains **Enforced**;
- Production AI Chat remains **Disabled**;
- `productionSafe=false`; and
- Real Model Safety Evaluation remains **Not Evaluated**.

Primary evidence reviewed:

- [`docs/HANDOFF.md`](../HANDOFF.md)
- [`docs/PROJECT_CONTROL_HANDOFF.md`](../PROJECT_CONTROL_HANDOFF.md)
- [`docs/backend-integration-handoff.md`](../backend-integration-handoff.md)
- [`database/src/schema.ts`](../../database/src/schema.ts)
- Accepted ADRs in [`docs/architecture/adr/`](adr/)
- Conversation, Consent, Mood, Quota, Safety, Staff, Knowledge, Auth, AI runtime,
  cleanup-command, migration, and integration-test implementation under
  `apps/api`, `database`, and `packages/shared`

Static review establishes current code and FK behavior. It does not prove a future
account-deletion operation, legal compliance, backup erasure, provider erasure, or
production readiness.
