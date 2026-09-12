# Project Control Handoff

This file is a concise operational status summary. It does not replace the product
and engineering baseline in `docs/HANDOFF.md`, or any Accepted ADR.

## Current State

- Engineering Bootstrap / Phase 1: Complete
- Phase 2 — Core Backend Foundation: Complete
- Phase 3 — AI Foundation: Complete
- Phase 4 — AI Safety: Engineering scope complete
- Phase 5 — User Features: In progress; Phase 5A through Phase 5D are engineering
  complete, and the bounded Phase 5E-1 content foundation and Phase 5E-2 Web
  reader are engineering complete; curated production content and the separately
  authorized AI integration batch remain incomplete
- Phase 5C — Incognito and Privacy Experience: Engineering complete; production
  policy/content approval and production enablement remain incomplete
- Phase 5B — Chat Product Experience: Product UI engineering complete
- Phase 5D — Mood / Profile: Engineering complete; ADR-017 and the engineering
  contract are accepted, with the backend delivered by PR #18 and the Web
  experience delivered by PR #20
- Phase 5E — Knowledge Base: ADR-018 and the minimum design are accepted;
  Phase 5E-1 content-foundation engineering is complete and delivered by PR #22;
  Phase 5E-2 Web reader engineering is complete and delivered by PR #23; curated
  production content remains unverified and unpublished; the bounded LLM +
  Knowledge architecture is accepted in ADR-019 and the Knowledge AI-A backend is
  engineering complete and delivered by PR #25; Knowledge AI-B remains pending,
  with its former Web implementation direction paused for a replacement frontend,
  so Phase 5E is not phase-complete
- Phase 6 — Admin and operations features: ADR-020 staff-identity and
  least-privilege backend design accepted; Batch 1 identity/session/authorization
  implementation is merged through PR #27 and its deterministic cancellation-test
  repair is merged through PR #28; Batch 2 metadata-only Risk Event and Human
  Review Queue backend implementation is engineering complete and merged through
  PR #29; Batch 3 staff-only Knowledge Management backend contract is in design
  review; no Admin UI is included

## Current Production State

- Production Safety Lock: Enforced
- Production AI Chat: Disabled
- `productionSafe=false`
- Real model safety evaluation: Not evaluated

Phase 4 engineering completion is not a claim of production readiness, clinical
safety, or validation for clinical use.

## Latest Completed Pull Requests

- [PR #1](https://github.com/yuan672/mental-health-ai/pull/1) — Engineering Bootstrap
- [PR #2](https://github.com/yuan672/mental-health-ai/pull/2) — Identity and Access Foundation
- [PR #3](https://github.com/yuan672/mental-health-ai/pull/3) — Conversation and Quota Foundation
- [PR #4](https://github.com/yuan672/mental-health-ai/pull/4) — AI Foundation
- [PR #5](https://github.com/yuan672/mental-health-ai/pull/5) — AI Safety Foundation
- [PR #6](https://github.com/yuan672/mental-health-ai/pull/6) — Phase 4 completion status
- [PR #7](https://github.com/yuan672/mental-health-ai/pull/7) — Documentation reconciliation
- [PR #8](https://github.com/yuan672/mental-health-ai/pull/8) — Conversation Access API
- [PR #10](https://github.com/yuan672/mental-health-ai/pull/10) — Chat Product Experience
- [PR #12](https://github.com/yuan672/mental-health-ai/pull/12) — Incognito and read-only Privacy experience
- [PR #13](https://github.com/yuan672/mental-health-ai/pull/13) — Accepted Consent lifecycle architecture
- [PR #14](https://github.com/yuan672/mental-health-ai/pull/14) — Consent lifecycle backend
- [PR #15](https://github.com/yuan672/mental-health-ai/pull/15) — Consent withdrawal race-test
  finalization
- [PR #16](https://github.com/yuan672/mental-health-ai/pull/16) — Privacy Consent lifecycle UI
- [PR #17](https://github.com/yuan672/mental-health-ai/pull/17) — Accepted Mood/Profile architecture
- [PR #18](https://github.com/yuan672/mental-health-ai/pull/18) — Mood/Profile backend
- [PR #19](https://github.com/yuan672/mental-health-ai/pull/19) — Privacy, registration,
  narrow-layout, and session-expiry Web fixes
- [PR #20](https://github.com/yuan672/mental-health-ai/pull/20) — Mood/Profile Web
  experience and final state-recovery fixes
- [PR #22](https://github.com/yuan672/mental-health-ai/pull/22) — Knowledge Base
  content foundation and source-evidence freeze boundary
- [PR #23](https://github.com/yuan672/mental-health-ai/pull/23) — Knowledge Base Web
  reader and final accessibility/state recovery fixes
- [PR #25](https://github.com/yuan672/mental-health-ai/pull/25) — Knowledge AI-A
  backend and final history consistency/environment-isolation fixes
- [PR #27](https://github.com/yuan672/mental-health-ai/pull/27) — Admin Batch 1
  staff identity, sessions, finite authorization, and audited access lifecycle
- [PR #28](https://github.com/yuan672/mental-health-ai/pull/28) — Deterministic
  output-classification cancellation-test repair
- [PR #29](https://github.com/yuan672/mental-health-ai/pull/29) — Admin Batch 2
  metadata-only Risk Event and Human Review Queue backend

## Current Feature Status

- Phase 5A is merged into `develop` and its post-merge CI passed.
- Phase 5B is merged into `develop` and its post-merge quality and browser E2E CI passed.
- [PR #12](https://github.com/yuan672/mental-health-ai/pull/12) is the delivery
  record for the bounded Phase 5C batch: a session-bound public Incognito
  lifecycle, strict
  persistent/Incognito chat protocol, bounded in-process context, runtime cleanup,
  and a read-only Privacy/Consent overview. This does not mark all Phase 5C
  product-policy work complete.
- Mood/Profile product scope and engineering contract are accepted in ADR-017.
  [PR #18](https://github.com/yuan672/mental-health-ai/pull/18) is the delivery record
  for the Mood/Profile API, generated 0006 migration, content-free deletion Audit
  actions, and final-check tests. [PR #20](https://github.com/yuan672/mental-health-ai/pull/20)
  delivers the bounded Mood/Profile Web experience, including authoritative
  recovery after unknown or conflicting mutations. Phase 5D is engineering
  complete. The Phase 5E minimum Knowledge Base design and ADR-018 are accepted;
  Phase 5E-1 delivers the three-table model,
  forward-only 0007 migration, authenticated read API, exact-version release
  commands, source-evidence freeze boundary, and guarded unverified synthetic
  fixtures. PR #23 delivers the authenticated Phase 5E-2 list/detail reading
  experience, strict response validation, safe bounded-block rendering, exact
  source and source-review-date display, empty-state recovery, session cleanup,
  and synthetic browser coverage. Phase 5E-2 Web engineering is complete. No
  curated production content has been published. The first three content candidates
  remain unverified and awaiting article-by-article human review. Accepted ADR-019
  and `docs/architecture/phase-5e-llm-knowledge-integration-design.md` define the
  bounded local lexical-retrieval and exact-version citation architecture. The
  Knowledge AI-A adds local bounded retrieval, strict
  grounded-response validation, negotiated v2 delivery/history, and atomic
  assistant-message provenance through forward-only Migration
  `0008_gorgeous_gladiator`. The enhancement is disabled by default; the existing
  Web remains v1 until Knowledge AI-B, and a v1 history page containing a referenced
  message fails closed with `CLIENT_CAPABILITY_REQUIRED` (HTTP 406). Message bodies,
  frozen references, and sources are read from one short repeatable-read history
  snapshot; Staging/Production also reject synthetic historical evidence without
  deleting or rewriting it. No content publication, real-model evaluation, or AI
  enablement is authorized.
  Admin Batch 1 identity/authorization and Batch 2 metadata-only safety review are
  engineering complete. Knowledge Management, general Audit Read, AI Quality, all
  Admin UI, and production enablement remain outside completed scope.

The existing Web is not a design constraint for the replacement frontend. New page,
style, component, interaction, and Knowledge AI-B reducer work is paused in this
backend task. The v2 streaming/history capability, delivery-mode, reference,
reconciliation, 406, Session, Consent, CSRF, privacy, and data-minimization backend
contracts remain authoritative and ready for a replacement frontend to consume.

## Phase 5C Batch Scope and Open Consent Product Flow

The bounded Phase 5C batch covers Incognito create/chat/end/lost-state UX and a
sanitized, paginated view of current required Consent status and known Consent
history. Incognito ordinary text remains outside browser persistent storage and
ordinary Conversation, Message, and AI Turn tables. Necessary minimal Risk Event
and Audit records remain possible under ADR-014.

ADR-016 is Accepted as the Consent lifecycle architecture. It narrowly
supersedes ADR-011's single-lifecycle/no-reaccept constraint and ADR-015's broad
all-user withdrawal cleanup rule; all other decisions in those ADRs remain
Accepted. The merged backend provides the projection/decision ledger,
environment-aware document registry, operation replay, and single-process
dependency-scoped dispatch/cancellation coordination. PR #16 adds the Privacy
withdrawal, same-version re-acceptance, new-version and legacy confirmation
controls. Client-side handling preserves unknown-result requests for exact replay,
requires an authoritative refresh before replacement operations, and leaves
dependency-scoped execution cancellation to the server rather than cancelling any
active workspace on every withdrawal response. Consent types, formal legal copy,
production document approval, retention, account
deletion/export, backup deletion, and cross-instance cancellation remain
unresolved production matters.

The backend response contract separates immutable historical evidence from the
current environment-eligible `acceptableDocument`, filters unavailable or
synthetic identities from Staging/Production responses, and supplies
authoritative current revisions for historical as well as required projections.
Committed withdrawals whose database acknowledgement is lost are reconciled
inside the same-process coordination boundary; dependent work remains fail closed
while the client receives an honest unknown-result error and can replay the exact
operation. These backend guarantees do not implement the remaining Privacy
controls.

## Production Readiness Blockers

- Authoritative human verification of mainland-China crisis resources
- Provider privacy, data-retention, security, and applicable compliance review
- Consent wording review for real third-party generation and safety classification
- Production age-verification provider
- Real reviewer identity, least-privilege authorization, and RBAC
- Human review of the safety corpus and trusted safety templates
- Real-model safety and quality evaluation
- Production retention and account-deletion policy
- Database encryption and key-management policy
- Backup, restore, and deletion verification
- Automated retention-cleanup scheduler
- Abuse prevention and rate limiting
- Deployment-layer SSE buffering and disconnect verification
- Production AI quota policy
- Multi-instance Incognito runtime decision
- Complete production configuration and secret provisioning

## Active Parallel Work

- Replacement frontend design and implementation are user-owned and outside this
  backend task. No uncommitted AI-B work was present when the backend Admin design
  branch was created.

## Immediate Next Step

Review the Phase 6 Batch 3 staff-only Knowledge Management backend contract in
`docs/architecture/phase-6-admin-knowledge-management-design.md` and
`docs/api/admin-knowledge-management.md`. It refines the already accepted
editor/source-reviewer/publisher separation without adding an Admin UI or changing
the public reader and exact-version Knowledge AI contracts. General Audit Read and
AI Quality batches remain unimplemented. Knowledge AI-B remains pending for the
replacement frontend; keep augmentation disabled by default and retain the v2
reader plus v1 history guard. The three candidate articles remain unverified and
unpublished, and real-model evaluation remains separate work.

## Source of Truth

Use the following precedence when determining requirements, architecture, and
current implementation state:

1. `docs/HANDOFF.md` — highest product, scope, safety, data, and engineering baseline
2. Accepted ADRs — binding architecture decisions unless superseded by a new ADR
3. Current code, schema, migrations, and tests — implemented engineering behavior
4. Phase status documents — verified phase completion records
5. Current Git and GitHub state — branches, commits, pull requests, and CI
6. This file — concise current project-control summary

If this summary conflicts with `docs/HANDOFF.md` or an Accepted ADR, stop the
conflicting work and resolve the discrepancy; do not silently change direction.
