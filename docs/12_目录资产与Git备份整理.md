# 目录资产与Git、备份整理

资产基线采集于 2026-10-06；恢复点与收尾状态更新于 2026-10-10。目录整理、旧系统归档和 MyBot 远端配置已经完成。下表体积和第三方版本为采集时点记录，更新或清理前须重新核对。

## 实际资产

| 资产 | 位置 | Git与建议 |
| --- | --- | --- |
| 旧A源码及私有状态 | `/home/afrangry/kurumi-archive/legacy-openclaw` | 旧原路径 `/home/afrangry/.openclaw` 已不存在；归档 Git HEAD `f8319c1`，对应 MyBot 的 `archive/legacy-openclaw` 分支。凭据、数据库和依赖仍以归档/备份为准 |
| 新源码 | `/home/afrangry/kurumi-fusion` | Git 远端为 `git@github.com:zsh-afrangry/MyBot.git`；日常在 `main` 开发；同步状态用 `git status -sb` 和 `git rev-list --left-right --count origin/main...main` 查询（远端跟踪分支以最近 fetch 为准） |
| 新运行状态 | /home/afrangry/.openclaw-fusion，约109M | 根目录无Git，合理：凭据、SQLite、会话走私有备份；其中projects/fusion是独立代码Git，不等于根目录需要Git |
| 旧bridge源码与状态 | `/home/afrangry/kurumi-archive/qq-bridge` | Git HEAD `d64a4d2`，分支 `personal/main`，标签 `seal/qq-bridge-personal-2026-10-05`；`upstream` 保留原作者，`origin` 指向个人远端但当前 `git ls-remote` 返回 `Repository not found`。原桌面路径不再是权威工作树 |
| SnowLuma安装与运维文件 | /home/afrangry/snowluma，约210M | 无Git，包含发布压缩包、runtime及运维文档；它仍是新系统传输组件。仅自编启动/配置模板/文档需要版本管理，二进制、登录状态和日志不适合全部git add |
| DSH程序 | /opt/deepseek-harness | npm安装目录，无Git正常。当前包0.2.0-rc.2约509M；0.1.5-rc.3旧node_modules备份约524M |
| DSH服务数据 | /var/lib/dsh/.dsh，父目录约25M | 当前服务DSH_HOME明确指向这里，含凭据与会话，不进普通Git |
| 另一份DSH数据 | /home/afrangry/.dsh，约1.1M | 与服务数据目录不同；可能由其他CLI调用产生，未证实无用，不删除 |
| DSH工作目录 | /srv/dsh-workspace | 当前空目录，但仍是服务WorkingDirectory，不能只因空就删除 |
| DSH桌面草稿 | /home/afrangry/桌面/DSH，约44K | 草稿需与部署文件逐项核对，不能凭名称判重复 |
| QQ客户端与用户数据 | /opt/QQ、/home/afrangry/.config/QQ（约791M） | 新旧传输共用安装/登录基础，不能随旧B清理 |

旧A也不是只靠 `.openclaw`：OpenClaw程序位于 `/home/afrangry/.npm-global/lib/node_modules/openclaw`，用户服务单元在 `~/.config/systemd/user/openclaw-gateway.service`。新融合使用受版本约束的 SDK；恢复验收使用固定哈希归档副本，不依赖旧A原路径。

旧B另依赖 `/etc/systemd/system/dsh-web.service` 以及 `~/.config/systemd/user/` 下 qq-bridge、snowluma、snowluma-qq 服务。DSH 当前服务用户为 afrangry、HOME 为 `/home/afrangry`、DSH_HOME 为 `/var/lib/dsh/.dsh`。`/opt/deepseek-harness/README.md` 中版本 0.1.5-rc.3 和服务用户 dsh 的文字已落后于实况；该官方安装目录不属于 MyBot 文档改造范围。

## 当前资产复核（2026-10-17）

本节记录本次收尾读取到的实际状态；较早的采集时间、提交号和体积只保留为历史资料，不能覆盖本节。

| 范围 | 当前事实 |
| --- | --- |
| Fusion 主仓库 | `/home/afrangry/kurumi-fusion`，`main` 当前提交以 `git rev-parse HEAD` 为准，`origin/main`=`d717965f`，本地领先 13 个提交，工作区干净 |
| KnowledgeMap 主仓库 | `/home/afrangry/repository`，`master`=`27f4519`，`origin/master`=`2889e62`，本地领先 3 个提交；工作区保留 6 个并行账单视觉开发文件，未暂存、未提交、未清理 |
| Fusion 后台副本 | `/home/afrangry/.openclaw-fusion/projects/fusion`，分支 `kurumi/main-sync-2026-10-10`，HEAD=`a4e7487`，干净、无 remote；最后内容同步基线为 `2c234af`/`0ada63a`，尚未追平 Fusion 当前主仓库 |
| 运行服务 | `kurumi-fusion.service`、`knowledgemap-assistant.service`、`snowluma.service`、`snowluma-qq.service` 均 active/enabled；`openclaw-gateway.service` 与 `qq-bridge.service` inactive/masked；用户级 `dsh-web.service` 当前不存在，本复核未改动系统级单元 |
| 备份资料 | `knowledgemap-bridge-2026-10-17-01-03-26`、`knowledgemap-bridge-2026-10-17-post-cutover`、`2026-10-16-18-07-42-knowledgemap-post-cutover`、`knowledgemap-bridge-git-closeout-2026-10-17-02-54-28` 均存在；它们是配对代码/状态或差异资料，不是同一时刻跨系统停写快照 |

本次只更新 Fusion 文档，不触碰 KnowledgeMap 的 6 个并行文件，也不把历史 `8dbdaef` 或 `0f2255a2` 写成当前提交。后台副本的追平与合入留到下一次后台代码任务开始前处理。

## 备份资产与保留规则

`/home/afrangry/kurumi-backups/` 保存私有恢复材料；Git 不替代凭据、数据库、忽略文件和依赖的备份。共享业务接入后的代码基线、Fusion运行快照和KnowledgeMap MySQL配对资料见[文档23备份与恢复演练](23_KnowledgeMap业务能力桥接.md#备份与恢复演练)及其[恢复证据](verification/knowledgemap-bridge-2026-10-17/recovery.json)：Fusion26/26、MySQL4组通过，非跨系统同一时刻停写快照。固定SDK及此前停写点仍按[2026-10-10恢复报告](verification/recovery-2026-10-10-final/README.md)保留：`2026-10-10-12-36-17-final-closeout`，对应`0f2255a2`、24/24；它不包含新共享业务。更早报告保留对照；目录名含FINAL本身不代表验收通过。

新需求前收尾已于 2026-10-10 完成独立复验并归档；结论与批准延期项统一见[文档 16](16_验收与测试总表.md)。**收尾核验基线**为当时本地及实际远端 main `8dbdaef`；本次回填只改文档，不改变 `0f2255a2` 恢复点的运行态覆盖范围。

- `legacy-archive-state-2026-10-05`：旧系统**归档现状快照**，包含忽略文件、依赖和符号链接；不是迁移前时间点的重建。
- `legacy-baselines-2026-10-05`：保留下来的历史材料，包括恢复所需固定 SDK 包，不能整目录视为冗余。
- `2026-10-05-pre-consolidation`：整理前的备份与远端推送资料，按其 README 解释范围。
- `2026-10-05-15-56-20-FINAL-quiesced`：历史停写检查点，其原 20/20 是材料、目录和数据库检查，不代表当时已经隔离启动。

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

当前个人远端是失效地址，`Repository not found` 通常表示仓库不存在、改名或当前账号没有权限；这不影响本地 Git 的完整性，但意味着它不是备份。创建远端需要 GitHub 侧写入操作，仍由用户单独决定和执行。

DSH/SnowLuma安装目录用版本号、安装来源、校验及部署脚本管理。自编脚本可放新源码的运维目录；统一启停脚本已在scripts/fusion/launchers版本管理。私有状态定期一致性备份，至少保留旧方案归档现状快照与最新新系统快照；确认恢复成功后滚动删除中间快照。

统一启停与部署副本同步规则见[运行维护](10_融合助手运行维护.md)。
