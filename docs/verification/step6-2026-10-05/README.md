# 第六步验收记录：独立运行与恢复能力

- 时间：2026-10-05 22:00–22:20 CST
- 目的：确认整理后的系统不仅当前能运行，而且知道怎样重新部署、怎样恢复。
- 原则：QQ 测试**只发本人**（`user:365999865`），不发群、不发其他人；恢复副本不接真实 QQ、
  不执行真实提醒，避免重复投递。

## 结果总览

| 验证项 | 结果 | 依据 |
|---|---|---|
| 启动与重启 | ✅ | 多次 `systemctl --user restart kurumi-fusion`，服务 active、health `ok=true` |
| 脱离旧 `.openclaw` 运行 | ✅ | 见下"独立性实测" |
| 本人 QQ 文字收发 | ✅ 出站 | 两段文本分别成条送达（间隔 671ms ≥ 400ms 下限），`get_msg` 回读内容一致 |
| 本人 QQ 图片发送 | ✅ 出站 | 收藏表情以 `image` 类型送达，回读 `types:["image"]` |
| 本人 QQ **图片识别（入站）** | ❌ 未验证 | 需跑 `test-live-media.mjs`（合成入站图片），本次**没有**执行。出站能发图 ≠ 能从入站图片里读内容 |
| 联网搜索 | ✅ | `web_search` 真实返回 URL（Tavily / DeepSeek 服务端检索） |
| 天气 | ✅ | `personal_weather_get_brief` 返回真实和风天气数据；只读校验偏好/行程哈希未变 |
| 提醒投递（automations → agentTurn 链） | ✅ | 自然语言 → 原生 automations → 到点 agentTurn → `deliveryStatus: "delivered"` |
| 提醒（`personal_reminder_*` 确定性链） | ❌ 未验证 | 该链走 `reminderBackend: "native-service"` 与固定 command runner，需跑 `test-domain-reminder.mjs` / `test-domain-due.mjs`，本次**没有**执行。上面那条是另一条链，**不能**互相替代 |
| 研究任务 | ✅ | `web_search` + `web_fetch` 取 arXiv 元数据，作者/年份/链接正确，且如实声明只读了摘要页 |
| 后台代码任务 | ⚠️ 部分 | 机制已验证（受理、worker 会话、沙箱、独立测试通过），但严格断言未复现，见下 |
| 统一启停脚本 | ⚠️ 未执行 | 见下"未能执行的部分" |
| 从备份恢复到隔离目录 | ⚠️ 当时仅材料级 | 当时 `restore-verify.mjs` 只做材料校验（9/9）。现已重写为**组装并加载**运行目录的 18 项校验，见文末"后续修正" |

## 独立性实测（第四步完成标准）

把 `/home/afrangry/.openclaw` 整体移走后重启服务：

- 服务 `active`
- `health.mjs`：`ok=true`、`issues=[]`、网关在线、QQ 在线、频道已连、提醒与天气库正常
- `verify-dependencies.mjs` 通过
- 181 个测试通过
- 日志中唯一一条是 `kurumi-qq.testInbound` 被拒（验收入口按设计关闭），与旧目录无关

随后原样恢复，`.openclaw` git 状态 0 改动、HEAD 不变。

## 发现并修复的缺陷：验收脚本是"一次性"的

**症状**：`test-domain-read.mjs` 重跑时报 `Missing successful personal_profile_state_get`，
`reply: []`、`tools: []`，看起来像功能回归。

**根因**：不是回归。信道的入站去重账本（`channel.sqlite` 的 `inbound` 表）按
`self_id:user_id:message_id` 做持久去重，**这是正确设计**。但 8 个验收脚本把 message id 写死
（如 `-1900100001`），这些 id 在原验收运行时已被消费，重跑时被去重直接忽略，脚本看起来失败、
实际什么也没做。

实测确认：`1794511189:365999865:-1900100001` 在 `2026-10-05 06:53:39` 已 `completed`。

**同类第二个缺陷**：`test-background-code.mjs` 把 `idempotencyKey` 写死为 `fusion-chat-while-code`，
重跑时抛出 `Session transcript keyed user is outside the current turn` —— 同一个"一次性"问题。
对照实验证明与功能无关：同一个会话、同一个新会话，只要换成新的 `idempotencyKey` 都返回
`status=ok`。（`test-native-concurrency.mjs` 早已用 `randomUUID()`，是正确写法。）

**修复**：新增 `scripts/fusion/lib/fresh-id.mjs`（`freshMessageId()`，负数、含毫秒与计数器，
不会与历史 id 冲突），8 个脚本改为调用它；`test-background-code.mjs` 的 `idempotencyKey`
改用 `randomUUID()`。修复后 `test-domain-read.mjs` 立即 `passed: true`。

## 未能完全验证的部分（如实记录）

### 1. 后台代码任务的严格断言

`test-background-code.mjs` 要求 worker 在 **90 秒**内调用 `kurumi_project_check`。实测：

- 任务受理正常（真实 `runId`、`sessionKey`、`projectId: fusion`）
- worker 会话确实创建并运行（transcript 217 个事件）
- 独立 Python 测试 `Ran 6 tests ... OK`（测试文件未被改动，哈希一致）
- **两个 worker 最终都返回 `status=ok`** —— 只是晚于 90 秒窗口
- 沙箱约束生效：`kurumi_project_git branch` 被拒（`Branch must be kurumi/<name>`）

最后一次运行时主模型**主动拒绝**再启动第 4 个同类任务，理由是同一隔离工作区已有多个任务在改同一个
`stats.py`、会互相覆盖，并列出真实 `runId` 请求主人确认。这是护栏按预期工作，不是故障；但它意味着
该脚本在任务账本非空时无法重复验收。

**结论**：机制可用，稳定复现需要先查真实终态、正常取消仍在跑的任务，并为该次验收使用
**独立的项目工作区**，而不是删掉账本里的 "accepted" 记录——账本是运行任务的追踪依据，
删记录等于丢掉"哪些任务被受理过"的事实。90 秒预算本身也偏紧：实测两个 worker 最终都返回
`status=ok`，只是晚于该窗口。未修改脚本断言，以免削弱验收标准。

### 2. 统一启停脚本（Start-DSH.sh / Stop-DSH.sh）

- 语法检查通过；两个脚本内 `.openclaw` 引用为 0
- `/opt/deepseek-harness/` 下的副本与仓库副本**逐字节一致**
- 但**未实际执行**，原因有两条：
  1. 脚本会调用 `sudo -v` 与 `sudo systemctl`，本机 sudo **需要密码**，无法非交互执行；
  2. `Stop-DSH.sh` 会停止 `dsh-web.service`，而**当前这次对话本身就跑在它里面**
     （`dsh web` pid 2357839 即该服务 MainPID），执行会中断会话。

因此整套启停必须由主人在合适时机手动验证。已验证的等价部分：`kurumi-fusion`、
`snowluma`、`snowluma-qq` 的独立启停与重启、`stack-summary.mjs` 与 `health.mjs` 的就绪判定。

## 未触碰的历史证据

验收脚本会把结果写回 `docs/verification/**`。本次**刻意没有提交**这些覆盖：
部分文件带有手工补充的修正说明（如 `10-background-code.json` 的 `acceptanceCorrection`、
`13-natural-reminder-delivery.json` 的 `harnessCorrection` / `remaining`），
用本次运行结果覆盖会丢失这些记录。全部已 `git checkout HEAD --` 还原，本次结果改记于本文件。

## 收尾状态

- `testIngress` 已由 `configure-production.mjs` 关闭，重启后确认：
  `health ok=true`、`issues=[]`、`testIngress=false`
- `kurumi-qq.testInbound` 合成入口已移除（`unknown method`）
- `sync-config.mjs` 报告运行配置与 `config/runtime.config.json` 一致

## 后续修正（2026-10-05 复核后）

本文档初版有几处结论过强，复核指出后已修正，记录如下：

1. **"恢复到隔离目录 9/9"当时只是材料级校验。** 原 `restore-verify.mjs` 只验证备份目录内
   文件哈希、bundle 可克隆、数据库可打开，**没有**把配置、工作区、数据库组装成一个可运行目录，
   也没有验证恢复后能否加载。现已重写：新增 `EXPECTED.json` 预期清单、逐仓库断言
   HEAD/分支/标签、把运行目录组装到目标并实际加载（配置解析、插件路径解析、
   **用生产 memory store 读取恢复后的 MEMORY.md**、9 个数据库在组装位置打开）。
   当前为 **18/18**。原先的 9/9 应称为"备份材料校验通过"。

2. **备份漏掉了记忆与任务工作区。** 初版 `backup-state.mjs` 用白名单只复制
   `channel`/`agents`/`migration`/`projects`，**漏掉** `workspace/`（含长期记忆 `MEMORY.md`）、
   `project-checks/`、`research-workspace/`、`research-cache/`、`source-snapshots/`、
   `code-workspace/`、`media/`、`plugin-skills/`。所以"9 个数据库全部健康"**不代表**能恢复
   记忆、研究报告与代码检查环境。现已改为反向白名单（除明确跳过项外全部复制）并加入
   必需内容硬校验，缺失即非零退出。

3. **备份失败会静默成功。** 初版对数据库快照失败只记日志、rsync 返回码未检查、bundle 失败
   继续执行，最后仍正常结束并生成 manifest。现已改为任何必需项失败都累积并以非零码退出。

4. **提醒与图片的验证范围被混淆。** 见上表：本次跑的是 automations → agentTurn 链，
   不是 `personal_reminder_*` 确定性链；验证的是**出站**发图，不是**入站**图片识别。
   两者都需要另外的脚本（`test-domain-reminder.mjs` / `test-live-media.mjs`），本次未执行。

5. **`VACUUM INTO` 只保证单库一致。** 它对每个数据库各自取一致快照，但**不保证**多个数据库
   与投递账本处于同一时刻。涉及提醒恢复时，需要停写快照或明确的恢复对账机制；
   当前备份在三者间可能存在时间差。
