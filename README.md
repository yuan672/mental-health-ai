# 心理健康 AI 支持系统

面向中国大陆 18 岁及以上成年用户的 Web AI 心理健康支持系统工程项目。当前阶段是 **技术栈确定 + Engineering Bootstrap**，尚未进入大规模 AI Chat、Mood Tracking 或 Admin 业务开发。

> 本产品定位为心理健康支持工具，不是心理医生、精神科医生、医疗诊断系统、药物处方系统或真人心理咨询师的替代品。

## Architecture

- Modular Monolith
- Web: React + Vite + TypeScript
- API: NestJS + TypeScript
- Database: PostgreSQL + Drizzle ORM/Kit
- Monorepo: pnpm workspace + Turborepo
- Logging: Pino structured JSON
- Configuration: environment variables + Zod validation
- Local infrastructure: Docker Compose for PostgreSQL

See `docs/architecture/adr/` for decision records. `docs/HANDOFF.md` remains the project baseline.

## Requirements

- Node.js 24 LTS
- pnpm 12
- Docker with Docker Compose
- Git

## Installation

```bash
git clone <repository>
cd mental-health-ai
pnpm install --frozen-lockfile
cp .env.example .env
```

Edit `.env` and replace local placeholder values. Never commit `.env`.

## Run Database

```bash
docker compose up -d
docker compose ps
```

## Run Development

Run Web and API together:

```bash
pnpm dev
```

Or separately:

```bash
pnpm dev:web
pnpm dev:api
```

Default local endpoints:

- Web: `http://localhost:5173`
- API: `http://localhost:3001`
- API health: `http://localhost:3001/health`

## Environment Setup

At minimum, configure:

- `APP_ENV`
- `APP_PORT`
- `WEB_ORIGIN`
- `VITE_API_BASE_URL`
- `DATABASE_URL`
- `LOG_LEVEL`
- local PostgreSQL variables used by Docker Compose

Development, Staging and Production must use separate databases, credentials, secrets and logs.

`VITE_*` variables are public frontend configuration. Never place API keys, database credentials or authentication secrets behind a `VITE_` prefix.

## Database Migrations

Schema changes must use migrations.

```bash
pnpm db:generate
# review generated SQL in database/migrations
pnpm db:migrate
```

Do not treat direct Production schema edits or `drizzle-kit push` as the normal migration workflow.

## Quality Commands

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Pull requests are expected to pass these checks before merge.

The Engineering Bootstrap was verified locally on 2026-09-09 with Node.js 24,
pnpm 12 and Docker Desktop. The CI workflow uses the same frozen lockfile and
quality commands.

## Git Workflow

```text
main
└── develop
    └── feature/*
```

Use meaningful commit prefixes:

- `feat:`
- `fix:`
- `docs:`
- `refactor:`
- `test:`
- `chore:`
- `security:`

Do not use meaningless messages such as `update`, `123` or `修改一下`.

## Directory Structure

```text
mental-health-ai/
├── apps/
│   ├── web/
│   └── api/
├── packages/
│   ├── shared/
│   ├── config/
│   └── types/
├── database/
│   ├── migrations/
│   └── seeds/
├── docs/
│   ├── requirements/
│   ├── architecture/
│   ├── api/
│   ├── ai/
│   └── security/
├── scripts/
├── .github/
│   └── workflows/
├── .env.example
├── docker-compose.yml
└── README.md
```

## Deployment

No production hosting platform has been selected yet. Do not create complex deployment infrastructure before that decision.

Staging and Production must use independent secrets, databases and logs. Production releases should map to a Git commit and semantic Git tag.

## Current Scope Boundary

Bootstrap does **not** implement payment, subscriptions, ordinary human counseling, enterprise features, native apps, WeChat mini-programs, medical diagnosis, medication recommendations or social/community features.
