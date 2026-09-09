# Phase 3 AI Chat Streaming API

Phase 3 exposes one AI transport endpoint:

| Method | Path            | Authentication | CSRF requirement             |
| ------ | --------------- | -------------- | ---------------------------- |
| POST   | /ai/chat/stream | Session cookie | Origin + double-submit token |

The JSON request contains a UUID `clientRequestId`, an optional owned
`conversationId`, and a non-empty `message`. If the conversation ID is omitted,
the service creates an ordinary 90-day conversation. A client request ID identifies
one AI turn for one authenticated user. Reusing it returns the existing turn state,
does not call the provider again, and does not consume quota again.

New turns return `text/event-stream`. The browser uses `fetch` plus
`ReadableStream`, not native `EventSource`, because the call needs a POST body,
cookie authentication, CSRF header, and cancellation signal.

## Events

```text
event: turn.started
data: {"turnId":"...","conversationId":"..."}

event: message.segment
data: {"turnId":"...","sequence":1,"text":"..."}

event: turn.completed
data: {"turnId":"...","assistantMessageId":"...","finishReason":"stop"}

event: turn.failed
data: {"turnId":"...","code":"AI_PROVIDER_UNAVAILABLE","message":"AI 服务暂时不可用"}
```

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
