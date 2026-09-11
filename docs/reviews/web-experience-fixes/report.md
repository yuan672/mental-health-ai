# 独立 Web 体验修复

本次仅处理 Phase 5C 体验审计中四项已证实问题。基准为已合并 develop
`38264ea8bb90869cd5897e843c661188121a19cb`，使用已有独立 worktree 和
`feature/web-experience-audit-fixes`。最终 HEAD、Draft PR 和 CI 结果以 PR 描述及本任务交付报告为准；保持未合并。

## 修复与回归边界

1. Privacy 通过成功加载标记区分首次失败、已有数据刷新失败和成功空结果。
   首次失败只显示中文错误和重试；旧状态只有在确有成功数据时显示。
   原权威状态检查、未知操作、原 operationId 核对、409 刷新、迟到响应保护均保留。
2. 注册密码使用 Web 内单一校验函数，对齐现有 API 的 12–128 字符及四类中至少三类规则，
   包括 Unicode 数字和符号定义。API schema 为服务端模块，因此不导入 Web bundle，也不修改共享类型。
   字段错误关联帮助文字、设置 aria-invalid 并聚焦密码；保留其余输入。
   服务端失败使用通用中文说明，不暴露账号存在性或内部信息，也不推断为密码失败。
3. 注册条款的文字、链接与版本归为同一网格单元，允许自然换行。
   聊天标题与操作允许分行，按钮标签保持可读，去除会与滚动条叠加的全局最小宽度。
   未使用 overflow-x:hidden 裁切内容。
4. SessionProvider 仅在 React 内存保存 expired / signed-out 原因，登录页分别说明。
   提醒登录后核对可能正在提交的操作，不声称全部失败、未保存或取消。
   保留原正文、draft、用户缓存清理和 safeReturnTo；不会自动发送或重放操作。

## 实际浏览器核验

使用专属 Web 15173、API 13011、合成 Provider 14011、PostgreSQL 15439。
数据库为 phase5c_audit_01a08eaa_test，容器为 phase5c-audit-01a08eaa-postgres。
全部账号、正文、模型响应均为本任务合成数据。

| 页面             | innerWidth | clientWidth | scrollWidth | 结论                                      |
| ---------------- | ---------: | ----------: | ----------: | ----------------------------------------- |
| 注册（错误后）   |        320 |         305 |         305 | 自然换行，无横向溢出；15px 为纵向滚动条   |
| 注册             |        390 |         390 |         390 | 无横向溢出                                |
| 注册（服务错误） |       1440 |        1425 |        1425 | 无横向溢出；15px 为纵向滚动条             |
| 聊天历史         |        320 |         320 |         320 | 保留/删除标签横排，删除对话框可打开和取消 |
| 聊天历史         |        390 |         390 |         390 | 操作可见，无横向溢出                      |
| 聊天历史         |       1440 |        1440 |        1440 | 桌面布局正常                              |

320px 历史页两个按钮实测约 83×44px、54×44px。
注册类别不足时密码获得焦点，aria-invalid=true；修正为有效密码后，年龄验证 Provider
失败显示通用错误，改为有效合成凭证后注册成功。
在专属数据库撤销合成账号 Session 后，通过页面请求收到真实 401；登录页显示被动失效说明。
登录另一合成账号正确返回 /app/privacy，再进入新对话，没有原正文、草稿或历史缓存。
主动退出显示独立提示。

Privacy 在本任务 API 停止时首次进入，只有加载错误和重试；启动后重试恢复权威数据。
已有数据时，在 API 停止后提交合成撤回进入未知结果保护；新操作禁用。
放弃核对并刷新失败后显示旧状态警示，恢复 API 并重试后才允许新操作。
成功空结果、409 刷新失败及精确 operationId 重试由自动化回归覆盖，不伪称浏览器真实空账号场景。

## 前后截图

| 问题             | 修复前（原审计）                                | 修复后                                                                                                                                                                                                    |
| ---------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Privacy 首次失败 | [前](screenshots/19-privacy-load-error.png)     | [后](screenshots/11-privacy-first-failure.png)、[重试成功](screenshots/12-privacy-retry-success.png)                                                                                                      |
| 注册错误与条款   | [前](screenshots/17-register-generic-error.png) | [字段错误390px](screenshots/01-register-error-390.png)、[非密码错误](screenshots/02-register-server-error-390.png)、[320px](screenshots/03-register-320.png)、[桌面](screenshots/04-register-desktop.png) |
| 聊天历史布局     | [前](screenshots/12-mobile-320-history.png)     | [320px](screenshots/05-history-320.png)、[390px](screenshots/06-history-390.png)、[桌面](screenshots/07-history-desktop.png)                                                                              |
| Session 原因     | [前](screenshots/16-session-expired-login.png)  | [被动失效](screenshots/08-session-expired.png)、[跨用户清理](screenshots/09-cross-user-clean.png)、[主动退出](screenshots/10-session-signed-out.png)                                                      |

补充：[未知结果保护](screenshots/13-privacy-unknown-protection.png)、
[刷新失败旧状态](screenshots/14-privacy-stale-refresh-failure.png)、
[恢复](screenshots/15-privacy-stale-recovered.png)。

## 验证与限制

- 新增 Privacy 状态分支、密码字段错误与规则边界、被动失效与主动退出回归。
- 完整 Web 单元测试 16 文件、92 项通过（单 worker）。
- 新增浏览器回归实际测量 320/390/1440px，并点击历史操作验证可达性。
- 仓库 lint、typecheck、build 全部 18 项通过（串行、禁用缓存复用）。
- 仓库全量测试、格式检查及最终 HEAD required CI 的最终结果记录在 PR 描述及外部交付报告。
- 浏览器实测限当前 Chromium；密码规则未来若由 API 调整，需要同步 Web 函数。
- 内存中的 Session 原因不会跨整页刷新保存；无凭证冷启动仍是普通登录入口。
- 原审计第五项保留期限说明不在本批范围；没有开展 Mood/Profile Web、Phase 5E 或 Phase 6。
- 无 API、Schema、Migration、共享类型、锁文件或 PROJECT_CONTROL_HANDOFF.md 修改。

- Production Safety Lock: Enforced
- Production AI Chat: Disabled
- productionSafe=false
- Real Model Safety Evaluation: Not Evaluated
