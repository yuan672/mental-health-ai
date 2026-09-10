# Phase 4 AI Safety Implementation

Phase 4 installs an application-owned safety path around AI generation:

```text
authenticated user → consent → ownership → idempotent turn claim
→ quota eligibility read → bounded safety context → hybrid risk detection
→ route decision → controlled generation or trusted deterministic response
→ output safety approval → SSE
```

The four risk levels are `LOW`, `MEDIUM`, `HIGH`, and `CRITICAL`.
They describe the reported safety situation, not a diagnosis. Harm subject is a
separate `SELF | OTHER | UNKNOWN` field, so a third-party critical situation
uses third-party guidance rather than telling the authenticated user that they
personally face immediate danger.

`LOW` uses semantic streaming. `MEDIUM` adds safety instructions and persists
minimal Risk Event metadata. `HIGH` uses a dedicated prompt, full buffering,
complete output review, a Risk Event, and an internal review item. `CRITICAL`
does not invoke normal generation and uses a versioned deterministic Crisis Flow
template. Classifier failure never becomes LOW: absent strong deterministic
evidence, it returns a trusted degraded template without consuming ordinary AI
quota.

Provider output is never emitted before output-safety approval. A blocked or
unassessable candidate aborts upstream generation and is discarded. Only an
approved prefix plus a trusted replacement may be persisted. Risk/output
classification is platform safety cost, while only actual normal or controlled
generation consumes user quota.

## Restricted persistence

`risk_events` contains bounded categories/reason codes and policy/classifier
versions, not chat text. Its nullable user/conversation/turn/message references
use `ON DELETE SET NULL`, allowing its configured lifecycle to remain independent
of ordinary chat retention. `human_review_queue_items` is unique per Risk Event
and cascades with it. `audit_logs` accepts only action-specific safe metadata.

Incognito HIGH/CRITICAL handling may persist only minimal Risk Event, queue, and
audit metadata. It never stores incognito messages, responses, session/context
IDs, prompts, or content fingerprints. No raw safety snapshot exists in Phase 4.

Run bounded expiry cleanup with:

```bash
pnpm data:purge-safety
```

Production scheduling is not wired in this phase.

## Production lock

Phase 4 functional completion does not mean production AI is safe to enable.
The readiness evaluator remains false while any prerequisite is missing. Current
blockers include authoritative human verification of mainland-China crisis
resources, provider privacy/security/retention review, consent wording review,
real least-privilege reviewer identity/access, formal safety-corpus review, and
production retention/encryption/backup policy.

Development and tests use clearly synthetic crisis resources. They must never be
presented as real contacts. Staging/Production can run with AI Chat disabled, but
AI Chat remains fail-closed while readiness is incomplete.

No Admin/Reviewer UI, live human takeover, SLA, notification system, Redis/queue,
or field-level encryption framework is implemented in Phase 4.
