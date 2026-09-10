# Logging and Sensitive Data Baseline

## Never log by default

- full user psychological chat messages;
- LLM prompts or responses containing user conversation content;
- passwords, session tokens, cookies or authorization headers;
- API keys or database credentials;
- full identity-verification payloads.
- email identifiers in ordinary application or security-event logs;
- raw CSRF tokens and `x-csrf-token` headers.

## Prefer structured metadata

Example event:

```json
{
  "event": "risk_detection_completed",
  "eventCategory": "safety_operational",
  "turnId": "internal-id",
  "classifierKey": "risk-classification",
  "classifierVersion": "version-id",
  "riskDetectionDurationMs": 120,
  "decisionPath": "hybrid"
}
```

Risk events, audit records and ordinary conversation storage are separate data concepts and must have separate lifecycle/access rules.

## Identity and access boundary

Phase 2A security events go through a typed wrapper over Pino. The wrapper
accepts only allowlisted metadata such as internal user/session IDs and fixed
failure reasons. It does not accept request bodies, email addresses,
passwords, cookies, raw session tokens, CSRF tokens or age-verification
evidence. Phase 2A does not add an audit-log table or separate logging service.

HTTP logging removes request bodies, `Authorization`, `Cookie`, `Referer`,
`x-csrf-token`, `x-api-key`, and response `Set-Cookie` values. Known secret
field names are redacted at both root and one nested object level.

## Phase 2B conversation boundary

Conversation and message services log only fixed event names and identifiers such as
`userId`, `conversationId`, `messageId`, and message role. Repository records and
message content are never passed to the logger. Explicit Pino paths for common
conversation-content field names provide defense in depth; they do not replace the
typed logging boundary.

Incognito metadata and content are not stored in PostgreSQL. Phase 3 preserves this
boundary with an internal process-memory TTL store.

## Phase 3 AI operational boundary

AI operational events use a typed, allowlisted Pino wrapper. They may include
internal user/conversation/turn IDs, provider/model identifiers, a safe provider
trace ID, latency/TTFT, normalized token counts, finish reason, fixed failure
category, and cancellation source. The wrapper does not accept messages, prompts,
request DTOs, raw provider responses, arbitrary errors, credentials, cookies, or
CSRF tokens.

SiliconFlow parsing discards provider-specific `reasoning_content` and raw payloads.
Only normalized deltas cross the provider port. HTTP body redaction remains defense
in depth; code must still never pass psychological content to a logger.

Incognito Phase 3 context is held only in API process memory with TTL and is scoped
by user ID, session ID, and opaque context ID. Logout clears that session's entries;
process restart removes all entries. PostgreSQL contains no incognito context or
message data.

## Phase 4 safety boundary

Risk level and bounded reason codes belong in restricted `risk_events`, not in
wide-access operational logs. Safety operational logging must not create a second
risk database by recording `userId + riskLevel` or
`conversationId + riskLevel`. It records only allowlisted timing, fixed decision
and failure categories, classifier key/version, turn ID, and an existing Risk
Event ID when needed.

Risk Events, review queue items, and audit records never store message text,
conversation excerpts, prompts, provider payloads, reasoning content, or
content-derived fingerprints. Incognito Risk Events also exclude session/context
identifiers and all ordinary conversation content.

`audit_logs.safe_metadata` is validated by an action-specific Zod allowlist.
It cannot accept arbitrary DTOs or errors. Extra Pino redaction paths for
`reasoning_content` and raw-provider field names are defense in depth.
