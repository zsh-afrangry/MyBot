# 系统资产、备份与回退管理

<a id="目录资产与-git备份管理"></a>

类型：资产规则与回退操作手册。状态：目录分工与保留约束持续维护，旧系统封存已完成；复制恢复、防误启动和互斥已有阶段验证，旧A/B完整启动与整套旧B状态恢复仍未验收。远端可访问性及清理候选见[尚待处理](#尚待处理)，验收结论与延期决定见[验收总表](16_验收与测试总表.md)。

本文统一维护“资产在哪里、由谁管理、备份覆盖什么，以及如何恢复并切换旧系统”。按[资产归属](#资产归属) → [Git管理](#git-与实时状态查询) → [备份保留](#备份资产与保留规则) → [旧系统回退](#旧系统回退)阅读。Fusion运行态备份与隔离恢复的命令、证明范围仍见[验收总表](16_验收与测试总表.md#恢复点与证明范围)，KnowledgeMap共享业务的配对恢复见[共享业务恢复规则](23_KnowledgeMap业务能力桥接.md#备份与恢复演练)。

历史体积、安装版本与Git/服务观察见[资产快照](archive/documentation-2026-10-23/12_目录资产与Git备份整理.md)，旧复制检查、风险数值与屏蔽实施见[回退阶段记录](archive/documentation-2026-10-23/15_旧系统回退.md)，不能当作实时状态。2026-10-27将资产与回退合并，沿用本文件路径；迁移与本地检查见[合并记录](verification/assets-rollback-merge-2026-10-27/README.md)。

## 资产归属

| 资产 | 权威位置 | 管理边界 |
| --- | --- | --- |
| Fusion 源码与配置意图 | `/home/afrangry/kurumi-fusion`，MyBot `main` | Git；远端 `git@github.com:zsh-afrangry/MyBot.git`，运行副本不作为源码主线 |
| 私有运行状态 | `/home/afrangry/.openclaw-fusion` | 凭据、会话、记忆、业务状态和产物走私密备份；根目录不建 Git |
| E7公开资料缓存 | `.openclaw-fusion/state/kurumi-e7` | 仅公开JSON及条件请求/哈希元数据，可重新抓取；整目录备份包含它，不作为聊天或业务账本 |
| 后台项目副本 | `.openclaw-fusion/projects/fusion` | 独立代码 Git；同步、审阅和合入只按[后台开发副本契约](9_QQ融合助手架构与开发计划.md#后台开发副本契约) |
| 单目录DSH编码试点 | `/home/afrangry/.local/share/kurumi-coding-pilot-20261029` | 仅合成项目、Git工作树、私有执行/权限记录与后端profile；不是生产恢复点，当前Fusion整目录备份不自动覆盖。记录供主人评估权限，未经决定不清理；范围归[文档28](28_本机编码工具委托与实验任务.md#单目录qq试点授权2026-10-30) |
| 旧 A 原件 | `/home/afrangry/kurumi-archive/legacy-openclaw` | 封存版本 `f8319c1`已包含在MyBot `main`历史中；原`archive/legacy-openclaw`分支清理不删除历史或原件；不直接启动或修改，凭据/依赖另靠私密归档 |
| 旧 B bridge 原件 | `/home/afrangry/kurumi-archive/qq-bridge` | 独立 Git；封存 `d64a4d2`、`personal/main`、`seal/qq-bridge-personal-2026-10-05`；保留 upstream 和本地恢复资料 |
| 旧服务单元 | `/home/afrangry/kurumi-archive/legacy-units` | 旧消费者日常 mask；只按[旧系统回退](#旧系统回退)恢复所选单元 |
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

MyBot后续只保留`main`作为开发主线；2026-10-24工作线收拢的合并依据、旧分支可达性、源码备份及远端执行结果见[收拢记录](verification/git-consolidation-2026-10-24/README.md)。分支清理不涉及旧B独立仓库、现有标签或私密运行资料。

## 推荐管理方式

源码由Git管理，软件安装、私有运行状态和备份分别维护。`MyBot` 是融合项目的唯一主仓库；不要把整个 home、运行状态或第三方 bridge 的完整 Git 历史塞进 MyBot。

qq-bridge 应作为**独立仓库/独立归档资产**管理，因为它有自己的上游历史、发布节奏和回退边界。它与当前项目的“绑定”应通过融合项目中的配置、启动契约和归档版本记录表达，而不是把两个项目强行合并成一个 Git 工作树。当前推荐顺序：

1. 继续保留本地 `/home/afrangry/kurumi-archive/qq-bridge` 作为权威封存副本；`personal/main`、封存标签、本地 bundle 和全量备份共同构成可恢复性。
2. 若要在线协作或跨机器恢复，在 GitHub 创建你自己的 `zsh-afrangry/qq-bridge-personal` 空仓库，再将现有 `origin` 推送到该仓库；保留 `upstream` 指向原作者。远端尚未创建成功前，不要删除本地归档，也不要反复 `git push` 当作验证。
3. MyBot 只记录采用的 qq-bridge 封存提交/标签和兼容说明；不需要 Git submodule。只有未来要让 MyBot 在每次克隆时自动拉取 bridge，并接受 submodule 运维成本时，才考虑 submodule。

资产基线检查中，个人远端返回 `Repository not found`，可能是仓库不存在、改名或当时账号无权限；本轮未重新联网核对，不能把这个远端当作已验证备份。这不影响本地Git完整性。创建远端需要GitHub侧写入，仍由用户单独决定和执行。

DSH/SnowLuma安装目录用版本号、安装来源、校验及部署脚本管理。自编脚本可放新源码的运维目录；统一启停脚本已在scripts/fusion/launchers版本管理。私有状态定期一致性备份，至少保留旧方案归档现状快照与最新新系统快照；确认恢复成功后滚动删除中间快照。

日常启停与后台开发副本的同步规则见[架构与运行维护手册](9_QQ融合助手架构与开发计划.md)。

## 备份资产与保留规则

`/home/afrangry/kurumi-backups/` 保存私有恢复材料；Git 不替代凭据、数据库、忽略文件和依赖的备份。共享业务接入后的代码基线、Fusion运行快照和KnowledgeMap MySQL配对资料见[文档23备份与恢复演练](23_KnowledgeMap业务能力桥接.md#备份与恢复演练)及其[恢复证据](verification/knowledgemap-bridge-2026-10-17/recovery.json)；各检查数量仅归该报告，不是跨系统同一时刻停写快照。固定SDK及此前停写点仍按[2026-10-10恢复报告](verification/recovery-2026-10-10-final/README.md)保留：`2026-10-10-12-36-17-final-closeout`，对应`0f2255a2`；它不包含新共享业务。更早报告保留对照；目录名含FINAL本身不代表验收通过。

新需求前收尾的结论与批准延期项统一见[文档16](16_验收与测试总表.md)；历史收尾提交不扩大任何恢复点的运行态覆盖范围。

- `legacy-archive-state-2026-10-05`：旧系统**归档现状快照**，包含忽略文件、依赖和符号链接；不是迁移前时间点的重建。
- `legacy-baselines-2026-10-05`：保留下来的历史材料，包括恢复所需固定 SDK 包，不能整目录视为冗余。
- `2026-10-05-pre-consolidation`：整理前的备份与远端推送资料，按其 README 解释范围。
- `2026-10-05-15-56-20-FINAL-quiesced`：历史停写检查点，其原检查是材料、目录和数据库检查，不代表当时已经隔离启动。

`/home/afrangry/kurumi-baselines` 已删除。旧迁移前全量包的忽略文件历史内容没有被逐项证明等价覆盖；当前归档快照无法补回那个历史时点。不得宣称已经重新获得迁移前基线。

Fusion运行态备份、停写与隔离恢复的命令及证明范围见[验收总表](16_验收与测试总表.md#恢复点与证明范围)；旧A/B的原路径复制与切换统一见[旧系统回退](#旧系统回退)。删除任何恢复材料前，先明确保留范围并验证替代材料可恢复；不凭目录名、体积或文件名相同判断冗余。

<a id="旧系统回退归档保留--原路径复制恢复--显式切换"></a>

## 旧系统回退

适用场景：明确选择回退旧A或旧B。执行复制恢复、解屏蔽和启停前须取得本次授权；本文不构成执行许可。归档原件与保留范围见[资产归属](#资产归属)及[备份资产与保留规则](#备份资产与保留规则)。

操作顺序：[选择与复制](#工具scriptsfusionrestore-legacysh) → [重新审计风险](#启动前风险审计) → [只解所选屏蔽](#解除屏蔽的阶段) → [所选系统启动](#旧系统启动与返回fusion) → [返回Fusion](#验收与返回fusion)。

<a id="决定"></a>

### 归档与回退原则

旧系统**不重写内部路径**，日常封存在归档目录。需要回退时复制还原到原路径，再显式切换服务：

| 阶段 | 旧系统在哪 | 新系统 |
|---|---|---|
| 日常运行 | `/home/afrangry/kurumi-archive` | 独立工作，不依赖旧路径 |
| 明确回退 | 复制还原到 `/home/afrangry/.openclaw` 等原路径 | 消费者停止，让位 |
| 防误启动 | 服务屏蔽措施 | —— |

把旧目录长期留在原位会让"新系统是否又偷偷依赖旧路径"难以发现；归档则让它更容易暴露
（`verify-dependencies.mjs` 现在会把任何指向归档树的软链判为失败）。

### 工具：`scripts/fusion/restore-legacy.sh`

```bash
./scripts/fusion/restore-legacy.sh                      # 只检查（默认，不动任何东西）
./scripts/fusion/restore-legacy.sh --restore --system A # 预演：列出将要做什么
./scripts/fusion/restore-legacy.sh --restore --system A --confirm # 真正执行复制还原
```

选择A只复制旧OpenClaw，选择B只复制qq-bridge；默认检查两套，执行必须指定一种。

设计约束（按主人要求）：

1. **默认只检查**：归档、备份、目标路径、服务状态都不改。
2. **执行前停止融合侧消费者**（`kurumi-fusion`、`snowluma-qq`、`snowluma`），
   且**不触碰** `/home/afrangry/.openclaw-fusion`——新系统配置与数据原样保留。
3. **复制而非移动**：归档原件永远保留；**目标已存在就停止，不覆盖不合并**。
4. **检查符号链接、依赖、配置与单元**。单元若仍指向原路径就无需改写路径，但仍须核对本次现场配置。
5. **脚本不启动任何服务。** 启动是独立的显式步骤（见下），
   不把"自动启动验收"绑进恢复脚本。
6. 脚本明确提示：回退恢复的是**封存时的旧系统**，**不会**带回新系统里新增的记忆、提醒、会话。

### 离线还原检查（历史记录，2026-10-05）

精确复制、符号链接逐项分析及数据未变的原检查已移到[阶段记录](archive/documentation-2026-10-23/15_旧系统回退.md#离线还原检查历史记录2026-10-05)。它只证明当时离线复制，不证明真实启动。失效链接须逐个核对指向与原有状态，不能仅按数量判断归档损坏。

### 启动前风险审计

这是本工具最重要的部分：**旧系统有自己的调度，启动后会按它自己的计划执行并可能真实外发。**

每次真正启动旧系统前，都先运行默认只读检查的【6】段重新审计，不沿用历史数值：

| 必查项 | 启动前要求 |
| --- | --- |
| 旧 Cron | 核对 enabled、时区、执行时刻和 delivery；禁用不需要的调度，识别可能补跑或真实外发的任务 |
| 旧提醒 | 核对是否还有活动/待投递项，不把历史终态当当前终态 |
| 外发名单 | 逐项确认私聊和群目标；旧白名单不继承新系统的仅已登记私聊规则 |
| bridge 主动模式 | 核对 `social-v2.paused`，明确是否应暂停后再启用 |
| 单元、路径与依赖 | 核对 EnvironmentFile、WorkingDirectory、ExecStart、依赖和登录状态，不能只确认目录存在 |

2026-10-05 的3个 enabled Cron、群名单和未暂停 bridge 已归档；具体数值不在操作表持续维护。

### 防误启动

日常要求旧消费者停止并保持屏蔽，实际状态须现场检查。**不能只依赖旧路径已移走来阻止启动**，原服务单元仍可能使用以下配置：

- `EnvironmentFile=-/home/afrangry/.openclaw/gateway.systemd.env` 带 `-` 前缀，
  按 systemd 语义**文件缺失会被忽略**；
- `ExecStart` 指向**全局安装**的 `/home/afrangry/.npm-global/lib/node_modules/openclaw/dist/index.js`，
  不因旧运行目录移走而自动失效。

<a id="当前状态2026-10-10-起两个单元已-mask"></a>

#### 日常屏蔽要求

自2026-10-10采用两个旧消费者masked的日常约束；实际状态须现场检查。重新建立屏蔽时先保存单元原件，再操作链接，不能依靠旧路径不存在来防误启动。

```bash
# 用户单元位于 ~/.config/systemd/user/ 时，`systemctl --user mask` 会报错：
#   Failed to mask unit: File .../openclaw-gateway.service already exists.
# 必须先把单元原件移出该目录，再建立指向 /dev/null 的链接（原件已归档）：
U=~/.config/systemd/user
A=/home/afrangry/kurumi-archive/legacy-units   # 单元原件备份
rm -f "$U/openclaw-gateway.service" "$U/qq-bridge.service"
ln -s /dev/null "$U/openclaw-gateway.service"
ln -s /dev/null "$U/qq-bridge.service"
systemctl --user daemon-reload
```

2026-10-10的实际启动失败和mask拒绝回执见[阶段记录](archive/documentation-2026-10-23/15_旧系统回退.md#mask-实施与核验)，属于该时点的验证。

#### 解除屏蔽的阶段

`mask` 只阻止**启动**，不阻止检查：`restore-legacy.sh` 的默认检查模式、归档校验与风险审计都能在
mask 状态下运行。因此顺序是**先检查、后解屏蔽、最后启动**，让屏蔽尽量保持到确需启动前：

1. **检查**（保持 mask）：`./scripts/fusion/restore-legacy.sh`（默认只检查）。
2. **复制还原**（仍可保持 mask）：`--restore --system A|B --confirm`。
3. **处理风险项**：旧 Cron、群白名单、bridge 暂停状态（见上表）。
4. **解屏蔽**（只解所选方案的那一个单元，命令见下）。
5. **启动**所选旧方案；此时融合服务会因 `Conflicts=` 被 systemd 停止，属预期。

**只解除所选方案对应的单元**——旧 A 与旧 B 互斥，同时解除两个会违背“显式 A/B 最小切换”：

```bash
U=~/.config/systemd/user; A=/home/afrangry/kurumi-archive/legacy-units

# 选旧 A（旧 OpenClaw + 自带 qqbot 频道）时，只恢复这一个：
systemctl --user unmask openclaw-gateway.service
cp --remove-destination "$A/openclaw-gateway.service" "$U/openclaw-gateway.service"
systemctl --user daemon-reload

# 选旧 B（DSH + Snowluma + qq-bridge）时，只恢复这一个：
systemctl --user unmask qq-bridge.service
cp --remove-destination "$A/qq-bridge.service" "$U/qq-bridge.service"
systemctl --user daemon-reload
```

解除屏蔽的检查点：

- `systemctl --user unmask` **只删除 `/dev/null` 符号链接，不会把单元原件放回来**；原件在
  `/home/afrangry/kurumi-archive/legacy-units/`，必须手工拷回。
- 不能用 `cp -p`：目标仍是符号链接时它会**跟随链接把内容写进 `/dev/null`**，必须用 `--remove-destination`。
- 解除后确认：`systemctl --user is-enabled <unit>` 应不再是 `masked`；**未选的那一个应保持 `masked`**。
- `restore-legacy.sh --restore --system A|B` 现在也会打印与上面一致的、只针对所选单元的步骤。

<a id="-启动任一旧单元都会先停掉融合服务"></a>

#### 旧单元与融合服务的互斥关系

`kurumi-fusion.service` 声明了 `Conflicts=qq-bridge.service openclaw-gateway.service`，
而 systemd 的 `Conflicts=` 是**双向**的：启动旧单元会让 systemd 先停止与之冲突的 `kurumi-fusion`。
2026-10-10 实测复现（启动旧单元同一秒内 `kurumi-fusion` 收到 SIGTERM 并干净退出）。

回退会使融合助手离线，执行前须取得本次启停授权并明确中断范围。按顺序先显式停融合侧消费者 → 复制还原旧系统 → 处理风险项 → 仅解除所选单元屏蔽 → 启动所选旧方案；返回时先停止旧消费者，再恢复融合服务。

<a id="真实启动验收未执行独立于上面的离线检查"></a>

### 旧系统启动与返回Fusion

以下是真实回退的操作步骤，**旧A/B完整启动与整套旧B状态恢复仍未验收**。已有离线复制、防误启动与互斥验证不能替代完整启动验收；执行与外发分别按本次授权记录。

<a id="-先分清旧-a-与旧-b--它们是两套不同方案回退只能选一个"></a>

#### 旧A与旧B的选择

旧A与旧B是互斥的两条恢复路径：

| | 旧 A | 旧 B |
|---|---|---|
| 助手 | 旧 OpenClaw（`openclaw-gateway`） | DSH + `qq-bridge` |
| QQ 传输 | OpenClaw **自带 `qqbot` 频道** | **SnowLuma（3083/3084）→ qq-bridge** |
| 需要启动 | `openclaw-gateway.service` | `snowluma`、`snowluma-qq`、`qq-bridge`、DSH |
| 不需要 | SnowLuma / qq-bridge | openclaw-gateway |

因此：

- 启动 `openclaw-gateway` **不需要** qq-bridge，也不经过 SnowLuma；
- 启动 `qq-bridge` **需要** SnowLuma 在跑 —— 而"离线还原"那一步为了腾出 QQ 消费者
  已经把 SnowLuma 停了，所以走旧 B 时要把它重新起来；
- **不要一次启动两个旧助手**，那会出现两套逻辑抢同一个 QQ 账号。

#### 回退 A（旧 OpenClaw + 自带 qqbot 频道）

```bash
# 前提：融合侧消费者已停；风险项已处理；只向本人验收
systemctl --user start openclaw-gateway.service
journalctl --user -u openclaw-gateway -f
# 结束
systemctl --user stop openclaw-gateway.service
```

#### 回退 B（DSH + SnowLuma + qq-bridge）

```bash
# 前提：同上；且这一步必须把传输一起起来
systemctl --user start snowluma.service snowluma-qq.service
sudo systemctl start dsh-web.service            # 需要 sudo
systemctl --user start qq-bridge.service
journalctl --user -u snowluma -u snowluma-qq -u qq-bridge -f
# 结束
systemctl --user stop qq-bridge.service snowluma-qq.service snowluma.service
```

> `dsh-web.service`承载DSH网页。若通过DSH发起本次操作，启停该服务会影响对应网页会话。

<a id="两者的共同要求"></a>

#### 验收与返回Fusion

1. 重新核对并处理[启动前风险审计](#启动前风险审计)中的全部项目，包括本次仍有效的天气简报及其他旧Cron，不沿用历史执行时刻。
2. 确认**同一时刻只有一个 QQ 消费者**：选 A 或选 B，融合侧三个服务保持停止。
3. 验收**只针对本人**，不向群或其他人群发。
4. 退回融合系统：先停掉所选旧方案的全部单元，再
   ```bash
   systemctl --user start kurumi-fusion.service snowluma-qq.service snowluma.service
   ```

> 历史启动观察中，`snowluma-qq`完成QQ客户端热更新与登录约需2分钟，期间3083/3084可能尚未监听，health会报告频道未连接。以本次日志和实际登录结果判断；持续未恢复时继续排查，不能仅凭等待时长认定正常。

### 回退会带回什么、不会带回什么

**会带回**：封存时点的旧程序、旧配置、旧凭据、旧数据库（旧提醒与旧调度状态）、旧会话记录。

**不会带回**：你在新系统 `/home/afrangry/.openclaw-fusion` 里新增的**记忆、提醒、会话、配置**。
两套数据互不同步。若只想找回某条旧记忆或某条旧提醒，应当**单独从归档里读**，
而不是整机回退。

### 三套系统的边界

| | 旧A | 旧B | 新系统 |
| --- | --- | --- | --- |
| 宿主 | OpenClaw | DSH | OpenClaw |
| QQ通道 | qqbot | SnowLuma+qq-bridge | SnowLuma+kurumi-qq |
| 状态 | 原.openclaw归档 | bridge归档及DSH独立状态 | .openclaw-fusion |

旧B与新系统共用SnowLuma/QQ登录。旧A另走qqbot；无论选择哪套，都应明确停止另一套消费者。旧B回退不等于回退DSH的版本与/var/lib/dsh/.dsh数据，该部分仍是当前安装；若要求整个旧B某一时刻的状态，需要相应DSH快照。

## 尚待处理

- 旧 bridge 个人远端在原检查中不可访问，本轮未重新联网核对；本地 Git、封存标签、bundle 与私有全量包继续保留。
- 旧系统真实启动与外发需按[旧系统回退](#旧系统回退)单独验收。旧 B 的 bridge 恢复不等于 DSH 版本和数据整体回到封存时点。
- DSH 的旧 `node_modules.0.1.5-rc.3`、桌面草稿和另一份 `.dsh` 数据尚未证明可安全删除，继续保留。

返回[文档入口](README.md)。
