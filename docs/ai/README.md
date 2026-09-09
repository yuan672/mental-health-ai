# Phase 3 AI Foundation

Phase 3 implements an application-owned `LLMProvider` port, a SiliconFlow adapter,
versioned code prompts, bounded conversation context, quota-aware AI-turn
orchestration, genuine provider streaming, and a minimal browser stream client.
Provider-specific types and payloads do not enter controllers or domain services.

The persistent request path is:

```text
authenticated user → current consent → active owned conversation → idempotent turn
→ quota + user-message transaction → LLMProvider stream → bounded sentence buffer
→ post-generation safety gate → SSE → assistant-message commit → completion event
```

The browser uses `POST /ai/chat/stream` with `fetch`, cookies, the existing CSRF
header, and `ReadableStream`. Native `EventSource`, WebSocket, Redis, and queues are
not part of this path. Public events are `turn.started`, `message.segment`,
`turn.completed`, and `turn.failed`.

## Provider configuration

`LLM_PROVIDER=none` keeps external provider access disabled.
`LLM_PROVIDER=siliconflow` requires backend-only `LLM_API_KEY`, `LLM_BASE_URL`, and
`LLM_MODEL` values. No LLM credential may use a `VITE_` prefix. Node's native
`fetch` consumes SiliconFlow's OpenAI-compatible streaming endpoint directly;
CI uses a fake provider and local mock HTTP server only.

Operational timeout, context, output, segment-buffer, and incognito-TTL settings
are validated environment values. They are initial engineering controls, not
clinical or product-safety constants.

## Safety and privacy boundary

Phase 3 includes explicit pre- and post-generation safety interfaces but only
non-production pass-through implementations. With AI chat enabled, Staging and
Production fail startup while these unsafe placeholders are configured. Prompt
instructions are not a safety system.

Ordinary assistant output is held in memory until complete before it is persisted.
Partial streamed output is never written as an assistant message. Incognito context
is an internal process-memory TTL capability scoped to user and server session; it
does not write conversations, messages, or AI turns to PostgreSQL and has no public
lifecycle API in Phase 3.

An internal admission gate checks the stable PostgreSQL quota ledger before an
incognito generation may reach a Provider. If volatile context is missing for an
already-consumed client request, it fails closed without restoring content or
calling the Provider.

Before a real provider processes production psychological text, provider data
processing, retention, privacy, security, applicable mainland-China compliance,
and user-consent wording must be approved. This remains a production-readiness
blocker.

Risk Detection, `RiskEvent`, Crisis Flow, human review, and real output-safety
policy remain Phase 4 work. See ADR-013 for the full state, quota, cancellation,
streaming, and persistence decisions.
