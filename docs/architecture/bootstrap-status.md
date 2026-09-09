# Engineering Bootstrap Status

- Local validation: Passed
- GitHub Actions hosted CI: Passed
- Engineering Bootstrap: Complete
- Verified: 2026-09-09
- Branch: `feature/engineering-bootstrap`
- Pull request: [#1](https://github.com/yuan672/mental-health-ai/pull/1)
- Hosted CI run: [34316440526](https://github.com/yuan672/mental-health-ai/actions/runs/34316440526)

## Verified environment

- Node.js 24.14.1
- pnpm 12.4.0
- Docker 29.5.3
- Docker Compose 5.1.4
- PostgreSQL 18.6 Alpine

## Acceptance results

| Check                                  | Result                                                       |
| -------------------------------------- | ------------------------------------------------------------ |
| Workspace dependency installation      | Passed                                                       |
| `pnpm-lock.yaml` generated             | Passed                                                       |
| Frozen lockfile installation           | Passed                                                       |
| PostgreSQL startup and healthcheck     | Passed (`healthy`)                                           |
| Drizzle schema generation              | Passed; empty Phase 1 schema generated no business migration |
| Drizzle migration execution            | Passed; migration registry initialized                       |
| API development startup                | Passed                                                       |
| `GET /health` real HTTP request        | Passed (`200`)                                               |
| Structured request logging             | Passed                                                       |
| Authorization/Cookie redaction         | Passed with marker values                                    |
| Request body excluded from normal logs | Passed                                                       |
| Web development startup                | Passed                                                       |
| Web real HTTP request                  | Passed (`200`)                                               |
| `pnpm format:check`                    | Passed                                                       |
| `pnpm lint`                            | Passed                                                       |
| `pnpm typecheck`                       | Passed                                                       |
| `pnpm test`                            | Passed                                                       |
| `pnpm build`                           | Passed                                                       |
| CI frozen lockfile configuration       | Passed                                                       |
| Hosted GitHub Actions run              | Passed                                                       |

The CI steps passed locally and in the GitHub-hosted `quality` job. The hosted
run verified frozen lockfile installation, formatting, linting, type checking,
unit tests and all workspace builds.

## Bootstrap fixes

- Replaced the unavailable `@eslint/js` version with the published compatible
  ESLint 10 release.
- Added pnpm 12 build-script allowlisting for NestJS and esbuild.
- Added the missing Vite client type declaration to the Web TypeScript project.
- Corrected API TypeScript module interoperability for the Jest/Supertest test.
- Updated the PostgreSQL 18 volume target to `/var/lib/postgresql`.
- Switched GitHub Actions dependency installation to `--frozen-lockfile`.

## Implemented foundation

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
