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

## Phase 4 completion status

- Phase 4 — AI Safety: Complete (engineering scope)
- Final merge-readiness audit: Passed
- Verified: 2026-09-10
- Pull request: [#5](https://github.com/yuan672/mental-health-ai/pull/5)
- Merge commit: [`23320839`](https://github.com/yuan672/mental-health-ai/commit/233208395682a917f09448bbf1589381118932f7)
- Hosted CI: [34443340270](https://github.com/yuan672/mental-health-ai/actions/runs/34443340270)

Phase 4 is complete within its engineering scope, but the system is not ready to
enable production AI. The Production Safety Lock remains enforced, Production AI
Chat remains disabled, and `productionSafe` remains `false` until every production
readiness prerequisite is independently satisfied.

## Final merge-readiness audit evidence

The 2026-09-10 engineering audit validated PR #5 at head commit `d8bc10f8`, after
which the pull request was merged normally into `develop` as `23320839`. The
merge commit's hosted CI passed. This status does not claim that production AI is
ready. The audit covers transactional crisis fallback failures, reviewer
authorization plus mandatory access audit, whole-turn deadlines, classifier
cancellation and late-result rejection, SSE backpressure, retention, idempotency,
and empty-database migrations. The complete local suite contains 168 API tests and
8 Web tests; the Phase 4-focused subset contains 80 API tests.

The 28 table-driven Simplified Chinese corpus rows are engineering fixtures:

- 16 input rows exercise deterministic signal extraction.
- 12 output rows exercise deterministic output-safety signals.
- Separate tests exercise `RiskDecisionPolicy`, fake-classifier orchestration,
  transactional side effects, and the SiliconFlow HTTP/JSON adapter contract.

All orchestration tests use fake classifiers/providers or a local synthetic HTTP
server. They do not call a real model and do not measure model accuracy, recall,
clinical effectiveness, or overall safety. Real-model evaluation and human review
of the corpus and trusted templates remain production-readiness work. No real user
psychological text is sent to a third party by these tests.

Risk Event `ON DELETE SET NULL` references are a technical retention boundary; they
do not constitute complete anonymization or a legal conclusion. Automatic safety
retention scheduling, production account-deletion policy, and deployment-layer SSE
buffering validation also remain pending.

Current production state is intentionally:

- **Production Safety Lock: Enforced**
- **Production AI Chat: Disabled**
- **productionSafe: false**

The remaining blockers include authoritative verification of mainland-China crisis
resources, provider privacy/security/retention and applicable compliance review,
consent wording review, real least-privilege reviewer identity/RBAC, formal corpus
and trusted-template review, real-model evaluation, production retention and
account-deletion policy, database encryption and tested backups, automatic cleanup
scheduling, complete production configuration, and deployment-layer streaming
buffering verification.
