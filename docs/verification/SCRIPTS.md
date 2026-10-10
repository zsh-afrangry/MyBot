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
| 当前有效 | `recovery-2026-10-06/*`、`fusion/*`、`deepseek-whale/*`、`2026-10-10_projects-fusion-sync.md` | 当前版本的验收与状态证据；冲突时以 recovery 报告和文档 16 为准 |
| 历史领域验收 | `migration/*`、`step6-2026-10-05/*`、顶层 `2026-*` 与 `*-acceptance.json` 等 | 旧阶段或旧频道的验收结论，只能按版本和范围追溯，不能证明当前版本 |
| 归档证据 | `../archive/verification/`、`../archive/personal-search-tests/`、`../archive/2026-*` | 已退役实现与失败实验；要复用须在新日期目录重新产生证据 |

命名约定：`*-initial`、`*-attempt`、`*-a/-b` 是**失败或首次尝试的原始记录**，`*-fixed`、`*-final` 是修正后的复验。
失败记录保留是审计要求，不代表当前缺陷仍在；反过来，`*-fixed` 也不代表之后版本仍然通过。

## 旧 harness 与当前融合测试的边界

- `chatbot/tests/acceptance/`（`run.mjs`、`run-model.mjs`、`model-driver.mjs`、`run-retrieval-*` 等）是**融合前**的离线验收 harness。
  它的系统提示词来自遗留的 [`chatbot/AGENTS.md`](../../chatbot/AGENTS.md)，测的是旧 NAICCC/`qqbot` 频道的检索与确认路径。
- `scripts/fusion/test-*.mjs` 是**当前融合系统**的验收脚本，走今天的 `kurumi-qq` 频道、`deepseek/deepseek-flash` 与领域插件。
- 因此：**旧 harness 的输出不能当作新频道的验收**；新频道的验收结论只能来自 `scripts/fusion/test-*.mjs`、插件 `test/` 与隔离恢复探针的组合。
- 大量 `*-acceptance.json`、`retrieval-review-*.json` 与 `call-analysis.test.mjs` 的断言属于旧 harness 时代，读取时应连同 `2026-09-10_文档与现状复核.txt`、`2026-10-04_检索与QQ插件现状复核.md` 一起看。

## 固定输出路径与归档

部分验收脚本把结果写到**固定路径**（例如 `scripts/fusion/test-background-code.mjs` 写
`docs/verification/fusion/10-background-code.json`），重复运行会覆盖上次输出。因此：

- 需要保留某次真实外发回执时，**先复制到带日期的归档路径**（如 `verification/archive-<日期>/`）再重跑，
  不要依赖脚本自己保留历史。
- 脚本索引表中每行的“证据位置”就是它会写入或对应的文件；`—` 表示该脚本不直接产出 `docs/verification/` 文件。
- 需要人工修正过的历史回执（例如 `*-fixed`）不要被自动重跑覆盖；先归档再复验。
- 把“脚本支持 `--out <路径>` 或时间戳输出”列为后续独立任务（清单 Q3），本轮只建立索引与归档约定。

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
没有声明、或声明本身写得不全的脚本，仍依赖 `header`/`code` 人工判读。当前 113 个脚本中
`boundary` 10 个、`header` 59 个、`code` 11 个、`offline` 33 个。

副作用词汇区分：真实模型、真实外部 API、真实 QQ 外发、建改任务、重启停服、写运行状态、
写仓库内文件、**写临时测试目录**、只读。

**库（`lib/`）的标注语义**：按“**被调用时做什么**”标注，而不是“导入时是否无副作用”。
例如 `working-tree-backup.mjs` 导入时无副作用，但 `captureWorkingTree` 会写补丁与 tar，因此标 `写运行状态` 而非只读。

## 需要授权的脚本

索引表中「需要授权」为“是”的脚本，运行前须取得用户明确同意，并在对应任务的验收记录中注明授权范围、执行结果与未覆盖范围（记录规则见[文档 16](../16_验收与测试总表.md#验收记录规则)）：真实 QQ 外发、创建或取消任务、重启服务、
写运行状态、恢复旧系统。共 59 个；其余 29 个是离线插件测试、只读运维脚本和库文件。

`testIngress` 保持 `false`：合成入站入口默认关闭，验收脚本需要时自行开启并在结束后用
`scripts/fusion/close-acceptance.mjs` 关闭，且**从不重置发送账本**。

## 索引表

<!-- 由 node scripts/fusion/evidence-index.mjs --markdown 生成；请勿手工编辑表格内容 -->

| 脚本 | 分组 | 用途 | 副作用 | 需要授权 | 分类依据 | 证据位置 |
| --- | --- | --- | --- | --- | --- | --- |
| `chatbot/packages/confirmation-core/src/confirmation.test.ts` | 离线 | 确认核心：提案校验、TTL、幂等与 grant 消费 | 只读 | 否 | offline | — |
| `chatbot/packages/confirmation-core/src/public-id.test.ts` | 离线 | 公开 ID 脱敏与冲突规避 | 只读 | 否 | offline | — |
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
| `scripts/fusion/fixtures/test_stats.py` | 离线 | 固定验收 fixture：后台代码任务的 mean/moving_average 断言 | 只读 | 否 | code | — |
| `scripts/fusion/test/recovery.test.mjs` | 离线 | 备份/恢复工具单元与集成回归 | 只读 | 否 | offline | — |
| `scripts/fusion/test/register-project.test.mjs` | 离线 | 项目注册表维护 CLI 与共享保护根规则回归（含归档拒绝） | 只读 | 否 | offline | — |
| `chatbot/tests/acceptance/call-analysis.mjs` | 库 | 旧验收调用观察工具（只观察，不证明写入） | 只读 | 否 | header | — |
| `chatbot/tests/acceptance/domain-fixture.mjs` | 库 | 旧验收领域夹具与工具定义 | 只读 | 否 | code | — |
| `chatbot/tests/acceptance/host-driver.mjs` | 库 | 旧 harness Host 驱动，只开测试状态目录 | 写临时测试目录、只读 | 否 | code | — |
| `chatbot/tests/acceptance/model-driver.mjs` | 库 | 旧 harness 模型驱动（构造模型客户端，读取遗留 AGENTS） | 真实模型 | 否 | code | — |
| `chatbot/tests/acceptance/retrieval-config.mjs` | 库 | 旧验收检索输出预算配置 | 只读 | 否 | header | — |
| `scripts/fusion/lib/backup-service.mjs` | 库 | 备份期间停写并恢复服务 | 重启或停服务 | 否 | header | — |
| `scripts/fusion/lib/fresh-id.mjs` | 库 | 生成不重复的 message id | 只读 | 否 | header | — |
| `scripts/fusion/lib/legacy-source.mjs` | 库 | 解析旧 OpenClaw 源树路径（仅迁移脚本用） | 只读 | 否 | header | — |
| `scripts/fusion/lib/plugins.mjs` | 库 | 第三方插件声明（纯数据，导入无 I/O） | 只读 | 否 | header | — |
| `scripts/fusion/lib/recovery-isolation.mjs` | 库 | 隔离恢复的路径与凭据改写 | 只读 | 否 | header | — |
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
| `scripts/fusion/evidence-coverage.mjs` | 只读运维 | 校验证据目录分类覆盖，未分类即非零退出 | 只读 | 否 | header | `docs/verification/` |
| `scripts/fusion/evidence-index.mjs` | 只读运维 | 生成本脚本与证据索引 | 只读 | 否 | header | `docs/verification/SCRIPTS.md` |
| `scripts/fusion/health.mjs` | 只读运维 | 服务、QQ、频道、Cron、数据库健康 | 只读 | 否 | header | — |
| `scripts/fusion/inspect-receipts.mjs` | 只读运维 | 查看验收回执 | 只读 | 否 | code | `docs/verification/fusion/receipts.json` |
| `scripts/fusion/probe-final.mjs` | 只读运维 | health.mjs 的兼容入口 | 只读 | 否 | header | — |
| `scripts/fusion/stack-summary.mjs` | 只读运维 | 启停输出压缩显示 | 只读 | 否 | header | — |
| `scripts/fusion/sync-config.mjs` | 只读运维 | 默认只报告配置漂移；--apply 才写 openclaw.json | 写运行状态、只读 | 否 | header | — |
| `scripts/fusion/sync-persona.mjs` | 只读运维 | 默认只报告人格漂移；--apply 才写 workspace 四份文件 | 写运行状态、只读 | 否 | header | — |
| `scripts/fusion/verify-dependencies.mjs` | 只读运维 | 依赖自持、无归档树逃逸、锁文件一致 | 只读 | 否 | header | — |
| `scripts/fusion/launchers/Start-DSH.sh` | 启停脚本 | 启动 DSH Web + 融合栈，停旧消费者 | 重启或停服务 | 是 | header | — |
| `scripts/fusion/launchers/Stop-DSH.sh` | 启停脚本 | 按消费者优先顺序停止整套栈 | 重启或停服务 | 是 | header | — |
| `scripts/fusion/test-background-code.mjs` | 验收 | 后台代码任务登记检查与终态 | 真实模型、真实QQ外发、建/改任务或提醒、写运行状态、写仓库内文件 | 是 | header | `docs/verification/fusion/10-background-code.json` |
| `scripts/fusion/test-domain-due.mjs` | 验收 | 提醒到点投递（跨重启） | 真实模型、真实QQ外发、建/改任务或提醒、写运行状态、写仓库内文件 | 是 | header | `docs/verification/migration/10-reminder-restart-delivery.json` |
| `scripts/fusion/test-domain-planning.mjs` | 验收 | 行程提案与确认写入（隔离库） | 真实模型、写运行状态、写仓库内文件 | 是 | header | `docs/verification/migration/11-planning-confirmation.json` |
| `scripts/fusion/test-domain-read.mjs` | 验收 | 领域只读自然语言验收：真实模型 + QWeather 工具；不发 QQ、不写偏好 | 真实模型、真实外部API、写仓库内文件 | 是 | boundary | `docs/verification/migration/06-domain-read.json` |
| `scripts/fusion/test-domain-reminder.mjs` | 验收 | 提醒 CRUD 与确认口令，回复本地捕获 | 真实模型、建/改任务或提醒、写运行状态、写仓库内文件 | 是 | header | `docs/verification/migration/09-reminder-crud.json` |
| `scripts/fusion/test-fulltext-research.mjs` | 验收 | 论文全文研究任务 | 真实模型、建/改任务或提醒、写运行状态、写仓库内文件 | 是 | code | `docs/verification/migration/26-fulltext-research.json` |
| `scripts/fusion/test-live-inbound.mjs` | 验收 | 合成入站 → 真实模型 → 本人 QQ 外发 | 真实模型、真实QQ外发、写运行状态、写仓库内文件 | 是 | header | `docs/verification/fusion/01-native-inbound.json` |
| `scripts/fusion/test-live-media.mjs` | 验收 | 合成图片入站与真实外发 | 真实模型、真实QQ外发、写运行状态、写仓库内文件 | 是 | header | `docs/verification/fusion/03-native-media.json` |
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

## 游离证据文件的来源

前一版索引声称覆盖全部文件，但有 9 个顶层文件不在任何已列分类中。逐项来源如下：

| 文件 | 来源 | 类别 |
| --- | --- | --- |
| `2026-10-05_融合前基线收尾.md` | 融合前基线的收尾记录（阶段笔记） | 历史阶段记录 |
| `confirmation-instruction-reminder-initial.json` | **输入样本**：被 `chatbot/tests/acceptance/call-analysis.test.mjs` 的断言读取 | 旧 harness 输入 |
| `planning-capability-initial.json` | **输入样本**：同上（`call-analysis.test.mjs`） | 旧 harness 输入 |
| `controlled-reply-reminder-fixed.json` | 旧 harness 的受控回复复验回执（`2026-09-10_文档与现状复核.txt` 第 144 行） | 历史领域验收 |
| `natural-language-reminder-a.json` | 旧 harness 的自然语言样本回执（`2026-09-10_文档与现状复核.txt` 第 129 行） | 历史领域验收 |
| `profile-geo-natural-initial.json` | Profile 地理路径首次失败记录（同复核第 163 行） | 历史失败实验 |
| `profile-geo-natural-fixed.json` | 同一路径修正后复验（同复核第 165 行） | 历史领域验收 |
| `profile-geo-provider-probe.json` | 由 `chatbot/tests/acceptance/probe-profile-geo.py` 第 59 行固定写入 | 旧 harness 输出 |
| `retrieval-review-20261004.json` | `2026-10-04_检索与QQ插件现状复核.md` 的汇总证据（同文件第 195 行引用） | 历史领域验收 |

结论：不存在“无来源的游离文件”，但它们的职责确实不同——两个是**测试输入**，一个是**旧 harness 输出**，
其余是历史阶段记录与失败/修正对照。`evidence-coverage.mjs` 现在会把它们归入“历史领域验收”，
新增文件若不属于任何分类会直接让检查失败。
