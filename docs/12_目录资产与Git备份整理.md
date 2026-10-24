# 目录资产与 Git、备份管理

类型：资产规则。状态：目录分工与保留约束持续维护；旧系统封存已完成，远端可访问性及清理候选仍有未完成项，见本文末尾。

本文回答“资产在哪里、由谁维护、备份覆盖什么”。回退操作归[文档15](15_旧系统回退.md)，恢复验收归[文档16](16_验收与测试总表.md)，三者分别维护。2026-10-06 的体积/安装版本和10-17的Git/服务观察已移到[资产快照](archive/documentation-2026-10-23/12_目录资产与Git备份整理.md)，不能当实时状态。

## 资产归属

| 资产 | 权威位置 | 管理边界 |
| --- | --- | --- |
| Fusion 源码与配置意图 | `/home/afrangry/kurumi-fusion`，MyBot `main` | Git；远端 `git@github.com:zsh-afrangry/MyBot.git`，运行副本不作为源码主线 |
| 私有运行状态 | `/home/afrangry/.openclaw-fusion` | 凭据、会话、记忆、业务状态和产物走私密备份；根目录不建 Git |
| 后台项目副本 | `.openclaw-fusion/projects/fusion` | 独立代码 Git；同步、审阅和合入只按[文档10](10_融合助手运行维护.md#后台开发副本契约) |
| 旧 A 原件 | `/home/afrangry/kurumi-archive/legacy-openclaw` | 封存版本 `f8319c1`已包含在MyBot `main`历史中；原`archive/legacy-openclaw`分支清理不删除历史或原件；不直接启动或修改，凭据/依赖另靠私密归档 |
| 旧 B bridge 原件 | `/home/afrangry/kurumi-archive/qq-bridge` | 独立 Git；封存 `d64a4d2`、`personal/main`、`seal/qq-bridge-personal-2026-10-05`；保留 upstream 和本地恢复资料 |
| 旧服务单元 | `/home/afrangry/kurumi-archive/legacy-units` | 旧消费者日常 mask；只在文档15的所选回退路径中恢复 |
| SnowLuma | `/home/afrangry/snowluma` | 发布程序、runtime 与运维文件；只版本管理自编脚本/模板，不整体 git add 登录数据和日志 |
| DSH 程序与服务 | `/opt/deepseek-harness`、`/etc/systemd/system/dsh-web.service` | 第三方安装，不纳入 MyBot 源码；自编启停源在 `scripts/fusion/launchers/` |
| DSH 私有服务状态 | `/var/lib/dsh/.dsh` | 已登记服务数据位置；变更前核对实际 `DSH_HOME`，不提交凭据/会话 |
| 其他 DSH 候选资料 | `/home/afrangry/.dsh`、`/home/afrangry/桌面/DSH`、旧 node_modules | 未证明冗余；桌面草稿与部署文件逐项比对后再判断 |
| DSH 工作目录 | `/srv/dsh-workspace` | 服务 WorkingDirectory；不能因空目录就删除 |
| QQ 安装/登录 | `/opt/QQ`、`/home/afrangry/.config/QQ` | 旧 B 与 Fusion 共用，不随旧 bridge 清理 |
| KnowledgeMap | `/home/afrangry/repository` 及其 MySQL | 外部业务项目；代码/数据库与 Fusion 分别备份，配对范围归[23](23_KnowledgeMap业务能力桥接.md#备份与恢复演练) |
| 私有恢复材料 | `/home/afrangry/kurumi-backups` | 按恢复点范围与验证结果保留，不凭 FINAL 名称推断有效性 |

旧 A 原路径为 `/home/afrangry/.openclaw`；旧 B 桌面原路径不作为权威副本。旧 A 另依赖全局 OpenClaw 和用户服务，旧 B 另依赖 DSH/SnowLuma。恢复副本需要固定哈希 SDK，不能只复制旧目录或只恢复 bridge 就声称整套系统已还原。

## Git 与实时状态查询

在要检查的仓库中运行：

```bash
git status -sb
git rev-parse HEAD
git rev-list --left-right --count origin/main...main
git ls-remote origin refs/heads/main
```

本地工作区、缓存的 `origin/main` 和实查远端是三类结果；领先数量受最近 fetch 影响。`git ls-remote` 只查远端，不授权 push。服务当前状态用 `health.mjs` 核对；文档快照不证明此刻已提交、已推送或服务健康。

MyBot后续只保留`main`作为开发主线；本轮合并依据、旧分支可达性、源码备份及远端执行结果见[2026-10-24收拢记录](verification/git-consolidation-2026-10-24/README.md)。分支清理不涉及旧B独立仓库、现有标签或私密运行资料。

## 备份资产与保留规则

`/home/afrangry/kurumi-backups/` 保存私有恢复材料；Git 不替代凭据、数据库、忽略文件和依赖的备份。共享业务接入后的代码基线、Fusion运行快照和KnowledgeMap MySQL配对资料见[文档23备份与恢复演练](23_KnowledgeMap业务能力桥接.md#备份与恢复演练)及其[恢复证据](verification/knowledgemap-bridge-2026-10-17/recovery.json)；各检查数量仅归该报告，不是跨系统同一时刻停写快照。固定SDK及此前停写点仍按[2026-10-10恢复报告](verification/recovery-2026-10-10-final/README.md)保留：`2026-10-10-12-36-17-final-closeout`，对应`0f2255a2`；它不包含新共享业务。更早报告保留对照；目录名含FINAL本身不代表验收通过。

新需求前收尾的结论与批准延期项统一见[文档16](16_验收与测试总表.md)；历史收尾提交不扩大任何恢复点的运行态覆盖范围。


- `legacy-archive-state-2026-10-05`：旧系统**归档现状快照**，包含忽略文件、依赖和符号链接；不是迁移前时间点的重建。
- `legacy-baselines-2026-10-05`：保留下来的历史材料，包括恢复所需固定 SDK 包，不能整目录视为冗余。
- `2026-10-05-pre-consolidation`：整理前的备份与远端推送资料，按其 README 解释范围。
- `2026-10-05-15-56-20-FINAL-quiesced`：历史停写检查点，其原检查是材料、目录和数据库检查，不代表当时已经隔离启动。

`/home/afrangry/kurumi-baselines` 已删除。旧迁移前全量包的忽略文件历史内容没有被逐项证明等价覆盖；当前归档快照无法补回那个历史时点。不得宣称已经重新获得迁移前基线。

备份有效性、停写要求和恢复命令只在[验收总表](16_验收与测试总表.md)维护。删除任何恢复材料前，先明确保留范围并验证替代材料可恢复；不凭目录名、体积或文件名相同判断冗余。

## 尚待处理

- 旧 bridge 个人远端不可访问；本地 Git、封存标签、bundle 与私有全量包继续保留。
- 旧系统真实启动与外发需按[回退规则](15_旧系统回退.md)单独验收。旧 B 的 bridge 恢复不等于 DSH 版本和数据整体回到封存时点。
- DSH 的旧 `node_modules.0.1.5-rc.3`、桌面草稿和另一份 `.dsh` 数据尚未证明可安全删除，继续保留。

## 推荐管理方式

源码Git、软件安装、私有运行状态、备份四类分开。`MyBot` 是融合项目的唯一主仓库；不要把整个 home、运行状态或第三方 bridge 的完整 Git 历史塞进 MyBot。

qq-bridge 应作为**独立仓库/独立归档资产**管理，因为它有自己的上游历史、发布节奏和回退边界。它与当前项目的“绑定”应通过融合项目中的配置、启动契约和归档版本记录表达，而不是把两个项目强行合并成一个 Git 工作树。当前推荐顺序：

1. 继续保留本地 `/home/afrangry/kurumi-archive/qq-bridge` 作为权威封存副本；`personal/main`、封存标签、本地 bundle 和全量备份共同构成可恢复性。
2. 若要在线协作或跨机器恢复，在 GitHub 创建你自己的 `zsh-afrangry/qq-bridge-personal` 空仓库，再将现有 `origin` 推送到该仓库；保留 `upstream` 指向原作者。远端尚未创建成功前，不要删除本地归档，也不要反复 `git push` 当作验证。
3. MyBot 只记录采用的 qq-bridge 封存提交/标签和兼容说明；不需要 Git submodule。只有未来要让 MyBot 在每次克隆时自动拉取 bridge，并接受 submodule 运维成本时，才考虑 submodule。

资产基线检查中，个人远端返回 `Repository not found`，可能是仓库不存在、改名或当时账号无权限；本轮未重新联网核对，不能把这个远端当作已验证备份。这不影响本地Git完整性。创建远端需要GitHub侧写入，仍由用户单独决定和执行。

DSH/SnowLuma安装目录用版本号、安装来源、校验及部署脚本管理。自编脚本可放新源码的运维目录；统一启停脚本已在scripts/fusion/launchers版本管理。私有状态定期一致性备份，至少保留旧方案归档现状快照与最新新系统快照；确认恢复成功后滚动删除中间快照。

统一启停与部署副本同步规则见[运行维护](10_融合助手运行维护.md)。

返回[文档入口](README.md)。
