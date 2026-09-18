# 安徽个人免费公开网站：上线准备包

日期：2026-09-18。**状态：配置模板与待审文案已准备，不能据此公开上线。**

目标已确定：中国大陆成年人、个人运营、首发免费。域名、服务器、真实成年验证服务商、公开联系邮箱均尚未提供。

## 本次实际交付

- 新增 `APP_HOST`，可让 API 在同机反代后仅监听 `127.0.0.1`；保留旧默认值兼容开发环境。
- 单进程 systemd、同源 HTTPS Nginx、前后端独立环境模板；没有创建或部署服务器。
- [协议与隐私文案](../../docs/release/public-launch/policy-drafts.md)：按当前日记、图片、心情、聊天与第三方数据流起草，未发布、未写入 Registry。
- [注册与授权接入](../../docs/release/public-launch/registration-and-consent.md)、[生产删除方案](../../docs/release/public-launch/data-deletion.md)：列出确切工程变更、外部依赖与结束条件。

工作位于独立 `feature/public-launch-preparation` 分支，基线为 `6848779`。当前前端、日记及 0011–0014 迁移仍在另一个工作树的未提交改动中；本包已核对其接口，但没有复制或提交他人的改动。**此分支本身不是包含新前端的完整发布版本。** 集成时保留最新前端和迁移，不能拿本分支直接替换主工作树。

## 部署模板如何对上现有代码

| 项目     | 配置与限制                                                                                                     |
| -------- | -------------------------------------------------------------------------------------------------------------- |
| 拓扑     | Linux 一台主机、一个 API 进程、同源 Web，PostgreSQL 不向公网开放；未选择云厂商                                 |
| Runtime  | Node 24.x、pnpm 12.4.0，依仓库 packageManager；在 Linux 上安装构建原生依赖，不复制 Windows node_modules        |
| API 入口 | 工作目录 `apps/api`；`node dist/src/main.js`；没有虚构 `start:prod` 命令                                       |
| 同源路径 | 客户端使用 `/auth` 等绝对路径，`VITE_API_BASE_URL` 只填 HTTPS origin；不能拼 `/api/`                           |
| SSE      | 代理不缓冲、不缓存、不自动重试；180 秒超时覆盖当前 120 秒模型总期限                                            |
| 上传     | 12 MiB 代理上限给现有 10 MiB 图片上传预留 multipart 开销，API 更严格的校验仍有效                               |
| Cookie   | Production 使用 Secure、SameSite，保留浏览器原始 Origin/Referer；不能在代理伪造 Origin                         |
| 监听     | API 模板为 127.0.0.1:3001；Nginx 模板也只在 loopback 监听，尚未公开                                            |
| 日志     | 代理访问日志仅时间、状态、响应字节数；不记录 URI、query、IP、Cookie 或正文。默认抑制可能携带路径的原始错误日志 |
| 数据库   | 现有 docker-compose 是本地开发模板，不能照搬其公开端口；正式连接串、凭据、TLS 和加密存储由所选主机落实         |
| 健康检查 | `/health` 只是进程存活，不证明数据库、年龄验证或生产 AI 已就绪                                                 |

当前限流只看直连 socket，反代后的访客会共用网络桶。该模板不伪造“已支持真实访客 IP”，也不关闭保护。公开前需对 **仅信任同机反代、覆盖客户端伪造头、禁止绕过反代直连** 的具体拓扑做窄幅实现，细化 ADR-021；不能简单打开 `trust proxy=true`。

## 将来接入时的固定步骤

本节是待执行 runbook，本次未执行其中的构建、数据库迁移或服务启动。

1. 将最新前端和本包合到同一个经过审查的发布提交，记录 commit；核对完整 migration journal，不沿用旧“0010 是最新”的判断。
2. 选择大陆服务器、域名与证书。在服务器外部受限配置目录填 `api.env.example`，凭据不进 Git；`FREE_DAILY_AI_LIMIT`、Risk/Audit 期限按真实运营决定填写。不要复制开发 `.env`、测试数据库、synthetic seed。
3. 构建时单独提供 `web.env.example` 的公开 origin，执行 `pnpm install --frozen-lockfile`、`pnpm build`。构建机不得加载包含真实服务器密钥的开发 `.env`；Web 不获得后端密钥。
4. 仅在核对过的独立目标数据库上，使用受限 migration 身份执行 `pnpm db:migrate`；API 运行身份不使用 PostgreSQL 超级用户。版本发布不自动跑 seed 或 NF-04。
5. 确认 `/usr/bin/node` 等系统路径、服务用户、部署目录和证书路径；Nginx 配置放入 `http` context，以 `nginx -t` 检查后再安装。systemd 服务默认不自动重启，生产注销恢复契约落地前不能靠重启清空未知操作。
6. 内部验证只做一次必要检查：TLS/路由、注册是否正确拒绝未配置条件、Cookie/CSRF、SSE与合法图片大小。没有域名/主机时不伪造“通过”。真实 AI 仍需原有独立生产条件，不在此包解锁。

正式保留策略批准后，调度以下**已构建命令**，不用每次重新 build：

```sh
# cwd: /srv/mental-health-ai/current/apps/api
node dist/src/commands/purge-conversations.js
node dist/src/commands/purge-safety-data.js
```

调度器须加载同一受限运行环境、防止自身重叠、报告固定失败事件；计划时间和保留期未定，所以本包没有悄悄启用删除定时器。备份期限和恢复后注销处理须按[数据删除方案](../../docs/release/public-launch/data-deletion.md)落实，不恢复旧 NF-04 演练。

## 完成边界

| 范围         | 本次状态                                 | 仍缺的真实条件                                                              |
| ------------ | ---------------------------------------- | --------------------------------------------------------------------------- |
| 注册         | 已核对并形成最小接入方案                 | 真实成人验证服务商、接入协议及资格、正式文档；邮箱真实性/找回方式也尚未接通 |
| 正式隐私授权 | 候选正文与独立授权边界已起草             | 运营身份、联系邮箱、服务商事实、保留政策及文案审核，功能级授权实现          |
| 数据删除     | 现有完整删除图已核对，生产补齐方案已写明 | 持久注销状态/重启恢复设计批准及实现，正式保留/备份政策，前端入口            |
| 部署         | 模板与 loopback 监听配置已实现           | 域名、服务器、证书、数据库、可信反代限流、实际部署验证                      |

网站手续、模型服务商使用范围及拟人化规则适用性继续独立确认。`ADMIN_AUTH_ENABLED=false`、`ACCOUNT_DELETION_ENABLED=false`、`AI_CHAT_ENABLED=false`、`AI_KNOWLEDGE_ENABLED=false`、Production Safety Lock Enforced、`productionSafe=false` 均维持现状。不存在一个修改环境变量就能合法、安全公开运行的快捷步骤。

## 配置依据

- [Nginx proxy 模块](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)：缓冲、超时、上游重试。
- 本仓库 `apps/api/src/main.ts`、`apps/api/src/config/env.ts`、`apps/web/src/api/client.ts`、`apps/api/src/common/http/cookies.ts`。
- 日记与上传接口依据当前主工作树的 `apps/api/src/diary/diary.controller.ts`；集成时再次核对接口变动。

## 本次验证记录

- 仅运行 `environment.spec.ts`：24/24 通过，其中一个新增用例覆盖 loopback、默认兼容和非法 host。使用未监听地址上的合成连接串，没有数据库访问。
- 改动 TypeScript 文件 ESLint、Prettier、文档本地链接及 diff 检查通过。
- API 类型检查通过，使用临时配置将 workspace 包明确解析至本隔离分支。首次直接复用依赖时解析到了主工作树的新 Mood Schema，出现新旧类型混用；已修正检查路径，没有改动 Mood 或主工作树。未安装依赖、未重跑全仓库测试。
- Nginx/systemd 仅完成静态契约核对；当前没有 Linux 主机、域名或证书，未执行其运行验证，未部署、未迁移、未调用真实 Provider、未运行 NF-04。
