# AI Chat Streaming API

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

## Negotiated Knowledge-reference representation

The Phase 5E Knowledge AI-A backend Draft adds an opt-in v2 representation without
changing the four SSE event names. The client requests it on both the stream and
message-history requests:

```http
X-MH-Knowledge-References: 1
```

An omitted or empty header selects v1 and disables Knowledge augmentation for that
stream. The value `1` selects v2; a different non-empty value returns the typed
`VALIDATION_ERROR` response. Successful v2 responses echo the header and all
representations include `Vary: X-MH-Knowledge-References`. CORS exposes the
acknowledgement header to the configured Web origin.

Every v2 `message.segment` adds a required `deliveryMode`:

- `immediate` preserves the existing semantic-stream behavior. Its matching
  completion has `knowledgeReferences: []`.
- `commit_with_references` is used only for a Knowledge hit. The server emits one
  full-buffered, Output-Safety-approved segment. A citation-aware client holds the
  text in bounded memory and makes it visible only after a matching
  `turn.completed` carries the same delivery mode and one or two validated
  `knowledgeReferences`.

Each public reference identifies the exact article key and version used, the
frozen ordered source set, review state and review time, and whether that version
is still published. It does not expose an internal article-version UUID, retrieval
query, selected excerpt, prompt, model-authored URL, or user risk metadata. Trusted
safety replacements remain `immediate` and carry no Knowledge reference.

Persistent message history negotiates the same header on
`GET /conversations/:id/messages`. A v2 response adds a required
`knowledgeReferences` array to every message. A v1 request for a page that contains
a referenced assistant message fails closed with HTTP 406
`CLIENT_CAPABILITY_REQUIRED`; an affected client must update instead of displaying
the body without its provenance. Unreferenced pages remain readable as v1.

The existing Web application deliberately remains a v1 client until the separately
reviewed Knowledge AI-B batch. Therefore the AI-A enhancement is disabled by
default and cannot create a grounded answer for that client. If persistent
references already exist, disabling new augmentation does not remove the v2
history reader or the v1 406 guard.

Segments are ordered and have passed the configured post-generation gate before
delivery. `turn.completed` is emitted only after the complete assistant message is
committed. A `turn.failed` event means any displayed partial text is transient and
must not be treated as committed conversation history.

For a v2 grounded turn, a lost database commit acknowledgement is reconciled with
a bounded wait on that exact turn before any answer is emitted. If the result still
cannot be proven, the stream closes without `message.segment`, `turn.completed`, or
a definitive `turn.failed`; the client keeps the request in an uncertain state and
uses strict v2 history reconciliation. This avoids both falsely reporting rollback
and exposing an uncommitted answer.

Provider request IDs, model/provider metadata, token accounting, prompt text and
prompt version are not part of the public event schema. Errors before streaming
starts use the standard JSON API error contract. This includes a timeout, Consent
withdrawal, or Incognito-context termination that wins after server preparation
but before SSE headers: the server first performs the pre-dispatch cleanup and then
returns the corresponding typed JSON error while the connection remains writable.
No Provider transport is started in that window.

The client cancels through `AbortController`. The API does not automatically retry
a generation or reconnect an SSE stream. A no-new-work persistent recovery may
replay the original `clientRequestId` only when the client has positive admission
evidence and the confirmed original `conversationId`; the server correlates the ID
to the retained turn. If that Conversation was deleted or purged, recovery stops
with the existing not-found boundary and never falls back to a create-without-ID
request. When the original Conversation identity is unknown, the client may only
refresh read-only state and preserve an honest uncertain result. A user-approved
unbound continuation is creation-capable and must not be presented as metadata-only
recovery. An Incognito `clientRequestId` is single-use within its live context:
reuse is rejected, and an ended, expired, or lost context cannot be recovered or
restarted with that identifier. A deliberate new attempt after a definite failure
uses a new `clientRequestId`.

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
