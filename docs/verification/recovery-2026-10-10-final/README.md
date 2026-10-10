# 最终恢复点与隔离恢复验证（2026-10-10 收尾版）

对应清单：V04 的处置与最终关闭。本文是**新需求开始前的最终恢复点**，取代
[`recovery-2026-10-10/`](../recovery-2026-10-10/README.md)（`584b3a0` 时点的旧恢复点，保留为历史对照）。
规则见[文档 16](../../16_验收与测试总表.md)。

## 为什么有第二个恢复点

`584b3a0` 之后，为修正 R01–R06 与 V01–V06，`scripts/` 与 `chatbot/` 有 5 个文件变更，其中
`register-project.mjs` 是**新增的可写维护脚本**，`restore-legacy.sh` 的提示与
`chatbot/plugins/kurumi-tasks/protected-roots.js` 的保护规则也被修改。
这不再是“只改文档”，与旧恢复点末尾“涉及代码就重新制作恢复点”的规则冲突，
因此**按规则制作本恢复点**（经用户 2026-10-10 选择），而不是修订规则。

## 恢复点

| 项目 | 值 |
| --- | --- |
| 备份目录 | `/home/afrangry/kurumi-backups/2026-10-10-12-36-17-final-closeout` |
| 标签 / 时间 | `final-closeout`；`EXPECTED.json.createdAt` = `2026-10-10T12:36:22Z`（北京时间 20:36） |
| 类型 | **停写快照**：`quiesced: true`（`quiescedRequested: true`） |
| 源码提交 | `0f2255a2ddbf32319428c993a3aa5d301fe03c1d`（`main`，V01–V06 补正提交） |
| 未提交例外 | **无。`patches/` 目录为空**——快照前工作区干净，这是与上一恢复点的关键区别 |
| 数据库 | 9/9 一致快照（`sqliteSnapshots.ok = 9`） |
| 校验清单 | `MANIFEST.sha256`（3778 个文件）与 `EXPECTED.json` 随备份保存 |
| 服务恢复 | 采集后 `kurumi-fusion` 实测 `active`；无 `INCOMPLETE.json`、无 `.backup.lock` 残留 |

```bash
node scripts/fusion/backup-state.mjs --label final-closeout --quiesce
# -> backup ok: every required item present (cross-database consistency: quiesced)
```

## 隔离恢复验证

```bash
node scripts/fusion/restore-verify.mjs --backup /home/afrangry/kurumi-backups/2026-10-10-12-36-17-final-closeout
# -> 24/24 checks passed
#    assembled runtime at: /tmp/kurumi-restore-jjTHib/runtime
#    恢复层级: isolated-gateway
```

| 层级 | 覆盖的检查 | 结论 |
| --- | --- | --- |
| 材料完整性 | `manifest (3778 files) all match`、`required content (14 entries)`、`expected databases (9)`、三个仓库 bundle 可校验 | 材料齐全且未被篡改 |
| 历史与数据 | 三个 clone 的 HEAD/分支/标签与记录一致（`kurumi-fusion 0f2255a2`、`legacy-openclaw f8319c11`、`qq-bridge d64a4d22`）、9 个数据库完整性检查通过 | 源码历史与数据库都能还原 |
| 组装与依赖 | 运行目录 21 项就位、数据库落回运行路径、配置可加载、token/凭据文件存在、固定哈希 SDK 还原、插件前缀与恢复仓库 `npm ci`、3 个 TS 包沙箱内编译 | 恢复副本是可构建、可加载的完整运行体 |
| 运行时边界 | 隔离 Gateway 启动并导入全部 7 个插件、用恢复源码读记忆（`revision 4, 6 entries`）、组装数据库可在位打开 | 隔离 Gateway 可运行，生产路径与主机总线不可见 |

**为什么是 24 项而不是上一份报告的 25 项**：上一恢复点有 1 项未提交修改，因此多出「未提交补丁可重放」
一项。本恢复点工作区干净、`patches/` 为空，该项不适用，**不是检查缺失**。

## 隔离边界与验证范围

```json
{"ok": true, "loaded": ["@kurumi/qq-channel","@kurumi/tasks","@openclaw/tavily-plugin",
 "openclaw-plugin-personal-confirmation","openclaw-plugin-personal-weather","kurumi-memory","kurumi-research"],
 "productionInvisible": true, "hostBusInvisible": true, "networkNamespace": true,
 "gatewayHealth": true, "mockOneBotDelivery": 2, "imageStaging": true, "projectChecks": 1,
 "realDelivery": false, "cronEnabled": false}
```

- **已证明**：材料校验、隔离 Gateway 启动与插件加载、模拟 OneBot 文字投递（2 次）与入站图片暂存、
  一个注册的项目检查、生产路径与主机总线不可见、网络独立。
- **未证明**（不得用上面结果替代）：真实模型调用与图片理解、真实 QQ 登录与真人往返
  （本次 `realDelivery=false`）、旧提醒重放与投递对账、调度投递（`cronEnabled=false`）。
- 恢复验证只写新建的 `/tmp/kurumi-restore-jjTHib`，**未触碰任何主机服务**，原始备份只读。

## 外部材料位置

| 材料 | 位置 |
| --- | --- |
| 固定哈希 SDK 归档（`openclaw` 2026.9.7） | `/home/afrangry/kurumi-backups/legacy-baselines-2026-10-05/2026-10-05-full-migration_openclaw-sdk-2026.9.7.tar.gz` |
| 旧系统全量归档 | `/home/afrangry/kurumi-backups/legacy-archive-state-2026-10-05/`（含 `SHA256SUMS`） |
| 本恢复点本体 | `/home/afrangry/kurumi-backups/2026-10-10-12-36-17-final-closeout/` |
| 本次证据副本 | 本目录（`verification.json`、`isolation-result.json`、`gateway-probe.log`、`backup-EXPECTED.json`、`backup-meta.txt`） |
| 上一恢复点与差异说明 | [`recovery-2026-10-10/`](../recovery-2026-10-10/README.md)（`584b3a0`，含 4547 字节补丁） |

## 证据保存范围

- `gateway-probe.log` 已被 `.gitignore` 的窄例外 `!docs/verification/recovery-*/gateway-probe.log`
  覆盖，**随提交入库**；其它 `*.log` 仍被忽略。
- 入库前已扫描：只含 Gateway 启动/关闭时间线，无 token、API Key、secret、password、Bearer、`sk-` 或 owner QQ 号
  （`token` 的两处命中是检查名与凭据文件名）。
- 备份本体（`MANIFEST.sha256`、`EXPECTED.json`、`git/`、`patches/`、`config/`、`state/`、`meta/`）在私有目录，
  **不在 Git 里**；本目录只保存结论与小型证据。不要把“本机证据文件数”当作“Git 克隆包含的文件数”。

## 快照与后续提交的差异处理

本恢复点对应 `0f2255a2`。**本节是最终收尾快照，之后不应再为文档回填反复重打**：

- 若关闭清单时只改文档（本清单的归档状态、文档 16/12 的回填），记录提交号与远端 `main` 的新 SHA，
  说明“运行配置与代码未变”，本恢复点继续有效。
- 若再改代码、`config/`、`roles/` 或运行脚本，按文档 16 重新制作恢复点。

返回[文档入口](../../README.md)。
