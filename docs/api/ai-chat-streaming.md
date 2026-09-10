# Phase 3 AI Chat Streaming API

Phase 3 exposes one AI transport endpoint:

| Method | Path            | Authentication | CSRF requirement             |
| ------ | --------------- | -------------- | ---------------------------- |
| POST   | /ai/chat/stream | Session cookie | Origin + double-submit token |

The JSON request is a strict mode-discriminated union. Persistent chat contains
`mode: "persistent"`, a UUID `clientRequestId`, an optional owned
`conversationId`, and a non-empty `message`. If the conversation ID is omitted,
the service creates an ordinary 90-day conversation. A client request ID identifies
one AI turn for one authenticated user. Reusing it returns the existing turn state,
does not call the provider again, and does not consume quota again.

Incognito chat contains `mode: "incognito"`, `clientRequestId`, an opaque
`contextId` returned by `POST /incognito-contexts`, and `message`. It uses the same
authentication, consent, quota, risk detection, crisis, provider, and output-safety
chain, but stores ordinary chat content in process memory only. It creates no
Conversation, Message, or AI Turn row. Necessary minimal Risk Event and Audit data
remain governed by ADR-014.

New turns return `text/event-stream`. The browser uses `fetch` plus
`ReadableStream`, not native `EventSource`, because the call needs a POST body,
cookie authentication, CSRF header, and cancellation signal.

## Events

```text
event: turn.started
data: {"mode":"persistent","turnId":"...","conversationId":"..."}

event: message.segment
data: {"mode":"persistent","turnId":"...","sequence":1,"text":"..."}

event: turn.completed
data: {"mode":"persistent","turnId":"...","assistantMessageId":"...","finishReason":"stop"}

event: turn.failed
data: {"mode":"persistent","turnId":"...","code":"AI_PROVIDER_UNAVAILABLE","message":"AI 服务暂时不可用"}
```

Incognito payloads use `mode: "incognito"` and `generationId`; they do not contain
`conversationId`, `turnId`, or `assistantMessageId`. Both variants keep the same
four event names. Clients must reject a mode/identifier mismatch, out-of-order
segments, and events arriving after completion, failure, cancellation, or context
termination.

Segments are ordered and have passed the configured post-generation gate before
delivery. `turn.completed` is emitted only after the complete assistant message is
committed. A `turn.failed` event means any displayed partial text is transient and
must not be treated as committed conversation history.

Provider request IDs, model/provider metadata, token accounting, prompt text and
prompt version are not part of the public event schema. Errors before streaming
starts use the standard JSON API error contract.

The client cancels through `AbortController`. Phase 3 does not automatically retry
a generation or reconnect an SSE stream. A retry for the same logical turn must
reuse its `clientRequestId`.

## Incognito context lifecycle

| Method | Path                             | Purpose                          |
| ------ | -------------------------------- | -------------------------------- |
| POST   | `/incognito-contexts`            | Create one session-bound context |
| DELETE | `/incognito-contexts/:contextId` | End one context idempotently     |

Both operations require session authentication and CSRF protection. Responses are
`private, no-store`. Create also requires enabled AI chat and current required
consent. End deliberately remains available after consent withdrawal or AI disable.
It does not disclose whether the context existed or belonged to another session.

The context has a bounded inactivity TTL capped by session expiry. Explicit end,
logout, session invalidity, withdrawal, expiry, and process restart make it
unavailable. Phase 5C provides no refresh recovery, cross-instance store, public
context listing, or resume endpoint.
