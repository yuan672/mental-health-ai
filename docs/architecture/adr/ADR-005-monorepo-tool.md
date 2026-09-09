# ADR-005: Monorepo Tooling

- Status: Accepted
- Date: 2026-09-09

## Context
The repository contains Web, API, shared packages and database tooling. The goal is a Git-friendly monorepo without enterprise-scale build-system complexity.

## Decision
Use **pnpm workspaces** for dependency/workspace management and **Turborepo** for task orchestration and caching.

## Why this fits
- pnpm natively supports multi-package workspaces and a single workspace lockfile.
- `workspace:` dependencies make internal-package intent explicit.
- Turborepo gives one consistent `build/lint/typecheck/test` graph without forcing a heavier workspace framework.
- Both are straightforward for one developer and CI.

## Alternatives
### pnpm workspaces only
The simplest possible choice.

**Not selected now:** as Web/API/packages grow, task dependency ordering and CI caching become repetitive shell scripting. Turborepo adds a small, focused layer.

### Nx
Powerful project graph, generators and plugins.

**Not selected now:** its feature surface is larger than the current project needs and would add configuration/concepts before they provide value.

## Future impact
The workspace can add packages without changing repository shape. Avoid creating packages merely to simulate service boundaries; domain modules should remain inside the API until there is a concrete reuse/deployment reason.
