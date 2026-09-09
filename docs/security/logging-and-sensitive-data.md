# Logging and Sensitive Data Baseline

## Never log by default
- full user psychological chat messages;
- LLM prompts or responses containing user conversation content;
- passwords, session tokens, cookies or authorization headers;
- API keys or database credentials;
- full identity-verification payloads.

## Prefer structured metadata
Example event:

```json
{
  "event": "risk_detected",
  "logType": "security",
  "userId": "internal-id",
  "conversationId": "internal-id",
  "riskLevel": "critical"
}
```

Risk events, audit records and ordinary conversation storage are separate data concepts and must have separate lifecycle/access rules.
