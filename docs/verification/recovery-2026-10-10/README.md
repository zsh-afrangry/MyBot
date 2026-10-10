# 当前恢复点与隔离恢复验证（2026-10-10）

对应清单条目：C07。规则见[文档 16](../../16_验收与测试总表.md)；本条是**新需求开始前**的跨库回退点。

## 恢复点

| 项目 | 值 |
| --- | --- |
| 备份目录 | `/home/afrangry/kurumi-backups/2026-10-10-09-05-41-rollback` |
| 标签 / 时间 | `rollback`；`EXPECTED.json.createdAt` = `2026-10-10T09:05:46Z`（北京时间 17:05） |
| 类型 | **停写快照**：`quiesced: true`（`quiescedRequested: true`） |
| 源码提交 | `584b3a06d5c52c7173b2b89f6c5102b195c5b947`（`main`），已推送到 `origin/main` |
| 未提交例外 | 无。`untrackedCaptured: []`、`binaryCaptured: []`、`failures: []`；工作树补丁已收录 |
| 数据库 | 9/9 一致快照（`sqliteSnapshots.ok = 9`） |
| 校验清单 | `MANIFEST.sha256`（3779 个文件）与 `EXPECTED.json` 随备份保存 |
| 服务恢复 | 采集后 `kurumi-fusion`、`snowluma`、`snowluma-qq` 均 `active`；无 `INCOMPLETE.json`、无 `.backup.lock` 残留 |

执行命令：

```bash
cd /home/afrangry/kurumi-fusion
node scripts/fusion/backup-state.mjs --label rollback --quiesce
# -> backup ok: every required item present (cross-database consistency: quiesced)
```

`--quiesce` 期间 `kurumi-fusion` 处于停写状态（`backup-meta.txt` 记录采集时 `active=inactive`），
采集完成后脚本自动恢复，当前实测已 `active`。停机窗口内助手与提醒投递不可用，这一点记录在案。

## 隔离恢复验证

```bash
node scripts/fusion/restore-verify.mjs --backup /home/afrangry/kurumi-backups/2026-10-10-09-05-41-rollback
# -> 25/25 checks passed
#    assembled runtime at: /tmp/kurumi-restore-fhO4TU/runtime
#    恢复层级: isolated-gateway
```

25 项全部通过，可分四层理解它证明了什么：

| 层级 | 覆盖的检查 | 结论 |
| --- | --- | --- |
| 材料完整性 | `manifest (3779 files) all match`、`required content (14 entries)`、`expected databases (9)`、三个仓库 bundle 可校验 | 备份材料齐全且未被篡改 |
| 历史与数据 | 三个 clone 的 HEAD/分支/标签与记录一致（`kurumi-fusion 584b3a06`、`legacy-openclaw f8319c11`、`qq-bridge d64a4d22`）、未提交补丁可重放、9 个数据库 `integrity_check`/`foreign_key_check` 通过 | 源码历史、未提交改动与数据库都能还原 |
| 组装与依赖 | 运行目录 21 项全部就位、数据库落回运行路径、配置可加载、token/凭据文件存在、固定哈希 SDK 归档还原、插件前缀由锁文件 `npm ci` 重建、恢复仓库 3 个包 `npm ci`、三个 TS 包在沙箱内编译 | 恢复副本是**可构建、可加载**的完整运行体，不借用生产源码或已装 SDK |
| 运行时边界 | 隔离 Gateway 启动并导入全部 7 个插件、恢复源码可读记忆（`revision 4, 6 entries`）、组装数据库可在位打开 | 隔离 Gateway 可运行，且看不到生产路径与主机总线 |

## 隔离边界与验证范围

`isolation-result.json`：

```json
{"ok": true, "loaded": ["@kurumi/qq-channel","@kurumi/tasks","@openclaw/tavily-plugin",
 "openclaw-plugin-personal-confirmation","openclaw-plugin-personal-weather","kurumi-memory","kurumi-research"],
 "productionInvisible": true, "hostBusInvisible": true, "networkNamespace": true,
 "gatewayHealth": true, "mockOneBotDelivery": 2, "imageStaging": true, "projectChecks": 1,
 "realDelivery": false, "cronEnabled": false}
```

- **已证明**：材料校验、隔离 Gateway 启动与插件加载、模拟 OneBot 文字投递（2 次）与入站图片暂存、
  一个注册的项目检查、生产路径与主机总线不可见、网络独立。
- **未证明**（不能用上面结果替代）：
  - 真实模型调用与模型对图片的理解；
  - 真实 QQ 登录与真人往返（本次 `realDelivery=false`，模拟端在命名空间内）；
  - 旧提醒重放与投递对账；
  - 调度：`cronEnabled=false`，验证期间不启动提醒调度。
- 恢复验证只写新建的 `/tmp/kurumi-restore-fhO4TU`，**未触碰任何主机服务**，原始备份只读。

## 外部材料位置

| 材料 | 位置 |
| --- | --- |
| 固定哈希 SDK 归档（`openclaw` 2026.9.7） | `/home/afrangry/kurumi-backups/legacy-baselines-2026-10-05/2026-10-05-full-migration_openclaw-sdk-2026.9.7.tar.gz` |
| 旧系统全量归档 | `/home/afrangry/kurumi-backups/legacy-archive-state-2026-10-05/`（`legacy-openclaw-current-FULL.tar.zst`、`qq-bridge-current-FULL.tar.zst`、`SHA256SUMS`） |
| 本次备份本体 | `/home/afrangry/kurumi-backups/2026-10-10-09-05-41-rollback/`（`MANIFEST.sha256`、`EXPECTED.json`、`git/`、`patches/`、`config/`、`state/`、`meta/`） |
| 本次证据副本 | 本目录（`verification.json`、`isolation-result.json`、`gateway-probe.log`、`backup-EXPECTED.json`、`backup-meta.txt`） |

## 快照与后续提交的差异处理

按“先推送、再快照”的顺序制作，因此本恢复点对应的提交 `584b3a0` **就是**当时的远端 `main`。
之后若因回填清单或复验再产生提交，差异按下列方式处理，不重复重打快照：

- 只改文档/索引的后续提交：记录其提交号与远端 `main` 的新 SHA，说明“运行配置与代码未变”，恢复点仍可用于运行态回退。
- 若后续改动涉及代码、`config/`、`roles/` 或运行配置：重新制作恢复点，并在本文件追加新一节，保留旧恢复点作为历史。

返回[文档入口](../../README.md)。
