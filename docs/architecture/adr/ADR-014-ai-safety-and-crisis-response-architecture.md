# ADR-014: AI Safety and Crisis Response Architecture

- Status: Accepted
- Date: 2026-09-10
- Refines: ADR-006 and ADR-013 (does not supersede either)

## Context

Phase 3 deliberately leaves production AI chat behind unsafe pass-through gates.
Phase 4 must provide independent input-risk and output-safety services without
treating a prompt, a keyword, or a provider classification as the application's
final safety decision. Safety records are highly sensitive and have a lifecycle
separate from ordinary 90-day conversation data. Incognito mode must not bypass
safety, but it must not become a reason to retain its ordinary conversation text.

Phase completion and production readiness are different states. The code and tests
may complete Phase 4 while production AI remains disabled because real crisis
resources, privacy/compliance review, reviewer identity, or other operational
prerequisites are not yet available.

## Decision

### Hybrid risk detection and context

`RiskDetectionService` combines a deterministic signal detector, an application
`RiskClassifier` port, and an application-owned decision policy. Provider
`classifyRisk` is one signal only. Neither a matched keyword nor a provider's
candidate level becomes the final verdict without policy reconciliation.

Safety assessment uses a small owner-scoped context assembled by
`SafetyContextBuilder`. It includes the current message and only the newest whole
messages that fit configured count and estimated-token limits. It contains no
system prompt and creates no long-term memory, embedding, user profile, or safety
history. Incognito context is read only from the existing process-memory store.

The classifier uses a separate versioned `risk-classification` prompt, low
randomness, strict structured JSON, bounded enums, and Zod validation. It returns
no diagnosis or free-text reasoning. Provider reasoning and raw payloads are
discarded.

Risk level describes the safety situation reported in the conversation, not a
diagnosis and not necessarily the authenticated user's own state. Harm subject is
separate and distinguishes `SELF`, `OTHER`, and `UNKNOWN`; third-party situations
may therefore be `CRITICAL` without telling the user that they personally are in
immediate danger.

### Levels and routes

The only levels are `LOW`, `MEDIUM`, `HIGH`, and `CRITICAL`.

- `LOW`: no current self/other-harm concern; normal generation is allowed, subject
  to ordinary policy instructions and output safety.
- `MEDIUM`: concerning, ambiguous, or historical safety signals without a clear
  immediate crisis; generation receives stronger safety instructions and output
  checks.
- `HIGH`: strong current safety signals without a confirmed immediate crisis;
  ordinary supportive generation is prohibited. A dedicated high-risk prompt may
  run only with full buffering and complete output approval.
- `CRITICAL`: specific, immediate, or in-progress danger; ordinary generation is
  prohibited and deterministic Crisis Flow is used.

Pre-generation routing returns one of normal generation, generation with safety
instruction, controlled full-buffer generation, deterministic crisis response, or
deterministic degraded response. Controller code never decides a risk level.

Classifier failure never becomes `LOW`. Strong deterministic evidence may still
produce `HIGH` or `CRITICAL`; otherwise the result is a distinct safety-assessment
unavailable state. That state returns a trusted degraded response, calls no normal
generation provider, and consumes no ordinary AI quota.

### Quota and safety ordering

Quota eligibility is read before assessment but does not short-circuit risk
detection. After the safety route is known, exhausted quota blocks ordinary `LOW`
and `MEDIUM` generation. `HIGH` receives a deterministic high-risk fallback when
quota is unavailable. `CRITICAL` always receives deterministic Crisis Flow.

Risk/output classification is platform safety cost, not user chat quota. Trusted
safety templates do not consume quota. A real normal or controlled generation
consumes once. Output blocked before any approved provider content refunds; output
blocked after approved content has been delivered retains the single consumption.
Existing timeout, cancellation, disconnect, and retry rules from ADR-013 remain.

### Trusted templates and crisis resources

Classifier-unavailable responses, high-risk quota fallbacks, Crisis Flow, output
classifier fallbacks, and blocked-output replacements come from a versioned,
human-reviewable `TrustedSafetyTemplateRegistry`. Templates do not depend on the
classifier that failed and accept no arbitrary user-text interpolation.

Crisis Flow has distinct self-directed and third-party urgent variants. It does
not diagnose, shame, threaten, guarantee rescue, promise confidentiality, or claim
that a person is monitoring or will contact the user.

`CrisisResourceRegistry` validates jurisdiction, locale, name, contact method/value,
authoritative source, verification date, active state, and verification metadata.
Tests use synthetic resources only. No remembered or unverified hotline is treated
as real. Human/authoritative verification of mainland-China resources is required
before production AI can be enabled.

### Output safety and streaming

`OutputSafetyCheck` combines deterministic output signals, an application
`OutputSafetyClassifier` port, and policy. It covers diagnosis claims, disease
conclusions, medication/dosage or stop-medication instruction, encouragement or
actionable guidance for self/other harm, dangerous instructions, professional
impersonation, treatment guarantees, and inappropriate casual responses in a
high-risk situation.

For `LOW` and `MEDIUM`, provider deltas enter the existing semantic buffer and the
complete candidate segment is approved before SSE emission. For `HIGH`, the entire
provider response is buffered and approved before any part is emitted. `CRITICAL`
does not call normal generation.

An output block or unavailable output classifier aborts the upstream provider,
releases the reader, and discards unapproved content. The user receives a trusted
replacement. Only an already-approved prefix plus that replacement may be saved;
blocked provider text is never persisted. The public SSE event vocabulary remains
unchanged and does not expose risk level.

### Safety persistence and idempotency

`risk_events` stores only bounded safety metadata. It never stores messages,
conversation excerpts, prompts, hashes/fingerprints, classifier reasoning, or raw
provider data. `LOW` creates no event; `MEDIUM` creates an event without a review
item by default; `HIGH` and `CRITICAL` create an event and one review item.

Conversation, AI-turn, message, and user references are nullable and use
`ON DELETE SET NULL`, allowing Risk Event retention to remain independent. This is
a technical lifecycle boundary, not a legal conclusion about post-deletion
retention. An ordinary AI turn has at most one Risk Event. Incognito idempotency is
bounded by user and client request ID. A review item is unique per Risk Event and
cascades when its Risk Event is removed.

Incognito Risk Events contain only user linkage, client request ID, bounded risk
metadata, policy/classifier identity, and timestamps. They contain no session ID,
context ID, message, response, prompt, or content-derived hash. Phase 4 creates no
raw incognito snapshot. Any future snapshot requires a separate decision covering
managed field encryption, key lifecycle, explicit access, and exact short
retention.

Risk Event retention is configured through a policy; 180 days is the current
development/product setting, not a legal requirement. Bounded cleanup is provided,
but production scheduling remains deployment work.

`human_review_queue_items` is an internal workflow with priority, state, optional
opaque reviewer principal, timestamps, and bounded resolution code. It promises no
SLA, live takeover, or 24/7 monitoring. A `SafetyReviewerAuthorizer` boundary
defaults to denial without a real reviewer principal provider. Phase 4 exposes no
Admin controller or UI.

`audit_logs` is append-only through the application service and stores actor,
action, resource reference, timestamp, action-specific Zod-validated safe metadata,
and configurable retention. It stores no psychological text or arbitrary DTO/error.

Safety Operational Logging avoids `userId + riskLevel` and
`conversationId + riskLevel`. It records allowlisted timing, classifier identity,
decision-path category, fixed failure category, turn ID, and Risk Event ID where
available. Restricted risk level remains in Risk Event storage.

### Production readiness

Phase 4 completion does not set `productionSafe = true`. A separate readiness
evaluator verifies concrete pre/post gates, schema validation and fail-closed
behavior, Crisis Flow, persistence boundaries, reviewed corpus, absence of
pass-through gates and synthetic resources, verified crisis resources, reviewer
access, production configuration, and consent/privacy prerequisites.

With AI chat disabled, Staging and Production may start. With AI chat enabled, any
missing readiness condition keeps startup fail-closed.

## Consequences

- Safety remains an application responsibility independent of prompts and vendors.
- Quota exhaustion cannot suppress the minimum deterministic crisis response.
- High-risk and critical flows have materially different behavior.
- Risk metadata survives ordinary chat cleanup without retaining copied chat text.
- Incognito cannot bypass safety and does not become long-term conversation storage.
- Human review has an auditable backend boundary without prematurely building Admin.
- Production AI remains locked until non-code operational and compliance work is
  genuinely complete.

## Alternatives considered

### Keyword or provider verdict as the final risk level

Rejected because negation, history, third-party statements, context and provider
uncertainty would create unacceptable false positives and false negatives.

### Fail open when a classifier is unavailable

Rejected because a safety outage must not silently become unrestricted generation.

### Persist incognito excerpts for reviewer convenience

Rejected because no managed field-encryption and access lifecycle exists. Structured
minimal safety metadata is retained instead.

### PostgreSQL enums for every safety code

Rejected because reason and audit codes must evolve with policy/corpus updates.
Stable workflow states use database enums; evolving codes use application-validated
text or JSON structures.
