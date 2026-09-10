# Project Control Handoff

This file is a concise operational status summary. It does not replace the product
and engineering baseline in `docs/HANDOFF.md`, or any Accepted ADR.

## Current State

- Engineering Bootstrap / Phase 1: Complete
- Phase 2 — Core Backend Foundation: Complete
- Phase 3 — AI Foundation: Complete
- Phase 4 — AI Safety: Engineering scope complete
- Phase 5 — User Features: In progress; Phase 5A and Phase 5B complete; the
  bounded Phase 5C Incognito/Privacy engineering scope is complete, while the
  Consent lifecycle backend is implemented in the current delivery branch;
  overall Phase 5C remains incomplete pending the full Privacy action UI
- Phase 5B — Chat Product Experience: Product UI engineering complete
- Phase 6 — Admin and operations features: Not started

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

## Current Feature Status

- Phase 5A is merged into `develop` and its post-merge CI passed.
- Phase 5B is merged into `develop` and its post-merge quality and browser E2E CI passed.
- [PR #12](https://github.com/yuan672/mental-health-ai/pull/12) is the delivery
  record for the bounded Phase 5C batch: a session-bound public Incognito
  lifecycle, strict
  persistent/Incognito chat protocol, bounded in-process context, runtime cleanup,
  and a read-only Privacy/Consent overview. This does not mark all Phase 5C
  product-policy work complete.
- Mood, Profile, Knowledge Base, Admin/Reviewer features, and production enablement
  remain outside completed scope.

## Phase 5C Batch Scope and Open Consent Product Flow

The bounded Phase 5C batch covers Incognito create/chat/end/lost-state UX and a
sanitized, paginated view of current required Consent status and known Consent
history. Incognito ordinary text remains outside browser persistent storage and
ordinary Conversation, Message, and AI Turn tables. Necessary minimal Risk Event
and Audit records remain possible under ADR-014.

ADR-016 is Accepted as the target Consent lifecycle architecture. It narrowly
supersedes ADR-011's single-lifecycle/no-reaccept constraint and ADR-015's broad
all-user withdrawal cleanup rule; all other decisions in those ADRs remain
Accepted. The implementation change set containing this status update provides
the backend projection/decision ledger, environment-aware document registry,
operation replay, and single-process dependency-scoped dispatch/cancellation
coordination. The Privacy withdrawal/reaccept/new-version controls are not yet
implemented. Consent types, formal legal copy, production document approval,
retention, account deletion/export, backup deletion, and cross-instance
cancellation remain unresolved production matters.

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

None.

## Immediate Next Step

After the Consent lifecycle backend implementation passes final review and is
merged, deliver the user-facing Privacy withdrawal/reactivation/new-version flow.
Do not begin Phase 5D/5E or Phase 6 work from this status file alone.

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
