# Phase 3 AI Foundation

- Phase 3 — AI Foundation: Complete
- Final merge readiness audit: Passed
- Verified: 2026-09-10
- Pull request: [#4](https://github.com/yuan672/mental-health-ai/pull/4)
- Hosted CI: [34381367823](https://github.com/yuan672/mental-health-ai/actions/runs/34381367823)

> This is the historical Phase 3 completion record. Phase 4 has since installed the
> real application safety gates and completed its engineering scope. Production AI
> remains disabled because production-readiness blockers are still unresolved. See
> `docs/ai/ai-safety.md` and `docs/PROJECT_CONTROL_HANDOFF.md` for current status.

Completion covers the Provider interface, SiliconFlow adapter, prompt management,
conversation context, true streaming response, quota orchestration, and basic AI
error handling. At the Phase 3 checkpoint, Production AI Chat remained fail-closed
until Phase 4 replaced the pass-through safety gates. Phase 4 has since supplied
real gates, while the broader Production Safety Lock remains enforced.

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

Phase 3 introduced explicit pre- and post-generation safety interfaces with
non-production pass-through implementations. Phase 4 subsequently replaced those
placeholders with real application safety gates. Prompt instructions are not a
safety system, and Staging/Production still fail closed while production readiness
is incomplete.

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

Risk Detection, `RiskEvent`, Crisis Flow, the Human Review Queue boundary, and real
output-safety policy were subsequently implemented in Phase 4. See ADR-013 for the
Phase 3 state, quota, cancellation, streaming, and persistence decisions.
