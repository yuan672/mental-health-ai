# Project Agent Instructions

These repository-wide rules are intentionally limited to durable working
agreements. Temporary phase, branch, pull-request, and commit details belong in
`docs/PROJECT_CONTROL_HANDOFF.md`, not here.

## Requirements and architecture

- Treat `docs/HANDOFF.md` as the highest product, scope, safety, data, and
  engineering baseline.
- Follow all Accepted ADRs. If a material decision must change, add a new ADR that
  explicitly supersedes the old decision; do not silently rewrite accepted history.
- Stop and report any material conflict between a request, the handoff baseline,
  and an Accepted ADR before implementing the conflicting change.

## Phase and scope control

- Complete design review before implementing a new project phase.
- Do not pull work from a later phase into the current phase for convenience.
- Treat phase completion and `productionSafe` as separate decisions.
- Do not describe engineering tests, fake/mock provider tests, or synthetic safety
  corpora as real-model evaluation, clinical validation, or a safety guarantee.

## Git and collaboration

- After authorization, the agent performs the required Git, test, CI, and pull
  request work; do not ask the user to run routine engineering commands.
- Use feature branches. Do not perform daily development directly on `main` or
  `develop`, force-push, or rewrite accepted history.
- Parallel writers must use separate worktrees and branches. Preserve existing
  user changes and never clean, reset, or stash another task's work without explicit
  authorization.
- Do not merge a feature pull request until its requested final review is complete,
  the latest head is verified, required CI is green, and merge authorization exists.

## Database and quality

- Make every schema change through a reviewed Drizzle migration. Do not use
  `drizzle-kit push` as the formal schema workflow.
- Validate migrations against a dedicated empty test database; never reset the
  development or production database to run tests.
- Preserve strict type checking, safety rules, and tests. Do not hide failures by
  removing tests, weakening assertions, disabling jobs, or using
  `continue-on-error`.
- Do not commit secrets or send real user psychological content to test providers.
