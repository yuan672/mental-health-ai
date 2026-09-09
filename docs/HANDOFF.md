# 心理健康 AI 支持系统

## Codex 项目接手文档

版本：Handoff V1.0  
项目状态：需求探索基本完成，准备进入 Scope 固化与工程初始化阶段  
项目性质：全栈开发练习项目，架构预留未来商业化能力

---

# 1. 项目简介

项目名称暂定：

**心理健康 AI 支持系统**

产品定位：

> 面向中国大陆成年用户的 AI 心理健康支持 Web 应用，通过支持性对话、情绪记录、心理健康知识和风险识别，为用户提供日常心理支持。

本产品不是：

- 心理医生
- 精神科医生
- 医疗诊断系统
- 心理疾病自动诊断工具
- 药物处方系统
- 真人心理咨询师的替代品

核心目标：

帮助成年用户进行：

- 情绪表达
- 情绪梳理
- 压力管理
- 心理健康知识获取
- 心情记录
- 日常支持性 AI 对话
- 必要时进入风险识别和人工干预流程

---

# 2. 当前已经确认的核心需求

## 2.1 上线地区

首发地区：

**中国大陆**

系统设计、隐私、安全、危机支持、部署和后续商业化均优先围绕中国大陆场景设计。

## 2.2 用户年龄

V1 仅服务：

**18 岁及以上成年人**

未成年人不允许注册和使用 V1。

年龄验证不能只依赖普通勾选框。

系统应预留独立的：

`Age Verification Service`

业务系统原则上只保存：

- `age_verified = true / false`
- `verification_method`
- `verified_at`

尽量不保存不必要的真实身份信息。

---

# 3. 用户身份设计

V1 支持：

- 注册账户
- 匿名/化名使用
- 不要求用户展示真实姓名
- 必须完成 18+ 年龄验证

V1 不支持：

**完全免注册游客模式**

原因：系统需要稳定的用户 ID 来实现年龄验证、每日 AI 使用额度、聊天记录、风险事件、数据删除与安全审计。

---

# 4. 首发平台

V1 首发：

**Web 网页端**

要求：

- Desktop Browser
- Mobile Browser
- Responsive Design

工程原则：

**前后端分离**

后端能力通过 API 提供。

未来应可以扩展 Web、Mobile App、微信小程序和其他客户端，而无需重写核心后端业务。

---

# 5. 商业模式

当前项目主要用于：

**全栈软件开发练习**

V1：

- 不收费
- 不做支付
- 不做会员订阅
- 不做订单
- 不做退款

采用：

**免费试用 + 每日额度限制**

额度不得硬编码进业务逻辑。

建议抽象：

```text
QuotaService
├── getDailyLimit(user)
├── getUsage(user)
├── canUseAI(user)
└── consumeQuota(user)
```

未来需要支持 Free / Pro / Enterprise / Custom Plan。

---

# 6. AI 模型

V1 使用：

**第三方大模型 API**

可以使用硅基流动等中国大陆可用的模型 API 服务。

禁止业务代码直接依赖单一模型供应商。

必须建立 Provider 抽象层：

```text
LLMProvider
├── chat()
├── streamChat()
├── classifyRisk()
├── embed()
└── healthCheck()
```

可能实现：

- `SiliconFlowProvider`
- `OpenAICompatibleProvider`
- `LocalModelProvider`

未来应能切换模型、增加备用 Provider 或私有部署，而不修改核心业务逻辑。

---

# 7. AI 对话核心流程

```text
User Message
     ↓
Input Validation
     ↓
Quota Check
     ↓
Risk Detection
     ↓
Conversation Context
     ↓
AI Orchestration
     ↓
LLM + Knowledge
     ↓
Output Safety Check
     ↓
Response
     ↓
User
```

禁止简单实现为 `User -> LLM API -> Response`。

安全逻辑不能只依赖 Prompt。

---

# 8. AI 行为要求

AI 可以：

- 倾听用户
- 帮助表达情绪
- 帮助梳理问题
- 提供压力管理方法
- 提供呼吸和放松练习
- 提供基础沟通建议
- 提供基础心理健康知识
- 建议用户寻求专业帮助

AI 不允许：

- 诊断心理疾病
- 宣称用户患有抑郁症、双相等疾病
- 开药
- 推荐具体药物剂量
- 建议自行停药
- 冒充心理医生
- 冒充真人咨询师
- 保证治疗效果
- 强行替用户作重大人生决定

---

# 9. Risk Detection

系统需要独立风险模块。

建议初步分级：

- `LOW`
- `MEDIUM`
- `HIGH`
- `CRITICAL`

处理逻辑：

## LOW

普通心理支持对话，不进入人工审核。

## MEDIUM

系统记录，AI 使用更谨慎的响应策略，允许后台抽样审核。

## HIGH

进入 `Human Review Queue`，需要人工审核。

## CRITICAL

例如：

- 明确轻生意图
- 明确自伤计划
- 已经实施自伤行为
- 明确伤害他人的严重意图
- 其他直接生命安全风险

必须进入 `Crisis Flow` 和 `Human Intervention Queue`。

---

# 10. 人工干预

V1 暂时不提供普通真人心理咨询服务，不做：

- 咨询师预约
- 真人聊天
- 视频咨询
- 咨询收费
- 咨询师排班

但从 V1 开始预留完整人工危机干预框架：

```text
Human Service
├── Crisis Intervention
├── Human Review Queue
├── Human Support Console
├── Emergency Contact
├── Audit Log
├── Counselor Management     Future
├── Appointment              Future
├── Scheduling               Future
├── Consultation             Future
└── Payment                  Future
```

所有人工访问用户敏感数据必须满足：

- 最小权限
- 明确角色
- 记录 Audit Log
- 普通管理员不得随意查看所有心理聊天内容

当前练习版本可以使用测试账号模拟人工干预人员。

不得宣称提供真实 24/7 专业危机服务。

---

# 11. 紧急联系人

架构应预留 `EmergencyContact`。

需要明确：

- 联系人的用途
- 用户授权
- 联系条件
- 访问权限
- 操作日志

具体实际干预策略后续细化。

---

# 12. AI 聊天记录保存策略

普通聊天默认保存：

**90 天**

用户可以：

- 删除单次对话
- 删除全部聊天
- 主动保留某次对话
- 使用无痕模式

普通记录建议字段：

- `created_at`
- `expires_at`
- `is_saved`
- `deleted_at`

系统必须实现自动 Data Lifecycle 清理机制，不能长期无限保存所有心理对话。

---

# 13. 无痕对话

V1 支持 Incognito / 无痕对话。

流程：

```text
Create Incognito Conversation
        ↓
Temporary Context
        ↓
AI Conversation
        ↓
Conversation Ends
        ↓
Clear Temporary Conversation Data
```

无痕模式下普通聊天内容不进入长期聊天记录。

以下信息不受普通聊天保存开关影响：

- 必要安全事件
- Risk Event
- Audit Log
- 系统必要日志
- 依法需要保存的数据

---

# 14. Mood Tracking

V1 支持基本心情记录。

建议字段：

- `mood_score`
- `emotion`
- `note`
- `created_at`

支持查看：

- 最近 7 天
- 最近 30 天

第一版不进行精神疾病预测。

心情记录原则上在账号存续期间保留，用户可以主动删除。

---

# 15. Risk Event 保存

Risk Event 与普通聊天记录分离。

建议原则上保存：

**180 天**

仅保存风险处理必要的信息。

示例：

```text
RiskEvent
├── id
├── user_id
├── message_id
├── risk_level
├── risk_category
├── detected_at
├── intervention_status
├── reviewer_id
└── resolved_at
```

不要为了安全审核而复制保存完整长期聊天记录。

---

# 16. 语言

V1：

**只支持简体中文**

前端从第一天预留 i18n，例如：

```text
locales/
└── zh-CN.json
```

未来可增加 `en-US.json`、`zh-TW.json`。

---

# 17. 心理健康知识库

V1 不建立真实医疗专业审核团队。

只能使用：

- 公开资料
- 权威资料
- 可追溯资料

每条知识内容必须保存来源。

建议：

```text
KnowledgeArticle
├── id
├── title
├── content
├── source_name
├── source_url
├── review_status
├── reviewed_by
├── reviewed_at
└── version
```

V1 可使用 `review_status = source_verified`。

未来可增加 `professional_reviewed`。

不得在 V1 宣称内容已经经过心理专家或临床医生专业审核，除非未来真实具备该能力。

---

# 18. B2B

V1 只面向个人用户。

不支持：

- 企业客户
- 学校
- 医院
- 机构
- 企业后台

未来可以增加：

- `Organization`
- `OrganizationMember`
- `OrganizationAdmin`
- `OrganizationPlan`

这些不进入 V1 Scope。

---

# 19. Git

使用：

**Git + GitHub**

建议 Monorepo。

分支：

```text
main
└── develop
    └── feature/*
```

原则：

- `main`：稳定、可发布代码
- `develop`：开发集成环境
- `feature/*`：实际功能开发

---

# 20. Git Commit 规范

建议：

- `feat:`
- `fix:`
- `docs:`
- `refactor:`
- `test:`
- `chore:`
- `security:`

禁止 `update`、`test`、`123`、`修改` 等无意义 Commit。

---

# 21. Git Tag

正式发布使用：

- `v0.1.0`
- `v0.2.0`
- `v0.5.0`
- `v1.0.0`

Production 版本必须能够对应 Git Commit + Git Tag。

---

# 22. CI/CD

使用：

**GitHub Actions**

第一阶段 CI：

```text
Pull Request
      ↓
Install
      ↓
Lint
      ↓
Type Check
      ↓
Unit Test
      ↓
Build
```

全部成功才允许合并。

Staging：

```text
develop
↓
GitHub Actions
↓
Build
↓
Deploy Staging
```

Production：

```text
main
↓
Git Tag / Release
↓
CI
↓
Manual Approval
↓
Deploy Production
```

第一版不要做复杂 DevOps。

---

# 23. 环境

至少分：

- Development
- Staging
- Production

三者必须拥有独立 Database、Environment Variables、Secrets、API Key 与 Logs。

禁止 Staging 和 Production 共用数据库。

---

# 24. 本地开发环境

建议本地代码直接运行，基础服务使用 Docker Compose，例如：

- PostgreSQL
- Redis（如需要）

Web 和 API 分别使用开发模式启动。

---

# 25. 数据库

推荐：

**PostgreSQL**

核心领域：

- User
- Conversation
- Message
- MoodLog
- RiskEvent
- Consent
- KnowledgeArticle
- AuditLog
- UsageQuota
- EmergencyContact

所有数据库变更必须使用 Migration。

禁止直接在 Production 手工修改数据库结构。

---

# 26. Redis

V1 可以预留 Redis。

可能用途：

- Rate Limit
- Quota Cache
- Temporary Conversation Context
- Session
- Distributed Lock
- Background Job
- Risk Queue

如果第一阶段暂时不需要，可以先不依赖。

---

# 27. Environment Variables

仓库中必须有 `.env.example`。

建议变量：

```text
APP_ENV=
APP_PORT=
DATABASE_URL=
JWT_SECRET=
LLM_PROVIDER=
LLM_API_KEY=
LLM_BASE_URL=
REDIS_URL=
LOG_LEVEL=
```

禁止提交：

- `.env`
- `.env.local`
- `.env.production`

API Key 只能存在于 Backend、Secret Manager、GitHub Secrets、Server Environment。

禁止出现在 Frontend、Git Repository、README、Client Bundle、Public Logs。

---

# 28. README

项目从第一天开始维护 README。

至少包含：

- Project Overview
- Architecture
- Requirements
- Prerequisites
- Installation
- Environment Setup
- Run Development
- Run Database
- Run Tests
- Build
- Git Workflow
- Directory Structure
- Environment Variables
- Deployment

目标：新开发者 Clone 仓库后可依赖 README 快速运行项目。

---

# 29. 推荐项目目录结构

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
├── .gitignore
├── .env.example
├── docker-compose.yml
├── README.md
└── LICENSE
```

技术栈确定后允许进一步调整。

---

# 30. Logging

必须使用 Structured Logging。

禁止默认把用户完整心理聊天内容写入普通 Application Log。

推荐结构化元数据：

```json
{
  "event": "risk_detected",
  "userId": "internal-id",
  "conversationId": "internal-id",
  "riskLevel": "critical"
}
```

至少区分：

- Application Log
- Security Log
- Audit Log
- AI Operational Log

---

# 31. Audit Log

人工访问敏感数据必须记录：

- `actor_id`
- `action`
- `resource_type`
- `resource_id`
- `timestamp`
- `metadata`

重要行为包括：

- 查看 Risk Event
- 修改 Risk 状态
- 查看敏感聊天
- 导出数据
- 删除数据
- 修改管理员权限

---

# 32. 异常处理

必须建立统一异常体系。

建议：

```text
AppError
├── ValidationError
├── AuthenticationError
├── AuthorizationError
├── NotFoundError
├── ConflictError
├── RateLimitError
├── QuotaExceededError
├── AIProviderError
├── DatabaseError
└── InternalServerError
```

统一 API 错误响应：

```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "用户可理解的错误信息"
  }
}
```

禁止向前端泄露 Stack Trace、SQL Error、API Key、Server File Path、Internal Credentials。

---

# 33. HTTP 错误约定

建议：

- `400 VALIDATION_ERROR`
- `401 UNAUTHENTICATED`
- `403 FORBIDDEN`
- `404 NOT_FOUND`
- `409 CONFLICT`
- `429 RATE_LIMITED / QUOTA_EXCEEDED`
- `500 INTERNAL_ERROR`
- `503 AI_PROVIDER_UNAVAILABLE`

前端根据 Error Code，而不是字符串 Message 判断业务状态。

---

# 34. 代码规范

如果采用 TypeScript 技术栈，至少使用：

- TypeScript Strict Mode
- ESLint
- Prettier

命名：

Database 使用 `snake_case`。

TypeScript 使用 `camelCase` / `PascalCase`。

---

# 35. Security 基础要求

至少包括：

- HTTPS
- Password Hash
- Authentication
- Authorization
- Role Based Access
- Rate Limit
- Input Validation
- Output Validation
- Secret Management
- SQL Injection Protection
- XSS Protection
- CSRF Strategy
- Secure Cookies / Token Strategy
- Data Encryption
- Audit Logging

心理健康敏感数据必须采用最小权限原则。

---

# 36. Database Backup

Production PostgreSQL 未来必须有：

- Automatic Backup
- Retention Policy
- Restore Procedure
- Restore Test

必须验证备份能够恢复。

---

# 37. Health Check

API 至少提供：

`GET /health`

未来可以扩展：

- `GET /health/live`
- `GET /health/ready`

检查：

- API
- Database
- Redis
- LLM Provider

---

# 38. 当前建议的 V1 核心 P0 闭环

**P0-01 AI 心理支持核心对话闭环**

```text
注册
↓
登录
↓
18+ 年龄验证
↓
产品与隐私说明
↓
创建 Conversation
↓
每日额度检查
↓
输入用户消息
↓
Risk Detection
↓
AI Response
↓
Output Safety
↓
保存 / 无痕处理
↓
返回用户
```

只要这个闭环还没有完整跑通，就不能认为核心 MVP 已完成。

---

# 39. 暂时明确 Out of Scope

V1 暂不做：

- 未成年人服务
- 完全游客模式
- 真人日常心理咨询
- 真人咨询预约
- 真人咨询收费
- 支付系统
- 会员订阅
- 视频咨询
- 精神疾病诊断
- 药物推荐
- 医疗处方
- 企业客户
- 学校客户
- 医院系统集成
- 用户社交社区
- 用户之间聊天
- Apple Health
- 智能穿戴设备
- AI 语音电话
- 多人咨询
- 原生 iOS App
- 原生 Android App
- 微信小程序

---

# 40. Codex 接手后的第一阶段任务

不要直接开始大量业务开发。

优先完成 Engineering Bootstrap：

1. 初始化 Git Repository
2. 创建 Monorepo
3. 创建 `apps/web`
4. 创建 `apps/api`
5. 创建 `packages/shared`
6. 创建 `docs`
7. 配置 `.gitignore`
8. 创建 `.env.example`
9. 创建 README
10. 配置 Formatter / Linter
11. 配置 Type Check
12. 配置 GitHub Actions CI
13. 配置 Docker Compose
14. 启动 PostgreSQL
15. 创建 `/health`
16. 建立统一 Error Handling
17. 建立 Structured Logging

完成标准：

```text
Clone Repo
↓
Install Dependencies
↓
Docker Compose Up
↓
Run Web
↓
Run API
↓
API Health Check
↓
Lint
↓
Test
↓
Build
```

全部可以正常执行。

---

# 41. Phase 2 — Core Backend Foundation

完成：

- User
- Authentication
- AgeVerification abstraction
- Consent
- UsageQuota
- Conversation
- Message
- Database Migration

暂时可以使用 Mock Age Verification Provider。

不要为了练习项目直接保存真实身份证信息。

---

# 42. Phase 3 — AI Foundation

完成：

- LLMProvider Interface
- SiliconFlowProvider
- Prompt Management
- Conversation Context
- Streaming Response
- Quota Check
- Basic AI Error Handling

---

# 43. Phase 4 — AI Safety

完成：

- RiskDetectionService
- RiskLevel
- RiskEvent
- CrisisFlow
- HumanReviewQueue
- AuditLog
- OutputSafetyCheck

需要准备测试 Case：

- 普通压力
- 焦虑
- 严重情绪低落
- 药物咨询
- 要求 AI 诊断疾病
- 自伤表达
- 明确轻生意图
- 明确计划
- 正在实施危险行为

---

# 44. Phase 5 — User Features

完成：

- Conversation History
- Delete Conversation
- Save Conversation
- Incognito Conversation
- Mood Check-in
- Mood History
- Knowledge Base
- Profile
- Privacy Settings

---

# 45. Phase 6 — Admin

完成：

- Admin Authentication
- Risk Event List
- Risk Event Detail
- Human Review Queue
- Knowledge Management
- Audit Log
- AI Quality Review

管理员权限与普通用户权限必须完全隔离。

---

# 46. 当前尚未最终确定的技术栈

以下技术还没有最终拍板。

Frontend 候选：

- React
- Next.js
- Vue
- Nuxt

Backend 候选：

- Node.js
- NestJS
- Fastify
- Python
- FastAPI
- Java
- Spring Boot

ORM 候选：

- Prisma
- Drizzle
- TypeORM
- SQLAlchemy
- 其他

Cache / Queue：

Redis 是否第一阶段直接使用，待 Scope 确定。

---

# 47. Codex 工作原则

1. 不因为是练习项目就牺牲基本工程规范。
2. 不过度工程化。
3. 当前优先 Monolith / Modular Monolith，不使用微服务。
4. 所有敏感 Key 只使用环境变量。
5. 每个重要功能通过独立 Feature Branch 开发。
6. 数据库 Schema 修改必须通过 Migration。
7. AI Provider 必须抽象。
8. Risk Detection 不得只依赖普通 Prompt。
9. 用户心理聊天内容不得默认写入 Application Log。
10. 所有人工敏感数据访问进入 Audit Log。
11. 所有异常使用统一 Error Code。
12. 所有关键模块需要测试。
13. 保持 README 与实际启动方式同步。
14. 新增功能前优先确认是否属于 V1 Scope。
15. 避免为了未来假设提前建设复杂微服务。

---

# 48. 推荐下一步

Codex 接手后首先完成：

**技术栈选型 + 工程 Bootstrap。**

在技术栈确定之前，不应直接开发完整 AI Chat 页面或业务模块。

下一阶段需要输出 ADR：

- ADR-001 Frontend Framework
- ADR-002 Backend Framework
- ADR-003 Database / ORM
- ADR-004 Authentication Strategy
- ADR-005 Monorepo Tool
- ADR-006 LLM Provider Architecture
- ADR-007 Logging Strategy
- ADR-008 Testing Strategy

完成这些 ADR 后，再开始正式工程初始化。

---

# 49. 当前项目一句话定义

> 构建一个面向中国大陆 18 岁以上成年用户的 Web AI 心理健康支持系统，以安全的 AI 对话为核心，支持情绪记录、聊天隐私、风险识别和人工危机干预扩展，并采用规范的全栈工程架构，为未来商业化和多端扩展保留能力。
