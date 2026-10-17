# 脚本与证据索引

本页回答两个问题：**哪个脚本会产生哪份证据**，以及**每个脚本运行时的副作用和授权要求**。
它补充 [`INDEX.md`](INDEX.md)（按证据文件分组），不替代它；规则本身在[文档 16](../16_验收与测试总表.md)。

覆盖检查由脚本执行，不靠人工声明：

```bash
cd /home/afrangry/kurumi-fusion
node scripts/fusion/evidence-coverage.mjs   # 每个证据文件必须命中恰好一个分类，否则非零退出
node scripts/fusion/evidence-index.mjs      # 每个脚本必须有分类行，否则非零退出
```

## 三类证据，含义不同

| 类别 | 位置 | 说明 |
| --- | --- | --- |
| 当前有效 | 最新 `recovery-*` 报告、`fusion/*`、`deepseek-whale/*`、`reminder-list-*/*`、项目副本同步记录 | 各自版本与范围的验收和状态证据；恢复结论以最新 recovery 报告和文档 16 为准 |
| 历史领域验收 | `migration/*`、`step6-2026-10-05/*`、顶层 `2026-*` 与 `*-acceptance.json` 等 | 旧阶段或旧频道的验收结论，只能按版本和范围追溯，不能证明当前版本 |
| 归档证据 | `../archive/verification/`、`../archive/personal-search-tests/`、`../archive/2026-*` | 已退役实现与失败实验；要复用须在新日期目录重新产生证据 |

命名约定：`*-initial`、`*-attempt`、`*-a/-b` 是**失败或首次尝试的原始记录**，`*-fixed`、`*-final` 是修正后的复验。
失败记录保留是审计要求，不代表当前缺陷仍在；反过来，`*-fixed` 也不代表之后版本仍然通过。

## 旧 harness 与当前融合测试的边界

- `chatbot/tests/acceptance/`（`run.mjs`、`run-model.mjs`、`model-driver.mjs`、`run-retrieval-*` 等）是**融合前**的离线验收 harness。
  它的系统提示词来自遗留的 [`chatbot/AGENTS.md`](../../chatbot/AGENTS.md)，测的是旧 NAICCC/`qqbot` 频道的检索与确认路径。
- `scripts/fusion/test-*.mjs` 与 `chatbot/tests/<领域>/acceptance-*.mjs` 是**当前融合系统**的验收脚本；按各脚本边界分别验证真实模型、隔离 Host、`kurumi-qq` 或原生定时投递。
- **旧 harness 的输出不能当作新频道的验收**。当前结论须引用当前融合脚本、领域测试与恢复探针，并分别说明模型、宿主和 QQ 是否真实；模拟入站不能证明真人 QQ 往返。
- 大量 `*-acceptance.json`、`retrieval-review-*.json` 与 `call-analysis.test.mjs` 的断言属于旧 harness 时代，读取时应连同 `2026-09-10_文档与现状复核.txt`、`2026-10-04_检索与QQ插件现状复核.md` 一起看。

## 固定输出路径与归档

部分验收脚本把结果写到**固定路径**（例如 `scripts/fusion/test-background-code.mjs` 写
`docs/verification/fusion/10-background-code.json`），重复运行会覆盖上次输出。因此：

- 需要保留某次真实外发回执时，**先复制到带日期的归档路径**（如 `verification/archive-<日期>/`）再重跑，
  不要依赖脚本自己保留历史。
- 脚本索引表中每行的“证据位置”就是它会写入或对应的文件；`—` 表示该脚本不直接产出 `docs/verification/` 文件。
- 需要人工修正过的历史回执（例如 `*-fixed`）不要被自动重跑覆盖；先归档再复验。
- 提醒列表 `acceptance-model.mjs` 与 `acceptance-host.mjs` 支持 `--out <目录>`；`--natural` 默认写 `reminder-list-2026-10-11/natural-input/`。其他验收脚本的独立输出改造仍属 Q3，重跑前按固定路径规则保留旧证据。
- 论文 `acceptance.mjs`、`acceptance-api.py`、`acceptance-host.mjs`、`acceptance-worker.mjs` 支持显式绝对 `--out` 并拒绝覆盖已有结果；整篇真实翻译可用 `--provider/--channel/--model/--effort` 选择已登记配置，未传仍为 GPT 默认。它们不因位于 tests 就成为离线测试。

## 分类依据与可信度

表格每行有「分类依据」，取值含义：

| 依据 | 含义 |
| --- | --- |
| `boundary` | 脚本自己在代码里写的机器可读边界声明（`boundary: "..."`） |
| `header` | 脚本顶部注释里明说的边界 |
| `code` | 读源码判定（无现成声明，例如库、fixture、探测脚本） |
| `offline` | 进程内单元测试，无外发、无真实模型 |

`evidence-index.mjs` 会把 `boundary` 声明与表格做**双向交叉校验**，任一方向不符都非零退出：

| 方向 | 例子（均为复验实证） |
| --- | --- |
| **多标**（声明没有、表里有） | `run.mjs` 声明“deterministic cognition … no QQ network or model provider”，却被标成真实模型 + QQ + 停服务；`verify-restart.mjs` 只是在新进程里重开测试目录，却被标成“重启服务” |
| **漏标**（声明有、表里没有） | `test-research.mjs` 声明 `Real model`，表里漏了真实模型；`test-domain-read.mjs` 声明 `real model and QWeather tools`，表里漏了外部 API；`test-qq-interaction.mjs` 声明 `real model`，表里漏了真实模型 |

**能力边界（不要据此认为副作用已被自动证明）**：自动校验只能比对脚本**自己写下的** `boundary` 声明；
没有声明、或声明本身写得不全的脚本，仍依赖 `header`/`code` 人工判读。实际脚本数量与各依据的分布以
`node scripts/fusion/evidence-index.mjs` 的本次输出为准，不用旧数量推断新增文件已经覆盖。

副作用词汇区分：真实模型、真实外部 API、真实 QQ 外发、建改任务、重启停服、写运行状态、
写仓库内文件、**写临时测试目录**、只读。

**库（`lib/`）的标注语义**：按“**被调用时做什么**”标注，而不是“导入时是否无副作用”。
例如 `working-tree-backup.mjs` 导入时无副作用，但 `captureWorkingTree` 会写补丁与 tar，因此标 `写运行状态` 而非只读。

## 需要授权的脚本

索引表中「需要授权」为“是”的脚本，运行前须取得用户明确同意，并在对应任务的验收记录中注明授权范围、执行结果与未覆盖范围（记录规则见[文档 16](../16_验收与测试总表.md#验收记录规则)）：真实 QQ 外发、创建或取消任务、重启服务、
写运行状态、恢复旧系统。授权与可离线执行的数量以生成器输出为准；库的分类说明被调用时的行为，不能据「库」分组认定可直接运行。

`testIngress` 保持 `false`：合成入站入口默认关闭，验收脚本需要时自行开启并在结束后用
`scripts/fusion/close-acceptance.mjs` 关闭，且**从不重置发送账本**。

## 索引表

<!-- 由 node scripts/fusion/evidence-index.mjs --markdown 生成；请勿手工编辑表格内容 -->

| 脚本 | 分组 | 用途 | 副作用 | 需要授权 | 分类依据 | 证据位置 |
| --- | --- | --- | --- | --- | --- | --- |
| `chatbot/packages/confirmation-core/src/confirmation.test.ts` | 离线 | 确认核心：提案校验、TTL、幂等与 grant 消费 | 只读 | 否 | offline | — |
| `chatbot/packages/confirmation-core/src/public-id.test.ts` | 离线 | 公开 ID 脱敏与冲突规避 | 只读 | 否 | offline | — |
| `chatbot/plugins/kurumi-mail/test/adapters.test.js` | 离线 | 邮件适配器：宿主入站路由到达被选中的 store、工具消费注入实现、替换策略不能授予身份、未知 id 明确失败 | 写临时测试目录、只读 | 否 | offline | — |
| `chatbot/plugins/kurumi-mail/test/gate.test.js` | 离线 | 邮件端到端负向核心：确认前 mock SMTP 收到 0 封；另含完整往返与失败路径 | 写临时测试目录、只读 | 否 | offline | — |
| `chatbot/plugins/kurumi-mail/test/mime.test.js` | 离线 | 邮件 MIME：RFC 2047 主题、RFC 2231 附件名、折行、注入防护、信封发件人 | 只读 | 否 | offline | — |
| `chatbot/plugins/kurumi-mail/test/policy.test.js` | 离线 | 邮件输入策略：单收件人字符串与 body 别名的真实失败回归、白名单、参数规整 | 只读 | 否 | offline | — |
| `chatbot/plugins/kurumi-mail/test/smtp.test.js` | 离线 | SMTP 协议：仅连本地 mock 服务器，覆盖认证失败、收件人拒绝、超时与 dot-stuffing | 写临时测试目录、只读 | 否 | offline | — |
| `chatbot/plugins/kurumi-mail/test/store.test.js` | 离线 | 邮件草稿与确认闸门：提案、授权、幂等、过期、跨会话与参数校验 | 写临时测试目录、只读 | 否 | offline | — |
| `chatbot/plugins/kurumi-mail/test/tool.test.js` | 离线 | 邮件工具层：以生产失败参数驱动真实注册工具，含非主人拒绝与凭据不泄露 | 写临时测试目录、只读 | 否 | offline | — |
| `chatbot/plugins/kurumi-memory/test/memory.test.js` | 离线 | 长期记忆读写、版本与损坏拒绝 | 只读 | 否 | offline | — |
| `chatbot/plugins/kurumi-qq/test/channel.test.js` | 离线 | QQ 频道分段、配额、账本与幂等 | 只读 | 否 | offline | — |
| `chatbot/plugins/kurumi-qq/test/presentation.test.js` | 离线 | QQ 呈现与分段节奏 | 只读 | 否 | offline | — |
| `chatbot/plugins/kurumi-qq/test/stickers.test.js` | 离线 | 表情目录与发送边界 | 只读 | 否 | offline | — |
| `chatbot/plugins/kurumi-research/test/papers.test.js` | 离线 | 论文来源校验与拒绝规则 | 只读 | 否 | offline | — |
| `chatbot/plugins/kurumi-tasks/test/git.test.js` | 离线 | 副本内受限 Git 提交范围 | 只读 | 否 | offline | — |
| `chatbot/plugins/kurumi-tasks/test/sandbox.test.js` | 离线 | Bubblewrap 隔离边界与进程树终止 | 只读 | 否 | offline | — |
| `chatbot/plugins/kurumi-tasks/test/task.test.js` | 离线 | 后台任务工具的所有权与绑定 | 只读 | 否 | offline | — |
| `chatbot/plugins/personal-confirmation/src/inbound.test.ts` | 离线 | 确认入站插件：身份绑定与重放拒绝 | 只读 | 否 | offline | — |
| `chatbot/plugins/personal-confirmation/src/index.test.ts` | 离线 | 确认入站插件装配与工具暴露 | 只读 | 否 | offline | — |
| `chatbot/plugins/personal-weather/src/clarification-gate.test.ts` | 离线 | 地点歧义澄清闸门 | 只读 | 否 | offline | — |
| `chatbot/plugins/personal-weather/src/config.test.ts` | 离线 | 插件配置解析与默认值 | 只读 | 否 | offline | — |
| `chatbot/plugins/personal-weather/src/confirmation-gate.test.ts` | 离线 | 领域确认闸门 | 只读 | 否 | offline | — |
| `chatbot/plugins/personal-weather/src/controlled-replies.test.ts` | 离线 | 受控回复与原文交付 | 只读 | 否 | offline | — |
| `chatbot/plugins/personal-weather/src/formatter.test.ts` | 离线 | 天气输出格式与地点保真 | 只读 | 否 | offline | — |
| `chatbot/plugins/personal-weather/src/index.test.ts` | 离线 | 天气插件工具注册与装配 | 只读 | 否 | offline | — |
| `chatbot/plugins/personal-weather/src/native-reminder-scheduler.test.ts` | 离线 | 原生提醒调度适配 | 只读 | 否 | offline | — |
| `chatbot/plugins/personal-weather/src/parsers.test.ts` | 离线 | 自然语言时间与地点解析 | 只读 | 否 | offline | — |
| `chatbot/plugins/personal-weather/src/planning.test.ts` | 离线 | 行程提案与事务提交 | 只读 | 否 | offline | — |
| `chatbot/plugins/personal-weather/src/profile.test.ts` | 离线 | Profile 当前所在地读写 | 只读 | 否 | offline | — |
| `chatbot/plugins/personal-weather/src/qweather-client.test.ts` | 离线 | QWeather 客户端请求构造与拒绝规则 | 只读 | 否 | offline | — |
| `chatbot/plugins/personal-weather/src/reminder-gateway.test.ts` | 离线 | 提醒与 Gateway 对账 | 只读 | 否 | offline | — |
| `chatbot/plugins/personal-weather/src/reminder-reconciler-service.test.ts` | 离线 | 提醒 reconciler 服务循环 | 只读 | 否 | offline | — |
| `chatbot/plugins/personal-weather/src/reminder-reconciler.test.ts` | 离线 | 提醒 reconciler 判定与退避 | 只读 | 否 | offline | — |
| `chatbot/plugins/personal-weather/src/reminders.test.ts` | 离线 | 提醒提案、修改与取消 | 只读 | 否 | offline | — |
| `chatbot/plugins/personal-weather/src/store.test.ts` | 离线 | 领域 SQLite 存储与迁移 | 只读 | 否 | offline | — |
| `chatbot/plugins/personal-weather/src/weather-location.test.ts` | 离线 | 天气地点解析与叶子名保留 | 只读 | 否 | offline | — |
| `chatbot/plugins/personal-weather/src/weather-service.test.ts` | 离线 | 天气服务聚合与失败语义 | 只读 | 否 | offline | — |
| `chatbot/tests/acceptance/call-analysis.test.mjs` | 离线 | 旧调用分析离线断言（读取两份输入样本） | 只读 | 否 | offline | `docs/verification/` |
| `chatbot/tests/backend-boundaries/confirmation.test.mjs` | 离线 | 确认公共接口、业务事务中消费/回滚、领域适配器生命周期和交互钩子组合 | 只读 | 否 | header | — |
| `chatbot/tests/backend-boundaries/domain.test.mjs` | 离线 | 领域分层：实际记忆工具准入、存储独立、列表事务与审计/重放回滚 | 写临时测试目录 | 否 | header | — |
| `chatbot/tests/domain-adapters/integration.test.mjs` | 离线 | 真实领域工具替换策略/存储；调度与固定 runner 一致、无静默回退 | 写临时测试目录 | 否 | header | — |
| `chatbot/tests/domain-adapters/registry.test.mjs` | 离线 | 领域适配器注册/注销、启动选择、同步契约和失败拒绝 | 只读 | 否 | header | — |
| `chatbot/tests/knowledgemap/bridge.test.mjs` | 离线 | 固定API客户端、可信请求、参数映射、共享播报与切换防旧写 | 写临时测试目录 | 否 | header | — |
| `chatbot/tests/knowledgemap/bills.test.mjs` | 离线 | 账单工具声明一致、真实钩子runId映射、当前请求隔离和消息幂等键 | 只读 | 否 | header | — |
| `chatbot/tests/knowledgemap/http.test.mjs` | 离线 | 真实本机HTTP与临时FastAPI/SQLite双入口集成，不访问生产 | 写临时测试目录 | 否 | header | — |
| `chatbot/tests/papers/concurrency_test.py` | 离线 | 网络四并发上限、乱序回执/不可变快照、预算、终态取消、共享冷却/频率与并发原子写入；注入HTTP/临时目录 | 写临时测试目录 | 否 | header | — |
| `chatbot/tests/papers/credentials.test.mjs` | 离线 | 厂商配置冲突、凭据隔离、原子导入/轮换与保留其它池；仅合成凭据 | 写临时测试目录 | 否 | header | — |
| `chatbot/tests/papers/documents.test.mjs` | 离线 | PDF 受管存储、实际解析、QQ 文件身份/来源/配额和防重复边界 | 写临时测试目录 | 否 | header | — |
| `chatbot/tests/papers/engine_test.py` | 离线 | 锁定排版引擎的探测、批次 JSON、公式/样式接口；独立 HOME/cache | 写临时测试目录 | 否 | header | — |
| `chatbot/tests/papers/jobs.test.mjs` | 离线 | 翻译配置、任务幂等/取消/重启与独立投递状态 | 写临时测试目录 | 否 | header | — |
| `chatbot/tests/papers/log-query.test.mjs` | 离线 | 论文事件接入只读统一查询与可信消息/任务关联 | 写临时测试目录 | 否 | header | — |
| `chatbot/tests/papers/mail.test.mjs` | 离线 | 受管附件快照、确认、完整性、大小限制及本地 TLS SMTP | 写临时测试目录 | 否 | header | — |
| `chatbot/tests/papers/responses_test.py` | 离线 | 原生 Responses、流式终态、用量/占位符、三凭据降级、有限重试和未知回执 | 写临时测试目录 | 否 | header | — |
| `chatbot/tests/papers/worker.test.mjs` | 离线 | 实际翻译进程文件系统隔离与恢复副本的付费/凭据关闭 | 写临时测试目录 | 否 | header | — |
| `chatbot/tests/reminder-list/intake.test.mjs` | 离线 | 自然录入授权、实际会话 UUID、超时/重置/换题与跨提醒领域拒绝 | 只读 | 否 | header | — |
| `chatbot/tests/reminder-list/log-query.test.mjs` | 离线 | 提醒列表审计接入日志查询，精确消息/slot 关联 | 写临时测试目录 | 否 | header | — |
| `chatbot/tests/reminder-list/plugin.test.mjs` | 离线 | 提醒列表 v2 工具、可信原文钩子和过期上下文拒绝 | 写临时测试目录 | 否 | header | — |
| `chatbot/tests/reminder-list/scheduler.test.mjs` | 离线 | 提醒列表原生 Cron 固定声明、对账、并发和失败重试 | 写临时测试目录 | 否 | header | — |
| `chatbot/tests/reminder-list/store.test.mjs` | 离线 | 提醒列表领域状态、时间、授权、幂等、防重与固定 runner | 写临时测试目录 | 否 | header | — |
| `scripts/fusion/fixtures/test_stats.py` | 离线 | 固定验收 fixture：后台代码任务的 mean/moving_average 断言 | 只读 | 否 | code | — |
| `scripts/fusion/test/log-query.test.mjs` | 离线 | 跨 SnowLuma/OpenClaw/提醒来源的链路事件适配、关联与脱敏 | 只读 | 否 | offline | — |
| `scripts/fusion/test/recovery.test.mjs` | 离线 | 备份/恢复工具单元与集成回归 | 只读 | 否 | offline | — |
| `scripts/fusion/test/register-project.test.mjs` | 离线 | 项目注册表维护 CLI 与共享保护根规则回归（含归档拒绝） | 只读 | 否 | offline | — |
| `chatbot/scripts/import-knowledgemap-list.mjs` | 迁移工具 | 默认预览旧列表导入；--apply写共享业务，--activate冻结旧项并启用runner切换标记 | 真实外部API、写运行状态 | 是 | header | — |
| `chatbot/scripts/backup-knowledgemap-code.mjs` | 领域运维 | 只读两个主工作树、bundle/index/工作树包保存到新私密备份目录；不含数据库/忽略文件 | 写运行状态 | 是 | header | — |
| `scripts/fusion/configure-deepseek-persona.mjs` | 迁移工具 | 一次性切到 DeepSeek+小鲸鱼；日常禁用作人格入口 | 真实模型、写运行状态 | 是 | header | — |
| `scripts/fusion/configure-domains.mjs` | 迁移工具 | 启用主人绑定领域插件 | 写运行状态 | 是 | header | — |
| `scripts/fusion/configure-fulltext-research.mjs` | 迁移工具 | 研究会话、笔记工作区与来源缓存 | 写运行状态 | 是 | header | — |
| `scripts/fusion/configure-interaction.mjs` | 迁移工具 | 复制表情目录并设定迁移/每日发送预算 | 写运行状态 | 是 | header | — |
| `scripts/fusion/configure-persona-memory.mjs` | 迁移工具 | 只导入稳定的主人字段进私有记忆 | 写运行状态 | 是 | header | — |
| `scripts/fusion/configure-production.mjs` | 迁移工具 | 关闭仅验收能力，保留历史；需先审阅活动任务 | 写运行状态 | 是 | header | `docs/verification/migration/33-production-config.json` |
| `scripts/fusion/configure-projects.mjs` | 迁移工具 | 一次性首次引导：只在 id 不存在时追加登记并写运行 openclaw.json | 写运行状态 | 是 | header | — |
| `scripts/fusion/configure-research.mjs` | 迁移工具 | 配置检索 provider 与抓取路径 | 写运行状态 | 是 | header | — |
| `scripts/fusion/configure-worker.mjs` | 迁移工具 | 显式配置隔离代码 worker | 写运行状态 | 是 | header | — |
| `scripts/fusion/prepare.mjs` | 迁移工具 | 首次引导隔离运行目录，拒绝覆盖已写内容 | 写运行状态 | 是 | header | — |
| `chatbot/scripts/import-paper-credentials.mjs` | 领域运维 | 显式导入指定 GPT/DeepSeek 凭据，原子合并到私密 0600 文件；不输出密钥 | 写运行状态 | 是 | header | — |
| `chatbot/scripts/setup-paper-translation.sh` | 领域运维 | 按锁文件安装隔离 Python 翻译环境并检查实际导入；不调模型或外发 | 真实外部API、写运行状态 | 是 | header | — |
| `chatbot/scripts/reminder-list.mjs` | 领域运行 | 固定提醒列表 Cron 程序：按切换来源查询、slot 防重和汇总输出，OpenClaw 投递本人 | 写运行状态 | 是 | header | — |
| `chatbot/tests/acceptance/call-analysis.mjs` | 库 | 旧验收调用观察工具（只观察，不证明写入） | 只读 | 否 | header | — |
| `chatbot/tests/acceptance/domain-fixture.mjs` | 库 | 旧验收领域夹具与工具定义 | 只读 | 否 | code | — |
| `chatbot/tests/acceptance/host-driver.mjs` | 库 | 旧 harness Host 驱动，只开测试状态目录 | 写临时测试目录、只读 | 否 | code | — |
| `chatbot/tests/acceptance/model-driver.mjs` | 库 | 旧 harness 模型驱动（构造模型客户端，读取遗留 AGENTS） | 真实模型 | 否 | code | — |
| `chatbot/tests/acceptance/retrieval-config.mjs` | 库 | 旧验收检索输出预算配置 | 只读 | 否 | header | — |
| `chatbot/tests/papers/fixtures.mjs` | 库 | 生成最小有效 PDF 测试字节，不读生产文件 | 只读 | 否 | header | — |
| `chatbot/tests/papers/mime-parse.py` | 库 | 标准 email 解析器检查完整 SMTP MIME 的正文/附件名/解码字节哈希；只处理测试 stdin | 只读 | 否 | header | — |
| `chatbot/tests/reminder-list/dialogue-cases.mjs` | 库 | 用户七句验收样例与字段期望（纯数据，无生产导入） | 只读 | 否 | header | — |
| `chatbot/tests/reminder-list/production-guard.mjs` | 库 | 只读比较生产列表与一次性提案/提醒逻辑数据，不输出私有记录 | 只读 | 否 | header | — |
| `scripts/fusion/lib/backup-service.mjs` | 库 | 备份期间停写并恢复服务 | 重启或停服务 | 否 | header | — |
| `scripts/fusion/lib/fresh-id.mjs` | 库 | 生成不重复的 message id | 只读 | 否 | header | — |
| `scripts/fusion/lib/legacy-source.mjs` | 库 | 解析旧 OpenClaw 源树路径（仅迁移脚本用） | 只读 | 否 | header | — |
| `scripts/fusion/lib/package-manifests.mjs` | 库 | 只读发现仓库自有锁文件包及构建声明，供依赖检查与隔离恢复共同使用 | 只读 | 否 | header | — |
| `scripts/fusion/lib/plugins.mjs` | 库 | 第三方插件声明（纯数据，导入无 I/O） | 只读 | 否 | header | — |
| `scripts/fusion/lib/recovery-isolation.mjs` | 库 | 隔离恢复的路径、凭据与共享业务禁用改写，仅写恢复副本 | 写临时测试目录 | 否 | header | — |
| `scripts/fusion/lib/trace-events.mjs` | 库 | 统一链路事件契约、脱敏与可选私有 JSONL sink（调用 emit 时写文件） | 写运行状态 | 否 | code | — |
| `scripts/fusion/lib/working-tree-backup.mjs` | 库 | 已跟踪修改的 Git 补丁归档；被 backup-state 调用时写 patches/ 与 untracked.tar | 写运行状态 | 否 | code | — |
| `scripts/fusion/rpc.mjs` | 库 | Gateway RPC 客户端库（被其他脚本导入） | 只读 | 否 | code | — |
| `chatbot/tests/acceptance/probe-profile-geo.py` | 遗留验收 | GeoAPI provider 探测 | 真实外部API、写仓库内文件 | 是 | code | `docs/verification/profile-geo-provider-probe.json` |
| `chatbot/tests/acceptance/run-fallback-failover.mjs` | 遗留验收 | 主模型指向必然失败地址、fallback 用真实 deepseek | 真实模型、写临时测试目录 | 是 | header | — |
| `chatbot/tests/acceptance/run-model.mjs` | 遗留验收 | 真实主模型 + 有界工具循环；合成 QQ 身份，无 QQ 传输 | 真实模型、写临时测试目录 | 是 | boundary | — |
| `chatbot/tests/acceptance/run-profile-geo.mjs` | 遗留验收 | 真实 GeoAPI + 隔离 Profile 库；无生产确认、无 QQ 投递 | 真实外部API、写临时测试目录 | 是 | header | `docs/verification/profile-geo-domain-acceptance.json` |
| `chatbot/tests/acceptance/run-real-cron.mjs` | 遗留验收 | 隔离 Gateway 的真实 Cron 存储与确认钩子；确定性认知，无模型、无 QQ 网络 | 建/改任务或提醒、写临时测试目录 | 是 | boundary | — |
| `chatbot/tests/acceptance/run-reminder-expiry.mjs` | 遗留验收 | 真实主模型有界循环 + 提醒提案工具 + 隔离库；非生产 Agent/QQ 验收 | 真实模型、建/改任务或提醒、写临时测试目录 | 是 | boundary | — |
| `chatbot/tests/acceptance/run-retrieval-host.mjs` | 遗留验收 | 全新 Host 状态 + 原生工具 + 真实 API；无 QQ 发送、不碰生产库 | 真实模型、真实外部API、写临时测试目录 | 是 | boundary | — |
| `chatbot/tests/acceptance/run-retrieval-smoke.mjs` | 遗留验收 | 检索注册冒烟：不启动 Gateway/频道，凭据为合成值 | 真实外部API、写临时测试目录 | 是 | header | — |
| `chatbot/tests/acceptance/run-retrieval-t2.mjs` | 遗留验收 | 真实 Tavily API（生产凭据）；无模型、无 Host、无 QQ 投递、不写生产库 | 真实外部API | 是 | boundary | — |
| `chatbot/tests/acceptance/run-retrieval-t3.mjs` | 遗留验收 | 真实模型 + 真实 Tavily + 真实 HTTP；无 Host、无 QQ 投递、不改生产配置 | 真实模型、真实外部API | 是 | boundary | — |
| `chatbot/tests/acceptance/run.mjs` | 遗留验收 | 旧 harness 总入口：真实 Host 调度 + 合成 QQ 输入 + 确定性认知 + 假调度 | 写仓库内文件、写临时测试目录 | 是 | boundary | — |
| `chatbot/tests/acceptance/verify-restart.mjs` | 遗留验收 | 在新进程里重开测试目录并验证幂等；不重启任何服务 | 写临时测试目录、只读 | 否 | header | — |
| `chatbot/tests/knowledgemap/acceptance-host.mjs` | 验收 | 真实模型与隔离OpenClaw/原生调度、临时HTTP业务库、模拟OneBot | 真实模型、重启或停服务、写仓库内文件、写临时测试目录 | 是 | header | — |
| `chatbot/tests/knowledgemap/acceptance-live.mjs` | 验收 | 真实模型/生产API/MySQL/网页与一次本人QQ播报；短暂测试入口、精确测试行清理并保留回执 | 真实模型、真实外部API、真实QQ外发、建/改任务或提醒、重启或停服务、写运行状态、写仓库内文件 | 是 | header | `docs/verification/knowledgemap-bridge-2026-10-17/live.json` |
| `chatbot/tests/knowledgemap/acceptance-bills-live.mjs` | 验收 | 第二轮真实模型/生产API/MySQL/网页单笔增改删查、歧义澄清及天气runId；合成入站不发QQ | 真实模型、真实外部API、重启或停服务、写运行状态、写仓库内文件 | 是 | header | `docs/verification/knowledgemap-bills-round2-2026-10-17/live.json` |
| `chatbot/tests/knowledgemap/acceptance-model.mjs` | 验收 | 真实模型、实际v2工具及临时HTTP/SQLite，无QQ/生产写入 | 真实模型、写仓库内文件、写临时测试目录 | 是 | header | — |
| `chatbot/tests/knowledgemap/recovery.mjs` | 验收 | 今晚Git工作树和SQLite备份的临时目录恢复，不启动旧服务 | 写临时测试目录 | 是 | header | — |
| `chatbot/tests/papers/acceptance-api.py` | 验收 | 合成短文逐个实测翻译渠道；读取私密凭据，仅向 --out 写结果，无 QQ/邮件外发 | 真实模型、真实外部API、写仓库内文件 | 是 | header | `docs/verification/paper-translation-2026-10-17/channel-upgrade/.` |
| `chatbot/tests/papers/acceptance-download.mjs` | 验收 | 真实公开论文 HTTP 下载与隔离 PDF 校验；私密验收目录 | 真实外部API、写运行状态、写仓库内文件 | 是 | boundary | `docs/verification/paper-translation-2026-10-17/.`<br>`docs/verification/paper-translation-2026-10-17/download.json` |
| `chatbot/tests/papers/acceptance-host.mjs` | 验收 | 真实 OpenClaw/主模型调用 PDF 工具，模拟翻译/OneBot；独立临时状态，无真实 QQ/邮件 | 真实模型、重启或停服务、写仓库内文件、写临时测试目录 | 是 | boundary | `docs/verification/paper-translation-2026-10-17/`<br>`docs/verification/paper-translation-2026-10-17/host.json` |
| `chatbot/tests/papers/acceptance-worker.mjs` | 验收 | 生产捕获的插件代码在真实隔离进程内导入固定 Python 与双厂商注册表，无模型/外发 | 写仓库内文件、写临时测试目录 | 否 | boundary | `docs/verification/paper-translation-2026-10-17/channel-upgrade/.` |
| `chatbot/tests/papers/acceptance.mjs` | 验收 | 真实指定 PDF 翻译；显式 --send-qq/--send-mail 才向本人实际投递，程序化确认不等于 QQ 确认 | 真实模型、真实外部API、真实QQ外发、写运行状态、写仓库内文件 | 是 | boundary | `docs/verification/paper-translation-2026-10-17/.` |
| `chatbot/tests/reminder-list/acceptance-host.mjs` | 验收 | 隔离 OpenClaw 与真实模型；--natural 同时开放两类提醒、真实会话重置；模拟 OneBot，无生产写入；--out 独立证据目录 | 真实模型、重启或停服务、写仓库内文件、写临时测试目录 | 是 | header | `docs/verification/reminder-list-2026-10-11`<br>`docs/verification/reminder-list-2026-10-11/host.json` |
| `chatbot/tests/reminder-list/acceptance-model.mjs` | 验收 | 真实 DeepSeek 调用列表工具；--ordinal 验证序号/排序变化/澄清，--natural 七句与连续录入；--out 独立证据目录 | 真实模型、写仓库内文件、写临时测试目录 | 是 | header | `docs/verification/reminder-list-2026-10-11`<br>`docs/verification/reminder-list-2026-10-11/model.json` |
| `chatbot/tests/reminder-list/acceptance-native.mjs` | 验收 | 真实原生 Cron 跨重启发本人一条汇总；待办在临时库、正常撤销测试任务 | 真实QQ外发、建/改任务或提醒、重启或停服务、写运行状态、写仓库内文件、写临时测试目录 | 是 | header | `docs/verification/reminder-list-2026-10-11`<br>`docs/verification/reminder-list-2026-10-11/native.json` |
| `scripts/fusion/test-background-code.mjs` | 验收 | 后台代码任务登记检查与终态 | 真实模型、真实QQ外发、建/改任务或提醒、写运行状态、写仓库内文件 | 是 | header | `docs/verification/fusion/10-background-code.json` |
| `scripts/fusion/test-domain-due.mjs` | 验收 | 提醒到点投递（跨重启） | 真实模型、真实QQ外发、建/改任务或提醒、写运行状态、写仓库内文件 | 是 | header | `docs/verification/migration/10-reminder-restart-delivery.json` |
| `scripts/fusion/test-domain-planning.mjs` | 验收 | 行程提案与确认写入（隔离库） | 真实模型、写运行状态、写仓库内文件 | 是 | header | `docs/verification/migration/11-planning-confirmation.json` |
| `scripts/fusion/test-domain-read.mjs` | 验收 | 领域只读自然语言验收：真实模型 + QWeather 工具；不发 QQ、不写偏好 | 真实模型、真实外部API、写仓库内文件 | 是 | boundary | `docs/verification/migration/06-domain-read.json` |
| `scripts/fusion/test-domain-reminder.mjs` | 验收 | 提醒 CRUD 与确认口令，回复本地捕获 | 真实模型、建/改任务或提醒、写运行状态、写仓库内文件 | 是 | header | `docs/verification/migration/09-reminder-crud.json` |
| `scripts/fusion/test-fulltext-research.mjs` | 验收 | 论文全文研究任务 | 真实模型、建/改任务或提醒、写运行状态、写仓库内文件 | 是 | code | `docs/verification/migration/26-fulltext-research.json` |
| `scripts/fusion/test-live-inbound.mjs` | 验收 | 合成入站 → 真实模型 → 本人 QQ 外发 | 真实模型、真实QQ外发、写运行状态、写仓库内文件 | 是 | header | `docs/verification/fusion/01-native-inbound.json` |
| `scripts/fusion/test-live-media.mjs` | 验收 | 合成图片入站与真实外发 | 真实模型、真实QQ外发、写运行状态、写仓库内文件 | 是 | header | `docs/verification/fusion/03-native-media.json` |
| `scripts/fusion/test-mail-delivery.mjs` | 验收 | 邮件真实投递：真实授权码与真实 SMTP；确认由脚本按宿主路由同一调用记录，不含 QQ 入站与到信确认 | 真实外部API、写运行状态 | 是 | boundary | — |
| `scripts/fusion/test-memory.mjs` | 验收 | 真实模型记忆 CRUD（合成事实） | 真实模型、写运行状态、写仓库内文件 | 是 | header | `docs/verification/migration/13-memory-model.json` |
| `scripts/fusion/test-native-concurrency.mjs` | 验收 | 两个原生会话并发；不发 QQ | 真实模型、写运行状态、写仓库内文件 | 是 | header | `docs/verification/fusion/05-native-concurrency.json` |
| `scripts/fusion/test-native-cron.mjs` | 验收 | 原生 Cron CRUD 与频道投递 | 真实QQ外发、建/改任务或提醒、重启或停服务、写仓库内文件 | 是 | header | `docs/verification/fusion/04-native-cron.json` |
| `scripts/fusion/test-profile-confirmation.mjs` | 验收 | Profile 变更确认后恢复原值 | 真实模型、写运行状态、写仓库内文件 | 是 | header | `docs/verification/migration/08-profile-confirmation.json` |
| `scripts/fusion/test-project-maintenance.mjs` | 验收 | 真实 QQ → 项目 worker → 隔离检查 → 本地提交 | 真实模型、真实QQ外发、建/改任务或提醒、写运行状态、写仓库内文件 | 是 | header | `docs/verification/migration/22-project-maintenance.json` |
| `scripts/fusion/test-project-scoped-commit.mjs` | 验收 | 提交范围只含指定文件 | 真实模型、真实QQ外发、建/改任务或提醒、写运行状态、写仓库内文件 | 是 | header | `docs/verification/migration/23-project-scoped-commit.json` |
| `scripts/fusion/test-qq-interaction.mjs` | 验收 | 合成主人 → 真实模型 → 仅本人 QQ 的分段与表情外发 | 真实模型、真实QQ外发、写运行状态、写仓库内文件 | 是 | boundary | `docs/verification/migration/15-qq-natural-sticker.json` |
| `scripts/fusion/test-recurring-weather.mjs` | 验收 | 周期天气 automations | 真实模型、真实QQ外发、建/改任务或提醒、写运行状态、写仓库内文件 | 是 | code | `docs/verification/migration/27-recurring-weather.json` |
| `scripts/fusion/test-reminder-delivery.mjs` | 验收 | 自然语言 → automations → 到点外发 | 真实模型、真实QQ外发、建/改任务或提醒、写运行状态、写仓库内文件 | 是 | header | `docs/verification/fusion/13-natural-reminder-delivery.json` |
| `scripts/fusion/test-reminder-tool.mjs` | 验收 | 提醒工具 CRUD（须先取消未来任务） | 真实模型、建/改任务或提醒、写运行状态、写仓库内文件 | 是 | header | `docs/verification/fusion/09-native-agent-reminder.json` |
| `scripts/fusion/test-research-cancel.mjs` | 验收 | 研究任务查询与取消 | 真实模型、建/改任务或提醒、写运行状态、写仓库内文件 | 是 | header | `docs/verification/migration/28-research-cancel.json` |
| `scripts/fusion/test-research.mjs` | 验收 | 公开论文检索：真实模型 + web_search/web_fetch；无 QQ 输出、无记忆写入 | 真实模型、真实外部API、写运行状态、写仓库内文件 | 是 | boundary | `docs/verification/fusion/15-research.json` |
| `scripts/fusion/test-service-recovery.mjs` | 验收 | 服务故障注入与恢复；不发 QQ、不调模型 | 重启或停服务、写运行状态、写仓库内文件 | 是 | header | `docs/verification/migration/35-service-recovery.json` |
| `scripts/fusion/test-task-control.mjs` | 验收 | 任务查询与取消 | 真实模型、建/改任务或提醒、写运行状态、写仓库内文件 | 是 | header | `docs/verification/fusion/12-task-control.json` |
| `scripts/fusion/backup-state.mjs` | 运维写状态 | 制作备份；--quiesce 会短暂停写并恢复服务 | 重启或停服务、写运行状态 | 是 | header | — |
| `scripts/fusion/close-acceptance.mjs` | 运维写状态 | 验收结束后关闭 testIngress，不重置发送账本 | 写运行状态 | 是 | header | `docs/verification/fusion/16-closeout.json` |
| `scripts/fusion/copy-domain-state.py` | 运维写状态 | 迁移领域状态库（迁移工具，不是日常命令） | 写运行状态 | 是 | code | `docs/verification/migration/04-domain-copy.json` |
| `scripts/fusion/install-plugins.mjs` | 运维写状态 | 按锁文件安装受控第三方插件 | 写运行状态 | 是 | header | — |
| `scripts/fusion/install-service.mjs` | 运维写状态 | 首次切换 systemd 单元到融合服务 | 重启或停服务 | 是 | header | — |
| `scripts/fusion/link-dependencies.mjs` | 运维写状态 | 固定并链接本地 SDK 只读依赖 | 写运行状态 | 是 | header | — |
| `scripts/fusion/recovery-probe.mjs` | 运维写状态 | 仅供 restore-verify 在沙箱内启动 Gateway | 写临时测试目录 | 是 | header | — |
| `scripts/fusion/register-project.mjs` | 运维写状态 | 维护 projects.json 登记（默认只预览，--apply 才写） | 写运行状态 | 是 | header | — |
| `scripts/fusion/restore-legacy.sh` | 运维写状态 | 按 A/B 方案把旧系统复制回原路径（不自动启动） | 重启或停服务 | 是 | header | — |
| `scripts/fusion/restore-verify.mjs` | 运维写状态 | 隔离恢复演练（只写新建 /tmp 目标） | 写临时测试目录 | 是 | header | — |
| `scripts/fusion/run-gateway.mjs` | 运维写状态 | 前台生产入口；日常只由 systemd 启动 | 真实模型、重启或停服务、写运行状态 | 是 | header | — |
| `scripts/fusion/stop-gateway.mjs` | 运维写状态 | 按环境证明停止隔离 Gateway | 重启或停服务 | 是 | header | — |
| `scripts/fusion/evidence-coverage.mjs` | 只读运维 | 校验证据目录分类覆盖，未分类即非零退出 | 只读 | 否 | header | `docs/verification/` |
| `scripts/fusion/evidence-index.mjs` | 只读运维 | 生成本脚本与证据索引 | 只读 | 否 | header | `docs/verification/SCRIPTS.md` |
| `scripts/fusion/health.mjs` | 只读运维 | 服务、QQ、频道、Cron、数据库健康 | 只读 | 否 | header | — |
| `scripts/fusion/inspect-receipts.mjs` | 只读运维 | 查看验收回执 | 只读 | 否 | code | `docs/verification/fusion/receipts.json` |
| `scripts/fusion/log-query.mjs` | 只读运维 | 跨 SnowLuma/OpenClaw/提醒来源的链路事件只读查询 | 只读 | 否 | header | — |
| `scripts/fusion/probe-final.mjs` | 只读运维 | health.mjs 的兼容入口 | 只读 | 否 | header | — |
| `scripts/fusion/stack-summary.mjs` | 只读运维 | 启停输出压缩显示 | 只读 | 否 | header | — |
| `scripts/fusion/sync-config.mjs` | 只读运维 | 默认只报告配置漂移；--apply 才写 openclaw.json | 写运行状态、只读 | 否 | header | — |
| `scripts/fusion/sync-persona.mjs` | 只读运维 | 默认只报告人格漂移；--apply 才写 workspace 四份文件 | 写运行状态、只读 | 否 | header | — |
| `scripts/fusion/verify-dependencies.mjs` | 只读运维 | 依赖自持、无归档树逃逸、锁文件一致 | 只读 | 否 | header | — |
| `scripts/fusion/launchers/Start-DSH.sh` | 启停脚本 | 启动 DSH Web 与融合助手；QQ 传输只检查不启停，旧消费者由 Conflicts 停掉 | 重启或停服务 | 是 | header | — |
| `scripts/fusion/launchers/Stop-DSH.sh` | 启停脚本 | 停止融合助手与 DSH Web；不停止 QQ 传输 | 重启或停服务 | 是 | header | — |
