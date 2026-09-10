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
