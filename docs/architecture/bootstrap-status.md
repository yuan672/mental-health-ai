# Engineering Bootstrap Status

## Implemented in first batch

- Monorepo directory structure
- pnpm workspace + Turborepo configuration
- React/Vite Web skeleton
- NestJS API skeleton
- `GET /health`
- unified API error classes and global exception filter
- Pino structured HTTP logging with sensitive header/secret redaction
- root `.env.example`
- Zod environment validation
- PostgreSQL Docker Compose definition
- Drizzle migration mechanism and migration directory
- ESLint / Prettier / TypeScript strict configuration
- Web/API unit-test foundations
- GitHub Actions CI definition
- baseline README and architecture/security/API docs
- ADR-001 through ADR-010

## Intentionally not implemented

These belong to later phases and must not be pulled into Bootstrap:

- Authentication implementation
- Age Verification implementation
- User/Conversation/Message domain tables
- AI provider implementation
- AI chat
- Risk Detection behavior
- Mood Tracking
- Admin/Human Review features
- Redis dependency
- payment/subscription/community/native-app features

## Environment limitation during this handoff

The execution sandbox has Node.js 22 installed, but the accepted runtime baseline is Node.js 24 LTS. It also has no Docker executable and cannot resolve the npm registry, so this sandbox cannot generate `pnpm-lock.yaml`, install dependencies, start PostgreSQL, or execute the real lint/typecheck/test/build pipeline.

The repository must generate and commit `pnpm-lock.yaml` in the first network-enabled Node.js 24 environment. After that, CI should change `pnpm install --no-frozen-lockfile` to `pnpm install --frozen-lockfile`.
