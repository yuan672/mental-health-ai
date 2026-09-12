# 心理健康 AI 支持系统

面向中国大陆 18 岁及以上成年用户的 Web AI 心理健康支持系统工程项目。Engineering Bootstrap、Phase 2、Phase 3、**Phase 4 — AI Safety**、Phase 5A–5D，以及 Phase 5E 已授权的内容基础、独立阅读器和 Knowledge AI-A 后端批次已完成相应工程范围；Phase 5E 的替换前端 AI-B 接入和正式内容发布仍未完成。Phase 6 已交付 Staff 身份/权限、Safety Review、Knowledge Management、Audit Read 和 Persistent AI Turn metadata 的有限后端批次，但 Admin UI 与整体 Phase 6 仍未完成。Production Safety Lock 仍然生效，生产 AI Chat 仍然禁用，`productionSafe=false`。

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

See `docs/architecture/adr/` for decision records. `docs/HANDOFF.md` remains the
project baseline. Current backend consumers should start with
`docs/backend-integration-handoff.md`; current delivery status is in
`docs/PROJECT_CONTROL_HANDOFF.md`.

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
- `WEB_ORIGINS`（逗号分隔的可信 Web Origin allowlist）
- `ADMIN_AUTH_ENABLED`（默认 `false`；当前 Admin HTTP 只允许 Development/Test）
- `ADMIN_WEB_ORIGINS`（与普通 Web Origin 分离的可信 Admin Origin allowlist）
- `STAFF_SESSION_TTL_SECONDS`
- `VITE_API_BASE_URL`
- `DATABASE_URL`
- `TEST_DATABASE_URL`（必须使用以 `_test` 结尾的独立测试数据库）
- `SESSION_TTL_SECONDS`（Phase 2A 固定为 `604800`）
- `AGE_VERIFICATION_PROVIDER`（`mock` 仅允许 Development/Test）
- `REQUIRED_TERMS_VERSION`
- `REQUIRED_PRIVACY_VERSION`
- `FREE_DAILY_AI_LIMIT`（必填正整数；示例值由本地/测试决定，不代表产品政策）
- `QUOTA_TIME_ZONE`（当前使用 `Asia/Shanghai`）
- `AI_CHAT_ENABLED`（Staging/Production 在 production-readiness 条件未全部满足时 fail closed）
- `AI_KNOWLEDGE_ENABLED`（默认 `false`）
- `AI_KNOWLEDGE_SYNTHETIC_FIXTURES_ENABLED`（仅 Development/Test）
- `LLM_PROVIDER`（`none` 或 `siliconflow`）
- `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL`（只允许后端配置）
- `LLM_FIRST_TOKEN_TIMEOUT_MS` / `LLM_STREAM_IDLE_TIMEOUT_MS` / `LLM_TOTAL_TIMEOUT_MS`
- `LLM_LEASE_SAFETY_MARGIN_MS`
- `LLM_MAX_OUTPUT_TOKENS` / `LLM_CONTEXT_TOKEN_BUDGET`
- `AI_CONTEXT_MAX_MESSAGES` / `AI_MESSAGE_MAX_CHARACTERS`
- `AI_SEGMENT_MAX_CHARACTERS` / `AI_SEGMENT_MAX_WAIT_MS`
- `INCOGNITO_CONTEXT_TTL_SECONDS`
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

## Conversation Retention Cleanup

Phase 2B provides a bounded, idempotent cleanup command:

```bash
pnpm data:purge-conversations
```

It physically removes expired conversations and short-lived deleted-conversation
metadata. User-initiated deletion removes message content immediately before this
cleanup runs. A deployment scheduler is intentionally not included yet; automatic
scheduling is mandatory before production chat launch.

Phase 4 adds a separate bounded cleanup command for expired Risk Events and audit
records:

```bash
pnpm data:purge-safety
```

Risk Event and audit retention are independent. This command is not a production
scheduler; automatic scheduling remains required before production AI launch.

## Quality Commands

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
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

Phase 2A implements identity, password authentication, server-side sessions,
age-verification abstraction and consent records. Phase 2B adds internal PostgreSQL
quota, ordinary-conversation, message-ordering, ownership and retention primitives.

Phase 3 adds the provider abstraction, SiliconFlow adapter, AI-turn orchestration,
prompt/context services, true HTTP streaming, quota compensation, internal
incognito runtime storage, and a minimal Web stream client. The public AI generation
surface remains limited to `POST /ai/chat/stream`.

Phase 5A adds authenticated, owner-scoped ordinary Conversation history/detail,
Message history, Save/Delete/Delete-All, Quota, and public Capability reads. It does
not expose direct message writes, an empty-conversation create route, or a public
Incognito lifecycle. Phase 5B adds the routed Web product shell, session-aware Chat
UI, safe registration availability contract, history actions, streaming lifecycle,
responsive accessibility baseline, and isolated synthetic Chromium P0 tests. See
`docs/api/conversation-access.md` and `docs/web/chat-product-experience.md`.

Phase 4 adds hybrid risk detection, deterministic Crisis Flow, isolated Risk Event
retention, an internal Human Review Queue boundary, restricted Audit Log, and
fail-closed output safety. It does not add Reviewer/Admin UI, real-time human
takeover, Mood Tracking, Knowledge Base, Redis, queues, payment, subscriptions,
enterprise features, native apps, WeChat mini-programs, medical diagnosis,
medication recommendations, or social/community features. AI chat remains locked
out of Staging/Production while verified crisis resources, reviewer identity,
real-model evaluation, and privacy/compliance prerequisites are incomplete.

Later accepted batches add the Consent decision ledger and scoped cancellation,
public Incognito lifecycle, Mood/Profile APIs, versioned Knowledge content and
reading, bounded local Knowledge grounding with negotiated v2 references, and a
separate least-privilege Staff backend. The Staff backend includes metadata-only
Safety Review and AI Turn inspection, Knowledge workflow, and an allowlisted Audit
reader; it does not include Admin UI or psychological-message access. Knowledge
grounding and Admin authentication remain disabled by default. See
`docs/backend-integration-handoff.md` for the authoritative integration index and
remaining client/production boundaries.
