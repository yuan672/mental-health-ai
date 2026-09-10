# Project Control Handoff

This file is a concise operational status summary. It does not replace the product
and engineering baseline in `docs/HANDOFF.md`, or any Accepted ADR.

## Current State

- Engineering Bootstrap / Phase 1: Complete
- Phase 2 — Core Backend Foundation: Complete
- Phase 3 — AI Foundation: Complete
- Phase 4 — AI Safety: Engineering scope complete
- Phase 5 — User Features: In progress; Phase 5A Conversation Access API complete
- Phase 5B — Chat Product Experience: Not started
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

## Current Feature Status

- Phase 5A is merged into `develop` and its post-merge CI passed.
- Phase 5B has not started implementation.
- Chat UI, public Incognito lifecycle, Mood, Profile, Privacy UI, Knowledge Base,
  Admin/Reviewer features, and production enablement remain outside completed scope.

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

Begin Phase 5B with architecture and product design review only when explicitly
authorized. Do not begin Phase 5B implementation or Phase 5C/5D/5E work from this
status file alone.

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
