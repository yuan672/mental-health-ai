# Codex 接手文档 — Engineering Bootstrap

版本：Codex Handoff V1.0  
日期：2026-09-09  
当前阶段：**技术栈已确定 + Engineering Bootstrap 首批骨架已生成，尚未完成真实环境验收**

> 本文用于下一位 Codex/开发者继续当前工程工作。  
> **`docs/HANDOFF.md` 仍然是项目需求、Scope、安全、数据策略与工程规范的最高基线。**
> 本文只描述本轮工程决策与当前实现状态，不替代原 HANDOFF。

---

# 1. 接手后的第一件事

开始任何代码修改前，必须按以下顺序阅读：

1. `docs/HANDOFF.md`
2. `docs/architecture/adr/README.md`
3. `docs/architecture/adr/ADR-001` ～ `ADR-010`
4. `docs/architecture/bootstrap-status.md`
5. 根目录 `README.md`
6. 当前代码与 CI 配置

如果代码、本文或其他说明与 `docs/HANDOFF.md` 冲突：

**以 `docs/HANDOFF.md` 为准。**

如果某个已接受 ADR 需要改变：

- 不要静默改写原 ADR；
- 新建下一个编号 ADR；
- 说明 supersede / replace 的原因；
- 只有存在当前真实技术需求时才改变原决策。

---

# 2. 项目当前状态

项目仍处于：

**Engineering Bootstrap**

不要直接进入以下大规模业务实现：

- AI Chat
- Risk Detection 业务行为
- Mood Tracking
- Admin / Human Review
- 支付
- 会员订阅
- 企业客户
- 原生 App
- 微信小程序
- 医疗诊断
- 药物推荐
- 社交社区

当前目标是先把基础工程真正跑通并验收。

原 `docs/HANDOFF.md` 已保留在仓库中，禁止删除或用本文替换。

---

# 3. 已接受的技术栈

## 3.1 Frontend

**React 19 + Vite 8 + TypeScript**

当前版本以仓库 `apps/web/package.json` 为准。

选择原因：

- 前后端分离边界清晰；
- 当前 V1 是登录后的 Web 应用，不存在必须使用 SSR 的真实需求；
- 对单人全栈开发简单、稳定；
- 后续可独立扩展其他客户端，而不重写 API。

暂不使用：

- Next.js
- Vue / Nuxt

不要为了“技术更全”引入 Next.js server runtime。

---

## 3.2 Backend

**NestJS 11 + Node.js 24 LTS + TypeScript**

当前使用 Nest 默认 **Express adapter**。

选择原因：

- Module / DI / Guard / Filter 很适合 Modular Monolith；
- 统一异常、安全模块、Auth、AI Adapter、Audit 等边界更容易保持一致；
- 比直接 Fastify 更少自建架构约定。

暂不切换：

- Fastify adapter
- FastAPI
- Spring Boot

除非出现真实、测量过的技术需求。

---

## 3.3 Database / ORM

**PostgreSQL + Drizzle ORM / Drizzle Kit + `pg`**

规则：

- DB column / table：`snake_case`
- TypeScript：`camelCase` / `PascalCase`
- 所有 Schema 修改必须通过 Migration
- 正常工作流不得依赖 `drizzle-kit push`
- Migration SQL 必须生成、审查、提交

当前 Phase 1 有 Migration 机制，但**还没有业务表**。

这是有意设计：

```ts
// database/src/schema.ts
// Phase 1 intentionally contains no product-domain tables.
export {};
```

Phase 2 才开始 User/Auth/Conversation 等领域 Schema。

---

## 3.4 Monorepo

**pnpm workspace + Turborepo**

根目录主要命令：

```bash
pnpm dev
pnpm dev:web
pnpm dev:api
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm format:check
pnpm db:generate
pnpm db:migrate
```

不要引入 Nx，除非未来出现明确需要。

不要为了“模块化”把 API 拆成微服务。

---

## 3.5 Authentication Strategy

已接受方向：

**Server-side opaque session + HttpOnly Secure Cookie**

Authentication 实现属于 **Phase 2**，当前尚未实现。

暂不采用 JWT access/refresh token 作为 Web V1 的默认 Auth 方案。

未来原生 App / 第三方客户端出现真实需求时，再通过 ADR 评估 Token / OAuth / OIDC。

---

## 3.6 LLM Provider Architecture

已接受：

业务层只能依赖应用自有接口：

```text
LLMProvider
├── chat()
├── streamChat()
├── classifyRisk()
├── embed()
└── healthCheck()
```

后续可实现：

- `SiliconFlowProvider`
- `OpenAICompatibleProvider`
- `LocalModelProvider`

当前 **没有实现 Provider**，这是正确状态。

禁止：

```text
ConversationService
    ↓
直接调用 SiliconFlow SDK/API
```

Risk Detection 必须保持独立模块，不能因为 Provider 有 `classifyRisk()` 就把安全逻辑吞进 Provider。

---

## 3.7 Logging

**Pino Structured JSON**

当前已经建立：

- request ID
- structured application logging
- Authorization / Cookie / Set-Cookie 等 redaction
- password / token / apiKey 等字段 redaction

核心原则：

**普通 Application Log 不记录用户完整心理聊天正文。**

后续必须继续区分概念上的：

- Application Log
- Security Log
- Audit Log
- AI Operational Log

当前没有持久化 AuditLog 表，因为那属于后续阶段。

---

## 3.8 Testing

当前接受：

- API：Jest + Nest Testing + Supertest
- Web：Vitest + React Testing Library
- Browser E2E：后续有 P0 用户流程后再引入 Playwright
- AI Safety：Phase 4 建独立 table-driven safety cases

不要为了统一工具而强行把 Web/API 全换成同一个 Test Runner。

---

## 3.9 Environment Configuration

**Environment Variables + Zod fail-fast validation**

仓库只允许提交：

```text
.env.example
```

禁止提交：

```text
.env
.env.local
.env.production
API Key
Database Password
Session Secret
Production Credentials
```

至少区分：

- Development
- Staging
- Production

三者不得共享：

- Database
- Secrets
- API Key
- Logs

`VITE_*` 是公开前端配置，绝不能放后端 Secret。

---

## 3.10 Docker / Local Development

当前策略：

- Web：宿主机直接运行
- API：宿主机直接运行
- PostgreSQL：Docker Compose
- Redis：第一阶段不依赖

不要为了“更像生产”把整个开发环境全部容器化。

Redis 只有在 Session、Rate Limit、Queue、Temporary Context 等出现真实需求时才加入。

---

# 4. 当前项目结构

当前 Bootstrap 采用：

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
│   ├── seeds/
│   └── src/
├── docs/
│   ├── requirements/
│   ├── architecture/
│   │   └── adr/
│   ├── api/
│   ├── ai/
│   └── security/
├── scripts/
├── .github/
│   └── workflows/
├── .env.example
├── docker-compose.yml
├── pnpm-workspace.yaml
├── turbo.json
├── package.json
└── README.md
```

---

# 5. 已经生成的 Bootstrap 能力

首批工程骨架已经包含：

- Monorepo 配置
- React/Vite Web skeleton
- NestJS API skeleton
- `GET /health`
- Unified App Error classes
- Global Exception Filter
- 统一 API Error Response
- Pino Structured Logging
- 敏感 Header / Secret redaction
- `.env.example`
- Zod API 环境变量校验
- PostgreSQL Docker Compose
- Drizzle Migration mechanism
- ESLint
- Prettier
- TypeScript strict
- API unit/integration test skeleton
- Web unit/component test skeleton
- GitHub Actions CI
- Architecture ADR-001 ～ ADR-010
- API / AI / Security 基础文档
- `zh-CN` locale 预留

当前 `/health` 是：

```http
GET /health
```

其职责目前仅为 API process/liveness 基础检查。

不要把它误认为已经包含：

- Database readiness
- Redis health
- LLM Provider health

这些可以在未来需要时扩展为 `/health/live` / `/health/ready`。

---

# 6. 当前最重要的未完成项

## 6.1 `pnpm-lock.yaml` 尚未生成

上一执行环境：

- Node.js 版本不符合最终 Node 24 基线；
- 无 Docker executable；
- 无法访问 npm registry。

因此首批骨架生成后，**没有真实执行完整依赖安装与质量门禁**。

这意味着：

> “代码已生成” ≠ “Bootstrap 已验收通过”。

Codex 接手后必须首先在可联网、Node 24、pnpm 12、Docker 可用的环境中完成真实验证。

---

## 6.2 CI 暂时使用 `--no-frozen-lockfile`

当前：

```yaml
pnpm install --no-frozen-lockfile
```

这是临时 Bootstrap 状态。

生成并提交 `pnpm-lock.yaml` 后，必须改为：

```yaml
pnpm install --frozen-lockfile
```

并重新运行 CI。

---

## 6.3 PostgreSQL 尚未真实启动验收

`docker-compose.yml` 已存在，但上一环境无法运行 Docker。

必须真实验证：

```bash
docker compose up -d
docker compose ps
```

PostgreSQL healthcheck 必须成功。

---

## 6.4 质量门禁尚未真实执行

必须真实运行：

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

禁止通过以下方式“让它通过”：

- 删除测试
- 放宽 TypeScript
- 关闭 ESLint Rule
- `any` 大面积绕过
- catch 后吞异常
- 删除安全校验

发现问题就修根因。

---

# 7. Codex 接手后的立即执行顺序

严格按以下顺序工作。

## Step 1 — Git / Working Tree 检查

先检查：

```bash
git status
git branch --show-current
git remote -v
```

如果项目还没有 Git Repository：

```bash
git init
```

目标分支模型：

```text
main
└── develop
    └── feature/*
```

第一批 Bootstrap 推荐工作分支：

```text
feature/engineering-bootstrap
```

不要直接在 `main` 上日常开发。

---

## Step 2 — Runtime 检查

确认：

```bash
node --version
pnpm --version
docker --version
docker compose version
```

目标：

- Node.js 24.x
- pnpm 12.x
- Docker + Compose 可运行

不要在验证阶段顺便升级整个技术栈 major version。

---

## Step 3 — 安装依赖并生成 Lockfile

```bash
pnpm install
```

确认生成：

```text
pnpm-lock.yaml
```

然后将 CI 改成：

```text
pnpm install --frozen-lockfile
```

---

## Step 4 — 第一轮静态质量门禁

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

如果失败：

1. 找到根因；
2. 修代码/配置；
3. 重新运行对应检查；
4. 最后再跑完整门禁。

---

## Step 5 — Local PostgreSQL

```bash
cp .env.example .env
```

只填写本地开发值，不要使用真实 Production Secret。

然后：

```bash
docker compose up -d
docker compose ps
```

确认 PostgreSQL healthy。

---

## Step 6 — Migration Mechanism 验证

当前 Phase 1 无业务表，因此不要为了测试 Migration 随便创建 User 表。

只验证：

- Drizzle config 能读取 `DATABASE_URL`
- `db:generate` / `db:migrate` 的工作流没有配置错误
- migrations 目录符合预期

领域 Schema 留给 Phase 2。

---

## Step 7 — 启动 API

```bash
pnpm dev:api
```

确认：

```http
GET http://localhost:3001/health
```

返回成功，并且普通日志中：

- 不出现 Secret
- 不出现 Authorization/Cookie
- 不出现 request body

---

## Step 8 — 启动 Web

```bash
pnpm dev:web
```

确认：

```text
http://localhost:5173
```

能够正常启动和构建。

---

## Step 9 — Bootstrap 验收

必须最终完整通过：

```text
Clone / Checkout
↓
pnpm install
↓
.env 配置
↓
docker compose up
↓
PostgreSQL healthy
↓
Web 可启动
↓
API 可启动
↓
GET /health 成功
↓
format:check
↓
lint
↓
typecheck
↓
test
↓
build
```

只有全部真实成功后，才能将 Engineering Bootstrap 标记为完成。

---

# 8. Bootstrap 完成后才能进入 Phase 2

Phase 2 按原 HANDOFF：

- User
- Authentication
- AgeVerification abstraction
- Consent
- UsageQuota
- Conversation
- Message
- Database Migration

其中：

**Age Verification 第一版允许 Mock Provider。**

不要为了练习直接保存真实身份证信息。

---

# 9. Phase 2 开始前的建议动作

Bootstrap 验收完成后：

1. 更新 `docs/architecture/bootstrap-status.md`
2. README 中写入真实可运行命令
3. 确认 CI green
4. 将 Bootstrap PR 合并到 `develop`
5. 再创建新的 Feature Branch，例如：

```text
feature/core-backend-foundation
```

6. 再开始 User/Auth/AgeVerification 等模块

不要在 Bootstrap branch 顺手实现 AI Chat。

---

# 10. 安全红线

后续任何阶段都必须继续遵守：

## 心理聊天日志

禁止默认：

```text
user message = "完整心理聊天内容..."
```

写入普通 Application Log。

使用 metadata，例如：

```json
{
  "event": "risk_detected",
  "userId": "...",
  "conversationId": "...",
  "riskLevel": "critical"
}
```

---

## API Error

统一格式：

```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "用户可理解的错误信息"
  }
}
```

禁止向客户端泄露：

- Stack Trace
- SQL Error
- API Key
- Server File Path
- Internal Credentials

---

## AI Safety

不能：

- 诊断精神疾病
- 开药
- 推荐药物剂量
- 建议自行停药
- 冒充心理医生
- 冒充真人咨询师
- 保证治疗结果

Risk Detection：

```text
LOW
MEDIUM
HIGH
CRITICAL
```

必须作为独立模块建设。

不能只依赖 System Prompt。

---

## Data Minimization

普通聊天后续默认：

**90 天过期**

Risk Event 与普通聊天数据分离。

无痕聊天的普通聊天内容不能进入长期记录。

不要因为“以后可能用”就多保存敏感数据。

---

# 11. Git / Commit 要求

分支：

```text
main
└── develop
    └── feature/*
```

Commit prefix：

```text
feat:
fix:
docs:
refactor:
test:
chore:
security:
```

Bootstrap 后续修复推荐：

```text
chore: finalize engineering bootstrap
```

如果只修 CI / lockfile：

```text
chore: lock workspace dependencies and harden ci
```

如果发现 Bootstrap bug：

```text
fix: correct bootstrap configuration
```

不要使用：

```text
update
test
123
修改一下
```

---

# 12. 当前明确不要做的事情

Codex 接手后不要：

- 重写项目 Scope
- 把 Modular Monolith 改成 Microservices
- 直接开发完整 AI Chat
- 直接实现 Admin
- 增加 Redis 只是为了“以后可能用”
- 引入 Kafka / RabbitMQ
- 引入 Kubernetes
- 引入复杂 Event Bus
- 引入支付
- 引入订阅
- 实现真人日常咨询
- 实现企业后台
- 实现微信小程序
- 实现原生 App
- 实现疾病诊断
- 实现药物推荐
- 保存真实身份证信息
- 把完整聊天写进 Application Log
- 把业务代码直接绑定 SiliconFlow
- 手工修改 Production DB Schema
- 为了测试通过而删除安全检查

---

# 13. 当前验收状态

| 项目                       | 状态                |
| -------------------------- | ------------------- |
| 原 HANDOFF 基线            | ✅ 已保留           |
| ADR-001 ～ ADR-010         | ✅ 已接受并生成     |
| Monorepo skeleton          | ✅ 已生成           |
| Web skeleton               | ✅ 已生成           |
| API skeleton               | ✅ 已生成           |
| `/health`                  | ✅ 已实现           |
| Unified Errors             | ✅ 已实现           |
| Structured Logging         | ✅ 已实现           |
| `.env.example`             | ✅ 已实现           |
| Env Validation             | ✅ 已实现           |
| PostgreSQL Compose         | ✅ 已生成           |
| Migration mechanism        | ✅ 已生成           |
| Test foundations           | ✅ 已生成           |
| CI definition              | ✅ 已生成           |
| `pnpm-lock.yaml`           | ❌ 尚未生成         |
| 真实 Dependency Install    | ❌ 尚未验证         |
| Docker PostgreSQL startup  | ❌ 尚未验证         |
| lint                       | ❌ 尚未真实运行     |
| typecheck                  | ❌ 尚未真实运行     |
| test                       | ❌ 尚未真实运行     |
| build                      | ❌ 尚未真实运行     |
| Web runtime                | ❌ 尚未真实运行     |
| API runtime                | ❌ 尚未真实运行     |
| `/health` runtime request  | ❌ 尚未真实验证     |
| Engineering Bootstrap 完成 | ❌ **尚未完成验收** |

---

# 14. Codex 的当前任务定义

下一位 Codex 的任务不是“继续做更多功能”。

当前唯一优先目标：

> **把已经生成的 Engineering Bootstrap 在真实开发环境中跑通、修正、验证，并完成验收。**

完成标准：

```text
pnpm-lock.yaml committed
+
docker compose PostgreSQL healthy
+
Web starts
+
API starts
+
GET /health succeeds
+
format check passes
+
lint passes
+
typecheck passes
+
tests pass
+
build passes
+
CI uses frozen lockfile and passes
```

这些完成后：

**停止 Bootstrap，汇报结果。**

再进入 Phase 2 前，应先总结：

- 实际修改了什么
- 哪些命令验证通过
- 是否产生新 ADR
- 是否发现 HANDOFF 与代码冲突
- 是否存在未解决风险
- 推荐的下一 Feature Branch

---

# 15. 推荐给 Codex 的开场指令

可以直接把下面这段交给 Codex：

```text
请先完整阅读 docs/HANDOFF.md，并将其作为项目需求、Scope、安全、数据和工程规范的最高基线。

然后阅读：
- docs/CODEX_HANDOFF.md
- docs/architecture/bootstrap-status.md
- docs/architecture/adr/ 下全部 Accepted ADR
- README.md

当前仍处于 Engineering Bootstrap，不要开始 AI Chat、Mood Tracking、Admin 等业务开发。

请先检查当前 Git/Runtime/依赖状态，在 Node 24 + pnpm 12 + Docker 可用环境里：

1. pnpm install，生成并提交 pnpm-lock.yaml
2. 将 CI 改为 frozen lockfile
3. 运行 format:check / lint / typecheck / test / build
4. 启动 PostgreSQL 并验证 healthy
5. 验证 Drizzle Migration 配置
6. 启动 API 并真实请求 GET /health
7. 启动 Web
8. 修复 Bootstrap 中发现的真实问题
9. 再运行完整质量门禁
10. 更新 bootstrap-status.md 和必要 README

不要为了让测试通过而删除测试、放宽类型检查或绕过安全规则。
不要改变已接受 ADR；如果必须改变，新增 ADR supersede 原决策。
不要扩大 V1 Scope。
完成后先汇报 Bootstrap 验收结果，再讨论 Phase 2。
```
