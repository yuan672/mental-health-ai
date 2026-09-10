# ADR-015: User-Facing Conversation, Incognito, and Client Data Boundaries

- Status: Accepted
- Date: 2026-09-10
- Refines: ADR-012, ADR-013, and ADR-014 (does not supersede them)

## Context

Phase 5 introduces the first user-facing access to ordinary persisted conversation
history. The existing Conversation and Message services already enforce ownership,
90-day expiry, saved-conversation lifetime, immediate message deletion, and
Incognito non-persistence. Public HTTP and browser boundaries must preserve those
decisions without exposing psychological text in list views, internal AI state,
provider metadata, or safety classifications.

Phase 5A exposes ordinary Conversation access only. Later Phase 5 work will add the
product UI and Incognito lifecycle. The future Incognito protocol direction must be
recorded now so that Phase 5A does not accidentally make persistent database IDs a
requirement for an ephemeral conversation.

## Decision

### Public ordinary-conversation boundary

The authenticated public API may list active ordinary conversations, get one active
conversation, page through its messages, save it, delete it, or delete all ordinary
conversations owned by the current user. It does not expose a public message-write
endpoint. New ordinary conversations continue to be created only when the existing
AI chat endpoint receives the first persistent-mode message without a conversation
ID; clicking “new chat” must not create an empty database row.

Conversation history lists contain only `id`, `createdAt`, `expiresAt`, and
`isSaved`. They contain no message preview, first message, generated title, summary,
AI-turn state, risk level, Risk Event, provider/model information, or other safety
metadata. V1 adds no persisted Conversation title and does not call an LLM to label
history. The client will format the creation date and time as the display label.

Message history contains only `id`, `role`, `content`, `sequence`, and `createdAt`.
It exposes no AI-turn, provider, prompt, classifier, risk, or operational fields.

### Pagination and authorization

Conversation pagination uses the stable descending tuple `(created_at, id)`.
Message pagination uses `sequence_number` as its stable ordering boundary. Cursor
tokens are versioned and validated but opaque to clients. Cursor opacity is not an
authorization mechanism: every query combines the authenticated user ID with the
resource ownership and active-lifecycle predicates.

Missing, non-owned, expired, and deleted resources share the existing not-found
result. Page sizes have an application default and bounded maximum; malformed
cursors are validation errors. No pagination framework is introduced.

### Save, delete, and audit

Saving remains owner-scoped, active-only, idempotent, and irreversible in this
phase. It sets `is_saved = true` and `expires_at = NULL`. Expired conversations
cannot be revived. Phase 5A adds no unsave, rename, pin, or favourite operation.

A single delete marks the active owned Conversation with `deleted_at`, immediately
hard-deletes all of its Message rows, and appends at most one allowlisted user-actor
Audit Log record in the same transaction. The API reports success only after that
transaction commits.

Delete-all uses one set-based transaction over every not-yet-purged ordinary
Conversation owned by the authenticated user, including saved and already-expired
ordinary conversations. It marks the selected rows deleted, immediately removes
their Message rows, and writes one aggregate user-actor audit record rather than one
record per Conversation. A repeated delete-all with no remaining rows is
idempotently successful and does not add a no-op audit record.

Risk Events and Audit Logs keep their independent retention. Conversation deletion
does not delete them or reinterpret their retention as a legal requirement. Audit
metadata is action-specific and may contain only bounded counts; it contains no
message, preview, title, prompt, provider data, or risk detail.

### HTTP caching and client storage

Authenticated Conversation, Message, and Quota reads explicitly use
`Cache-Control: private, no-store`. The public capability representation contains
only whether AI chat is enabled and exposes no production-safety state, readiness
checks, provider status, or credentials.

Future product clients must not persist ordinary or Incognito chat bodies in
`localStorage` or IndexedDB. Transient UI state may remain in process memory, while
ordinary committed history is reloaded through the authenticated API.

### Future Incognito public protocol

Phase 5A does not expose Incognito controllers or change the existing public SSE
schema. Phase 5C will use discriminated request and event types rather than making
persistent identifiers broadly nullable.

Conceptually, a persistent request carries `mode: "persistent"` and an optional
`conversationId`; an Incognito request carries `mode: "incognito"` and a
`contextId`. Persistent completion includes its persisted `assistantMessageId`.
Incognito completion uses its own discriminated payload without a fabricated
Conversation or assistant-message ID. A runtime-only opaque turn ID remains
permitted.

If the final Phase 5C protocol must alter an ADR-013 public event payload, this ADR
must be amended to identify only that narrow refinement or partial supersession.
ADR-013's provider, safety, streaming, cancellation, quota, and persistence
decisions remain in force.

### Production and phase boundary

The API never exposes internal safety metadata. Conversation access does not add a
direct provider, debug chat, or safety-bypass route. Phase completion remains
separate from production safety readiness: this work does not change the Production
Safety Lock, enable Production AI Chat, or set `productionSafe` to true.

Phase 5A does not implement a Chat UI, public Incognito lifecycle, Mood, Profile,
Privacy UI, Knowledge Base, Admin, or Reviewer capability.

## Consequences

- History access is useful to the product without turning list responses into a
  second cache of psychological text.
- Cursor pages remain deterministic while ownership stays enforced in the query.
- Saved conversations are not silently retained by delete-all.
- Sensitive message deletion and its safe audit record cannot report contradictory
  committed state.
- Incognito remains free of fabricated persistent identifiers and PostgreSQL chat
  rows.
- Phase 5B and Phase 5C can build client experiences on explicit public boundaries
  without weakening the Phase 3/4 AI safety path.

## Phase 5C implementation addendum

Phase 5C exposes `POST /incognito-contexts` and idempotent
`DELETE /incognito-contexts/:contextId`. Context identifiers are server-generated,
opaque, scoped to the authenticated user and session, and are not authentication
credentials. There is no public list, read, resume, status, or history endpoint.
Create requires current required consent and enabled AI capability; end remains
available after either condition changes so cleanup cannot be blocked.

The chat request is now a strict discriminated union. Persistent requests use
`mode: "persistent"`; Incognito requests use `mode: "incognito"` and a runtime
`contextId`. The existing four SSE event names remain stable, while each payload is
also discriminated by mode. Incognito events expose only a runtime `generationId`;
they never fabricate a Conversation, Message, AI Turn, or assistant-message ID.

The in-process Incognito store is deliberately bounded globally, per user, per
session, per context, per message, and per generation. It stores whole messages in
memory only, uses a sliding inactivity TTL capped by the authenticated session
expiry, permits one active generation per context, and keeps a bounded set of used
client request IDs for the context lifetime. Expiry, explicit end, logout, session
invalidity, and required-consent withdrawal abort active work before clearing the
context. Late classifier/provider results cannot append or emit after termination.
There is no silent eviction of an active context.

AI executions register before the consent query, and Incognito generation claims
occur before classifier or provider work. Consent withdrawal commits first and
then cancels active executions and clears all of the user's runtime contexts; a
cleanup failure does not roll back the legal withdrawal. Cross-process cancellation
and recovery remain unsupported. Refresh, process restart, or TTL expiry can lose
the context and the product must ask the user to start again. The browser keeps
Incognito content and identifiers in React memory only and does not use
`sendBeacon`, browser persistent storage, or URL parameters for best-effort cleanup.

The quota idempotency key contains only server-known user, session, and client
request identifiers. The database ledger enforces one key per user across date
boundaries; it contains no content fingerprint. Missing runtime state combined with
an existing consumption fails closed and never calls the provider again.

Consent history is an authenticated, private/no-store, sanitized, bounded cursor
view. It reports server-configured current required versions and their status plus
known historical records, without internal record or user IDs. Phase 5C does not
define new consent types, legal copy, same-version reacceptance, or a user-facing
withdraw/reopen workflow. Those product-policy questions remain Proposed in the
separate decision note and do not change ADR-011.

## Alternatives considered

### Persist or generate Conversation titles in Phase 5A

Rejected because no current product decision requires a title and generating one
would disclose content to another model call or add unnecessary sensitive derived
data. Date/time labels are sufficient for the first history UI.

### Return a message preview in the history list

Rejected because the list does not need psychological text to identify an ordinary
conversation and previews expand caching, rendering, and logging exposure.

### Delete conversations one at a time in the controller

Rejected because it creates an N+1 operation, permits partial completion, and could
produce unbounded audit records. The repository uses one set-based transaction.

### Make persistent IDs nullable for every SSE event

Rejected as the default direction because it weakens the persistent protocol's type
contract. Phase 5C will add a discriminated Incognito variant that cannot masquerade
as persisted history.
