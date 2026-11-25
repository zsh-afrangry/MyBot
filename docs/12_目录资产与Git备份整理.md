状态：已完成（2026-11-19；仅 Fusion 成套隔离恢复，不含真实 QQ 登录与独立项目）

# 系统资产、备份与回退

本文规定哪些资产放在哪里、恢复点包含什么、怎样制作和验证恢复点。恢复点只含 Fusion 自身材料，KnowledgeMap 和 DSH 是独立项目，不在范围内。

## 功能

### 资产归属

| 资产 | 位置 | 边界 |
| --- | --- | --- |
| 日常源码与配置意图 | `/home/afrangry/kurumi-fusion` | 唯一的日常 Fusion 仓库；当前分支、未提交改动和远端差异用 Git 查询 |
| 私有运行状态 | `/home/afrangry/.openclaw-fusion` | 身份、凭据、人格投影、会话、记忆、SQLite、产物。不建运行根 Git |
| 私密备份 | `/home/afrangry/kurumi-backups` | 恢复点、共享工件、唯一源码历史。目录 700，文件 600 |
| 编码试点 | `/home/afrangry/.local/share/kurumi-coding-pilot-20261029` | 普通文件写入的窄边界，Fusion 拥有，纳入恢复范围，不是第二个开发仓库 |
| OpenClaw 安装 | `/home/afrangry/.npm-global/lib/node_modules/openclaw` | 固定版本的第三方内核，不改它的源码 |
| 外部项目 | KnowledgeMap 业务 API、DeepSeek Harness（DSH） | 独立项目。Fusion 只保留自己的接口配置、专用凭据和控制状态，不采集它们的源码、数据库、安装或全局认证 |
| QQ 传输 | SnowLuma、QQ 及登录配置 | 实际运行依赖。隔离恢复用模拟 OneBot，不恢复真实 QQ 登录 |

内核批准版本和 Node 范围只在 `config/openclaw-release.json` 写一次，启动、依赖链接、依赖校验和备份都读它。执行写入围栏的原生包版本在 `config/exec-fence-release.json`，由 `scripts/fusion/install-exec-fence.mjs` 校验并导入 `.openclaw-fusion/tools/node-addon-system-linux-x64`。

### 恢复点包含什么

新恢复点用格式 v3，清单里标记 `scope: fusion-only`。必须包含：

- 源码历史（Git bundle）和未提交改动（补丁）。
- 受管配置和私有配置。
- 全部保留的 SQLite 的一致快照（不限目录层数，识别 `.sqlite`/`.db`，排除明确可重建的缓存）。
- 人格、身份、业务控制状态、编码试点。
- 指定版本的工件：OpenClaw 内核、论文 Python 环境、执行围栏原生包。按内容寻址存在共享的 `artifacts/` 里，每个点登记版本、源码树指纹和压缩包 SHA256，重复的点复用同一份工件。未验证的工件不算可恢复。

不包含：可重建依赖、诊断日志及其轮转文件、临时捕获、KnowledgeMap 源码和 MySQL、DSH 安装和全局认证、`dsh-web` 服务单元，以及用户额外登记的下载/文档目录。

没有 `scope` 标记的旧 v3 点保持原契约，恢复器仍接受其中的 DSH 工件。不改旧点来假装转换范围。

## 接口

在 `/home/afrangry/kurumi-fusion` 执行。制作和验证恢复点需要用户授权。

```bash
node scripts/fusion/backup-state.mjs --label <标签> --quiesce      # 停写快照
node scripts/fusion/restore-verify.mjs --backup /home/afrangry/kurumi-backups/<目录>
node scripts/fusion/backup-retention.mjs --record /tmp/<恢复目标>/verification.json  # 登记 VERIFIED，预览保留计划
node scripts/fusion/backup-retention.mjs --apply                                    # 按当前计划淘汰，另行授权
```

- `--quiesce` 只停止原本在运行的 Fusion，完成、出错或收到可捕获的中断后恢复；原本停着的保持停止。期间不能另起 Gateway，也不能手工改状态。
- `--record` 仅接受通过的 `isolated-gateway` 回执，按 `MANIFEST.sha256` 和 `EXPECTED.json` 的哈希绑定至恢复点，写入 `VERIFIED.json` 后打印淘汰预览。

## 原理

**采集。** 先写 `INCOMPLETE.json` 并持有 `.backup.lock`，全部收集成功且服务恢复后才移除标记。SIGKILL 或断电无法捕获：先确认锁里的 PID 已不存在，检查并按需恢复服务，再处理陈旧的锁。不能删除不完整标记来伪装成功。已跟踪的修改用 `git --binary --full-index` 生成补丁，未跟踪且未忽略的文件单独打 tar，不保留原暂存区分类。

**主动唤醒（N3）的库。** 配置启用 N3 时，`state/proactive/proactive.sqlite` 是必需资产，缺失则采集失败。禁用或回退代码不删除它，也不把 unknown 回执重建成可重试任务。隔离恢复器关闭副本的 N3 开关，不让恢复验证触发自主模型调用或外发。

**保留。** 滚动保留最近两个经过隔离恢复的点。新点完整通过并登记 VERIFIED 之后，才淘汰被替代的点，再删除不再被任何保留点或未完成点引用且元数据和 SHA256 均有效的托管工件。未知文件不自动删除，采集锁存在时拒绝清理。

**隔离恢复。** `restore-verify.mjs` 只接受新建的规范 `/tmp/` 目标，拒绝已有目录和链接，不碰生产。步骤：

1. 验 manifest、Git bundle、补丁、数据库完整性。
2. 按 EXPECTED 里的版本和 SHA256 还原内核、Python 环境和围栏原生包，从锁文件重装依赖，不借用全局安装。
3. 所有路径（workspace、token、日志、runner、项目根）都改写到目标目录内，写入假凭据，禁止真实 QQ、Cron 和共享业务 API。
4. 在 Bubblewrap 里（文件系统、网络、PID 隔离，生产 home 和服务总线不可见）启动 Gateway 和模拟 OneBot，执行探针。编码探针用真实的 Linux 辅助程序检查目录内可写、目录外拒绝。
5. 恢复副本移除原生 exec 的 `additionalRoots`，工作目录重置到恢复副本的试点，避免沿用真实资料目录的写入授权。

`--skip-deps` 只做材料检查。默认通过只表示隔离 Gateway 加模拟传输可以运行。不要在主机上直接运行恢复副本的 `run-gateway.mjs`。

**升级演练。** `restore-verify.mjs --adapt-source <本地 bundle> --adapt-sdk <工件 tar.gz>`（两项必须同时给）在隔离副本里替换代码和内核并迁移其数据库，结果标为 `upgrade-rehearsal`，不能登记成恢复点。演练按新源码生成隔离配置，保留已知的旧停用心跳供 [Doctor 迁移](https://docs.openclaw.ai/gateway/heartbeat)，按新锁文件安装外部插件，在无生产路径和网络的命名空间里运行官方 `doctor --fix`；启动前核对 agent schema、权限、插件意图和原有定时任务，新任务须保持停用。其他旧心跳配置需要单独审查。

**生产升级顺序。** 先备好回退状态，停 Fusion，替换已验证的工件和源码并安装锁定的 provider；保留旧配置运行官方迁移，核对停用心跳和原有定时任务后，同步新受管配置并启动服务。升级若迁移了数据库，回退必须同时恢复对应旧版内核和旧状态，不能把旧二进制接到升级后的库上。官方 Doctor 产生的配置 bak、迁移原件、update-captures 只是本次升级的临时回退材料，确认迁移完成并有新的恢复点后才清理，不删除未完成迁移或来源不明的材料。配置同步覆盖备份根 `.working/config-sync/openclaw.before.json` 的待验证预像，确认生效后由操作者清理。宿主的 `openclaw.json.last-good` 有消费者，保留。

**Git。** 日常在 kurumi-fusion 里看 `git status --short`、`git log -1`、`git worktree list`。配置、人格、依赖和服务健康检查只证明部署对齐，不证明已提交或推送。远端写入需要用户明确授权。读取远端时不要输出带凭据的 URL。`git ls-remote` 只证明远端可读。

### 旧系统回退

旧 A/B 整体恢复不再支持，当前只保证上面范围内的 Fusion 成套恢复。旧消费者（`qq-bridge.service`、`openclaw-gateway.service`）保持屏蔽，不与 Fusion 同时运行。恢复前先停掉当前写入方，隔离验证时禁止 QQ、邮件等真实外发。

## 限制与已知问题

- 恢复点不是跨系统同一时刻的快照。KnowledgeMap 的 MySQL 另由业务端备份，Fusion 脚本不备份它；共享业务的配对备份见[文档23](23_KnowledgeMap业务能力桥接.md)。
- 隔离恢复不证明真实模型、真实 QQ 登录或独立 DSH 能恢复。使用编码能力还需要 DSH 项目本身可用；恢复验证里 DSH 缺失时编码策略必须拒绝执行，其余策略用不执行的 `/usr/bin/false` 作可用性夹具检查。
- 普通文件管理登记的下载/文档目录不在恢复范围，对这些文件的改动无法靠恢复点或 Git 撤销。范围见[文档28](28_本机编码工具委托与实验任务.md)。
- 当前生产没有启用 N3。已有恢复点不含 N3 状态；启用前要制作并验证匹配的新恢复点。
- 最新登记点 `2026-11-18-17-45-34-post-doc-cleanup` 对应源码 `debe707`，通过 26 项 Fusion 隔离恢复检查。当前保留该点和 R8（`9b98c9c`）。保留名单以 `backup-retention.mjs` 的只读输出为准。
- 旧时点（迁移前的 `kurumi-baselines`）已经删除，旧的忽略文件没有逐项证明被等价覆盖，无法补回。
- 备份根下五份 `knowledgemap-*` 目录是 KnowledgeMap 的独立备份，不计入 Fusion 恢复点，也不被自动保留清理选中。SnowLuma 目录下的旧备份属于 DSH 历史资料，不由 Fusion 处理。
- 清单里的符号链接以 `symlink:<链接目标>` 的 SHA256 记录，用 `restore-verify.mjs` 核验，普通 `sha256sum -c` 会跟随链接，不能代替。
- 整个备份根连同 `artifacts/` 一起搬移才具备完整的恢复输入，单独复制一个点目录不够。

## 如何验证

```bash
node scripts/fusion/backup-retention.mjs             # 只预览保留计划
/usr/bin/node --test scripts/fusion/test/recovery.test.mjs scripts/fusion/test/backup-layout.test.mjs scripts/fusion/test/backup-retention.test.mjs
git status --short --branch
git log --oneline main..HEAD                         # 当前分支与 main 的差异，不代表已推送
```

保留计划会校验 VERIFIED 与清单哈希；文件存在不能代替完整隔离恢复。需要制作/复验新点时按上面的授权接口执行。

## 进行中：OpenClaw 2026.11.8 升级

- 旧版停用心跳向新版自动化任务迁移的合成隔离样本已验证。
- 原版 2026.11.8 的 `sessions.reset` 会把前台回合自身的取消误记为来源清理失败。用 `node scripts/fusion/patch-openclaw.mjs --sdk <暂存的绝对 SDK 路径>` 构建升级工件。补丁只接受匹配的原版文件，按回合自身的取消信号识别预期取消。启动、依赖、备份与恢复检查验证补丁后的文件哈希。
- 在升级工作树运行 `node chatbot/tests/proactive/acceptance-runtime-host.mjs --out "$PWD/test-output/openclaw-upgrade/proactive-runtime.json"`。原版在并发重置处失败，补丁版 15 项隔离验收通过，覆盖重置后接收新消息及前台结束后的重置。输出路径须未被占用。
- 2026-11-25 用既有非停写备份和源码 `cf65f4e` 完成升级恢复演练：32 项通过，含官方迁移、任务状态和隔离网关启动；该备份不能作为生产回退点。生产升级及停写恢复点仍需按开发指引单独授权。
