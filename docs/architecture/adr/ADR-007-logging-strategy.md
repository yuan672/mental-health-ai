# ADR-007: Logging Strategy

- Status: Accepted
- Date: 2026-09-09

## Context

Mental-health conversations are highly sensitive. The handoff explicitly prohibits logging complete user psychological chat content in ordinary application logs and distinguishes Application, Security, Audit and AI Operational logs.

## Decision

Use **Pino structured JSON logging** with request IDs, explicit event names and aggressive secret/header redaction.

Phase 1:

- Application Log: structured stdout JSON.
- Security Log: same transport initially, distinguished by structured `logType/event`; no secrets or message bodies.
- AI Operational Log: same transport initially, metadata only; no prompt/response bodies by default.
- Audit Log: application interface now; persistent append-oriented database records when the relevant human/admin features are implemented.

Never log request bodies by default. Redact authorization/cookie/token/password/API-key fields.

## Why this fits

- Pino is lightweight and native structured JSON.
- Built-in redaction supports defense in depth.
- JSON works locally and with later centralized log platforms.
- Separating log semantics now avoids conflating debugging with human-access audit records later.

## Alternatives

### Winston

Mature and flexible.

**Not selected now:** Pino's JSON-first design and redaction are a closer fit with less configuration.

### OpenTelemetry-first logging

Useful in distributed systems.

**Not selected now:** there are no microservices or observability backend requiring it. Trace/metric export can be added later.

## Future impact

Production may route categories to different sinks/retention policies. Audit records must not rely solely on disposable application log streams.
