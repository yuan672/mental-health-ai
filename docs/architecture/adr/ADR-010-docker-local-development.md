# ADR-010: Docker and Local Development Strategy

- Status: Accepted
- Date: 2026-09-09

## Context

The handoff recommends running application code directly in development while infrastructure services use Docker Compose. Redis is optional in Phase 1.

## Decision

Run **Web and API directly on the host** with pnpm development scripts. Use **Docker Compose for PostgreSQL 18** only in Phase 1.

Do not make Redis a required dependency yet.

Local target:

1. copy `.env.example` to `.env` and configure local values;
2. `docker compose up -d`;
3. install dependencies;
4. run Web/API development processes;
5. run health/test/lint/build commands.

## Why this fits

- Preserves fast HMR/debugger workflows.
- Containers normalize the database without containerizing every code edit.
- PostgreSQL is the only infrastructure dependency the current scope definitely needs.
- Avoiding Redis until a real rate-limit/session/queue requirement appears keeps the system simpler.

## Alternatives

### Containerize Web/API in development

Closer to production packaging.

**Not selected now:** slower feedback loop and more Docker complexity for a single developer, without deployment requirements yet.

### Add Redis immediately

Could support sessions, rate limits and queues.

**Not selected now:** the handoff explicitly says it may be deferred. PostgreSQL-backed sessions and in-process bootstrap logic are enough until Phase 2/3 requirements prove otherwise.

## Future impact

Redis can be added to Compose when a concrete feature requires it. Production container images/deployment manifests should be decided after the hosting target is selected, not guessed during Bootstrap.
