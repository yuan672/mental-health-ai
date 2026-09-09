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
  "event": "risk_detected",
  "eventCategory": "security",
  "userId": "internal-id",
  "conversationId": "internal-id",
  "riskLevel": "critical"
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

Incognito metadata and content are not stored in PostgreSQL. The runtime temporary
context design is deferred to Phase 3 and must preserve this persistence boundary.
