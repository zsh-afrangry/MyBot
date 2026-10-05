# 恢复工具修复验收（2026-10-06）

本轮六项恢复与运维问题已修复并验收。新停写恢复点完整恢复 **25/25 通过**，生产服务已恢复 active/enabled，QQ 频道 connected。后续日常检查从 docs/16 开始。

## 本次可复验恢复点

- 路径：`/home/afrangry/kurumi-backups/2026-10-05-18-23-14-recovery-final/`。
- 目录名使用 UTC；本机时间为 2026-10-06 02:23:14（Asia/Shanghai）。
- 实现提交：`466b5074`（包含此前 `b2291c5`）；之后的证据、说明与源码注释提交不在这份快照中。
- `quiesced=true`，`failures=[]`，没有 `INCOMPLETE.json`，9/9 数据库快照；manifest 3686 项一致。
- 原 `2026-10-05-15-56-20-FINAL-quiesced` 是历史恢复点，不再作为本轮最终验收点。
- 完整恢复在新目录 `/tmp/kurumi-restore-SnYBJu` 执行。该临时目录不是长期备份；长期材料为上述恢复点及固定 SDK 归档。
- 固定 SDK：`/home/afrangry/kurumi-backups/legacy-baselines-2026-10-05/2026-10-05-full-migration_openclaw-sdk-2026.9.7.tar.gz`，SHA256 为 `202348542668ba28f7dbff49017e443f3b6ce21dce0ecc82d14926cf88ecbd75`。异机恢复必须一并保留该文件，可用 `--sdk-archive` 指定位置。

复验命令（新建另一个临时目录，不覆盖上述目录）：

```bash
cd /home/afrangry/kurumi-fusion
node scripts/fusion/restore-verify.mjs --backup /home/afrangry/kurumi-backups/2026-10-05-18-23-14-recovery-final
```

## 修复与实际证据

| 问题 | 修复与验收 |
| --- | --- |
| 恢复副本残留生产路径 | 递归改写活动配置、项目注册表与链接；发现未识别的生产引用即失败；Bubblewrap 隔离生产目录、服务总线和网络 |
| 仅材料检查被误写为可运行 | 恢复固定哈希 SDK、锁定依赖，编译 3 个 TS 包，实际加载 7 个插件并启动 Gateway 调用 health |
| 后台项目仍依赖主机 SDK | 沙箱固定 SDK 路径只读映射归档副本，恢复项目依赖链接；已执行注册的 1 项项目检查 |
| A/B 回退混合启动清单 | 必须明确选择 A 或 B，只复制和打印所选方案；通过两种预览测试，不自动启动旧服务 |
| 备份中断留下停机服务 | SIGINT/SIGTERM/SIGHUP 回归通过；实际停写后发送 SIGTERM，退出143、服务恢复active，不完整备份被拒绝 |
| 混合二进制工作区恢复失败 | binary/full-index 补丁和未跟踪文件归档；文本、二进制、删除、重命名、中文路径混合恢复通过 |
| 文档范围与现实不一致 | 更新配置契约、布局、回退和验收入口；历史材料检查、模拟传输和真实外发分开记录 |

## 测试结果

- 恢复工具：`recovery-tests.txt`，**10/10**；包含真实 Bubblewrap 隔离及 SDK 只读映射断言。
- 频道/任务/记忆/研究：`channel-tools-tests.txt`，**32/32**。
- 领域测试：`domain-0.txt` **17/17**、`domain-1.txt` **15/15**、`domain-2.txt` **162/162**。与恢复工具合计 **236 项通过**。
- 配置同步自测：`config-selftest.txt`，另有 **5/5**。
- 从新备份完整恢复：`verification.json`、`restore-final.txt`，**25/25**；备份摘要见 `snapshot-summary.json`。
- 沙箱启动与传输：`isolation-result.json`；7 个插件、Gateway health、模拟 OneBot 连接和 2 条模拟图文投递、本地图片暂存、1 项后台项目检查通过。
- 真实备份中断：`backup-interruption.json`；失败点 `/home/afrangry/kurumi-backups/2026-10-05-18-12-41-signal-acceptance` 保留不完整标记，不用于恢复。
- 最终生产状态：`health-final.json`；配置与人格无漂移，依赖检查通过。旧 bridge 和旧 OpenClaw inactive/disabled；SnowLuma、QQ客户端及 DSH 作为新系统依赖继续运行。

## 边界

本轮没有使用真实模型 API、没有发送真实 QQ 消息，也没有触发真实提醒。模拟传输不证明模型看图能力或真人对话效果。旧系统仅验证回退选择和预览，没有实际还原启动旧系统。

SIGKILL/断电不能依靠进程内清理恢复服务；保留 INCOMPLETE 和锁，按 docs/16 检查服务并处理陈旧锁。Git补丁恢复最终工作区内容，不保留暂存区分类。

两套旧原件及旧备份未被删除。用户 `docs/example.md` 修改保持独立且被新恢复点捕获。本轮仅本地提交，没有创建远端或推送；旧 bridge 远端不可访问的问题不由本轮恢复修复解决。
