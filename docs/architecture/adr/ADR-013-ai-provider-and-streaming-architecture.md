# ADR-013: AI Provider and Streaming Architecture

- Status: Accepted
- Date: 2026-09-09
- Refines: ADR-006 LLM Provider Architecture (does not supersede it)

## Context

Phase 3 introduces the first external LLM adapter and the streaming AI-turn
orchestration that consumes the Phase 2 conversation, message and quota
foundations. Mental-health text is highly sensitive, streaming content cannot be
retracted after delivery, and the architecture must leave enforceable insertion
points for the Phase 4 risk and output-safety system.

The Web client uses cookie authentication and CSRF protection. A chat request has
a body and must support cancellation, so the browser transport cannot rely on the
native GET-only `EventSource` API. The main interactive path must stay synchronous
HTTP streaming and must not introduce a queue or WebSocket infrastructure.

## Decision

### Provider boundary

The application owns an `LLMProvider` port with `chat`, `streamChat`,
`classifyRisk`, `embed`, and `healthCheck` capabilities. Business orchestration
depends only on this port. Provider request/response types, raw payloads and SDK
types never escape an adapter.

Phase 3 implements only capabilities needed by the current chat flow. Capabilities
that do not yet have a business consumer return an explicit typed
unsupported-capability failure. In particular, this does not implement a risk
classifier or embedding/knowledge feature ahead of its phase.

The first adapter is `SiliconFlowProvider`. It uses Node.js native `fetch` against
the provider's OpenAI-compatible HTTP API. It owns Authorization, request mapping,
response validation, true upstream stream parsing across arbitrary network chunk
boundaries, usage and finish-reason normalization, cancellation and provider error
mapping. It never exposes or logs API keys, prompts, raw provider payloads, or
`reasoning_content`.

Provider selection and all operational limits use Zod-validated backend
environment variables. Provider secrets never use a `VITE_` prefix. CI uses fakes
and local mock HTTP servers and never calls SiliconFlow.

### Orchestration and safety boundary

The turn pipeline is:

```text
Authenticated principal
→ input validation
→ required-consent check
→ active conversation ownership
→ AI-turn claim/idempotency
→ advisory quota check
→ PreGenerationSafetyGate
→ ConversationContextService
→ atomic quota consumption + user-message append + turn streaming state
→ LLMProvider.streamChat
→ sentence-aware bounded buffer
→ PostGenerationSafetyGate
→ approved SSE segment
→ complete assistant-message append + turn completion
```

Phase 3 pass-through pre- and post-generation gates explicitly declare
`productionSafe = false`. Development and test may use them. Enabling AI chat in
Staging or Production while either configured gate is not production-safe fails
closed during configuration/startup. Phase 4 supplies real risk and output-safety
implementations; a system prompt is not a substitute for those gates.

Provider deltas are not sent directly to the browser. They are accumulated into
sentence-aware segments using Chinese sentence punctuation, newlines, a configured
hard character limit, and a configured maximum wait. Every candidate segment is
passed to the post-generation gate before SSE delivery. This preserves true
upstream streaming while allowing Phase 4 to inspect content before release. A
future high-risk path may select full-response buffering without changing the
public protocol.

### HTTP streaming

The transport is an authenticated, CSRF-protected `POST /ai/chat/stream` request
using browser `fetch` and `ReadableStream`. The response uses SSE framing but not
native `EventSource`. Public events are limited to `turn.started`,
`message.segment`, `turn.completed`, and `turn.failed`.

Provider token accounting, provider request IDs, provider/model metadata and prompt
versions are not sent to the browser. `turn.completed` contains only the turn ID,
assistant-message ID and normalized finish reason. Failures before stream headers
use the normal API error response. Failures after streaming begins use a terminal
`turn.failed` event with the same safe error shape.

No WebSocket, Redis queue, BullMQ, RabbitMQ, Kafka or background worker participates
in the interactive chat path.

### AI-turn idempotency and persistence

Ordinary persisted turns use an `ai_turns` table. It stores a server-generated turn
ID, owner, conversation, client request ID, state, prompt identity, optional user
and assistant message references, a safe failure code, lease timestamps and
lifecycle timestamps. It does not store a request fingerprint, prompt, response,
message copy, provider raw data or other derivative of the psychological text.

`(user_id, client_request_id)` is unique. A repeated client request ID for the same
authenticated user returns the existing turn state and never creates another turn,
calls the provider again or consumes quota again, even if a buggy client submits
different text with that ID. The client request ID is only a client idempotency
identifier; the server turn ID remains the business identity and quota key.

At most one `claimed` or `streaming` turn may exist for an ordinary conversation,
enforced by a PostgreSQL partial unique index and transaction. This is not an
in-process mutex. A claim records a lease ending at turn start plus the configured
total generation timeout and a small engineering margin. There is no heartbeat.
When a new claim encounters an active turn with an expired lease, it marks the old
turn failed as stale before claiming the new turn. A valid lease returns
`AI_TURN_IN_PROGRESS`.

After the context is prepared, one transaction locks the active owned conversation,
consumes quota, appends exactly one user message, and changes the turn to
`streaming`. Provider output remains only in memory until it ends successfully.
Then one transaction appends the complete assistant message and marks the turn
`completed`; `turn.completed` is emitted only after that transaction commits.

Provider failure or cancellation retains the user message, does not persist a
partial assistant message, and marks the turn `failed` or `cancelled`. If approved
segments were already delivered but final persistence fails, the stream emits
`turn.failed` when possible and the client must not treat streamed text as committed
history.

AI-turn rows inherit the parent ordinary-conversation retention and deletion
lifecycle. Incognito turns do not write `ai_turns`, conversations or messages.

### Quota consumption and refund

Validation, authentication, required-consent, ownership, pre-safety and context
failures do not consume quota. Cancellation before provider dispatch does not
consume quota. An atomic consumption occurs before the provider request and uses
the server turn ID as the idempotency key.

Normal completion and `finishReason = length` consume once. A failure after at
least one approved segment was delivered consumes once. User cancellation or client
disconnect after generation starts consumes once. Provider retries, if introduced
later, reuse the same turn and consumption key.

If no approved segment was delivered, provider 429/auth/5xx/network failure,
first-token timeout, or malformed streaming output refunds the consumption. Refund
deletes only the corresponding existing ledger row and decrements its aggregate in
one PostgreSQL transaction. It is idempotent and cannot decrement usage below zero.
This is a small compensation operation, not a reservation/refund state machine.

### Incognito runtime context

Phase 3 uses an API-process-memory store with TTL behind an internal port. Entries
are scoped by user ID, server session ID and an opaque context ID. Content is never
written to PostgreSQL. Entries are removed on TTL expiry, logout, explicit internal
end, or process exit/restart. Refresh recovery is not promised.

Incognito quota idempotency is a stable server-derived SHA-256 value over the
authenticated user ID, session ID and client request ID. It never includes a
message, prompt or content fingerprint. Losing process memory must not allow the
same client request ID to consume again for free.

The process-memory implementation is limited to single-instance early deployment.
Multi-instance routing, restart recovery, or high-availability requirements require
a later decision, potentially a Redis TTL store. Phase 3 adds no public incognito
lifecycle API or UI; those remain Phase 5 user features.

### Context, prompts, cancellation and logging

`PromptRegistry` and `PromptService` provide version-controlled code prompts. Prompt
text is not environment-overridable and is never logged. The system prompt contains
the required non-diagnostic, non-prescriptive support boundary but does not claim to
be a safety system.

`ConversationContextService` loads only the authenticated user's active ordinary
conversation, preserves sequence order, retains the system and current user
messages, and drops whole oldest history messages to satisfy configured message and
conservative estimated-token budgets. It does not truncate psychological messages
or implement memory, summaries, embeddings or profiling. Its token estimator is
explicitly approximate and model-independent.

Browser abort, client disconnect, first-token timeout, stream-idle timeout and total
timeout propagate through one `AbortSignal` path to provider `fetch`. Stream readers,
listeners and buffers are released in `finally`. Phase 3 does not automatically
retry a streaming generation.

AI operational logging uses a typed allowlist and may record identifiers, provider,
model, durations, time to first token, token counts, finish reason, fixed failure
category, cancellation source and a safe provider trace ID. Its API cannot accept a
message, prompt, request DTO, raw provider response or arbitrary Error object. This
metadata is not automatically exposed to clients.

### Third-party production readiness

Before a real provider processes production psychological text, the project must
confirm provider data-processing terms, retention, privacy, security, applicable
mainland-China compliance, and user-consent wording. This is a production-readiness
blocker. Synthetic messages only may be used for manual provider smoke tests.

## Consequences

- Business code remains portable across LLM providers.
- Streaming is genuine but content is not irreversibly emitted before the configured
  gate sees a bounded semantic segment.
- Phase 3 cannot accidentally enable an acknowledged pass-through safety pipeline in
  Staging or Production.
- Idempotency does not require retaining any content-derived fingerprint.
- Failed provider attempts before user-visible output do not permanently consume
  quota, while retries and concurrent requests cannot double-refund it.
- Persistent turns have recoverable state and database-enforced per-conversation
  generation concurrency.
- Incognito content remains ephemeral, with explicitly accepted single-process and
  restart limitations.

## Alternatives considered

### Native EventSource with a two-request protocol

Not selected for Phase 3. A POST-to-create plus GET-to-stream flow would require
stream tickets and replay state. Fetch streaming already supports the request body,
cookies, CSRF header and cancellation.

### Token-by-token passthrough

Not selected because unsafe content cannot be retracted after delivery and Phase 4
would have no enforceable pre-emission inspection boundary.

### Full-response buffering for every request

Not selected as the default because it removes the user-experience benefit of
streaming. It remains available for future high-risk policy decisions.

### Provider SDK

Not selected because the required chat HTTP and SSE behavior is small, native fetch
supports cancellation, and an SDK would add dependency and provider-specific types
without current value.

### Redis or a message queue

Not selected because the current interactive path and early deployment do not need
distributed temporary state or background processing.
