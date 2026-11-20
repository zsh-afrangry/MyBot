状态：已完成（2026-11-21，统一启停、开机策略 A、受控整套复验与 Cron 健康判定收口）

# 运行维护

本文说明目录和服务怎么分工，日常怎么检查、同步、启停，开发时用哪些离线测试，以及升级依赖的做法。系统组成和分层见[文档1](1_总体架构与设计原则.md)。配置意图和运行事实的分工见[配置契约](../config/README.md)。

## 功能

### 当前资产

| 职责 | 路径或状态 |
| --- | --- |
| 源码主仓库 | `/home/afrangry/kurumi-fusion`，保存源码和配置意图 |
| 私有运行状态 | `/home/afrangry/.openclaw-fusion`，凭据、会话、数据库、任务状态 |
| 共享业务 | `/home/afrangry/repository` 的 KnowledgeMap MySQL；`knowledgemap-assistant.service` 在 loopback 3086 提供 API；网站由 `knowledgemap-web.service` 在 8020 提供，Tailscale 8443 转发 |
| QQ 传输 | `/home/afrangry/snowluma`，由 `snowluma.service`、`snowluma-qq.service` 管理 |
| DSH | `/opt/deepseek-harness`，`dsh-web.service` 在 3080，不消费 QQ |
| 管理台 | `~/.local/share/kurumi-admin-web/<版本哈希>/`，`kurumi-admin-web.service` 在 3085 |
| 恢复材料 | `/home/afrangry/kurumi-backups`，见[文档12](12_目录资产与Git备份整理.md) |

融合助手不依赖 `/home/afrangry/.openclaw`。KnowledgeMap 只保留 `/home/afrangry/repository` 一份事实源，桌面旧副本已退役。

### 端口登记

唯一事实源是 [`config/stack.json`](../config/stack.json)，新增端口先改清单并通过唯一性校验，再改本文；`kurumi-stack status`/`doctor` 会检查实际监听与声明是否一致。

| 端口 | 组件 | 说明 |
| --- | --- | --- |
| 3080 | dsh | DSH Web；Tailscale Serve 443 转发 |
| 3082 / 3083 / 3084 | snowluma | WebUI / OneBot HTTP / OneBot WS（OneBot 是 SnowLuma 的接口，不是独立进程） |
| 3085 | admin-web | Fusion 管理台；旧文档写的 KnowledgeMap 开发后端也已停用，不再占用该端口 |
| 3086 | km-api | KnowledgeMap 助手业务 API |
| 8020 | km-web | KnowledgeMap 网站；Tailscale Serve 8443 转发 |
| 18890 | fusion | OpenClaw Gateway |
| 3306 / 27017 | mysql / mongodb | 外部 MySQL / KnowledgeMap MongoDB |
| 3081 | — | 旧 `qq-bridge` 控制台已停用，空置 |

## 接口

### 服务

统一管理清单是 [`config/stack.json`](../config/stack.json)：9 个组件，`kind` 区分系统单元与用户单元，`order` 决定启动顺序（停止反向）。清单同时登记端口、探针、启动超时、是否需要图形会话和外部依赖。`testIngress=false`：验收入口关闭，日常不运行真实外发的测试脚本。

- `kurumi-fusion.service`（18890）是默认助手；模板在 `scripts/fusion/systemd/`，`Wants=` SnowLuma 两单元，`Conflicts=` 旧消费者。
- `knowledgemap-assistant.service`（3086）与 `knowledgemap-web.service`（8020，Tailscale 8443，Mongo 由 `Wants=` 拉起）都从 `/home/afrangry/repository` 运行。
- `snowluma.service` + `snowluma-qq.service` 提供 QQ 传输（3082/3083/3084）；QQ 客户端需要图形会话 `:0`。
- `dsh-web.service`（3080）独立运行、不消费 QQ；`kurumi-admin-web.service`（3085）是管理台安装副本，仓库改动后用 `install-admin-web.mjs` 重装。
- `qq-bridge.service`、`openclaw-gateway.service` 是旧消费者，保持屏蔽。

开机策略是 `bootPolicy: auto`：所有受管用户单元（含 MongoDB、KnowledgeMap 网站）和 DSH 都应在开机后自启，`kurumi-stack doctor` 检查实际状态。运行状态以 `kurumi-stack status` 为统一视图；QQ、Gateway、Cron、数据库的语义健康仍以 `health.mjs` 为准，`status` 会内嵌它的摘要。

### 日常操作

在 `/home/afrangry/kurumi-fusion` 执行，按当前任务选一组。跨模块链路还原见[文档18](18_跨模块链路日志查询.md)。

#### 只读检查（日常自检）

```bash
kurumi-stack status                       # 统一状态表（含 health.mjs 摘要）
kurumi-stack doctor                       # 单元、开机策略、部署漂移、转发、端口冲突
node scripts/fusion/health.mjs            # 运行连接、服务、数据库、Cron、旧消费者、testIngress
node scripts/fusion/verify-dependencies.mjs   # 依赖与批准版本
node scripts/fusion/sync-config.mjs       # 配置意图与运行配置是否一致（默认只读）
node scripts/fusion/sync-persona.mjs      # 人格投影是否一致（默认只读）
systemctl --user status kurumi-fusion.service snowluma.service snowluma-qq.service
journalctl --user -u kurumi-fusion.service -n 100 --no-pager
```

这些检查只证明检查时的运行与对齐状态，不证明 Git 已提交推送，也不证明人格体验或业务端到端成功。`health.mjs` 不发 QQ、不创建任务；已启用 Cron 的 `lastRunStatus=error` 以及 `not-delivered`/`unknown` 送达会计入 `issues`，`skipped` 和 `not-requested` 视为有意行为。QQ 断线先看 SnowLuma/QQ 服务和在线状态，不重启旧 bridge。当前配置的滚动 24 小时 500 条额度按发送预留计数，含失败和未知回执，不能靠清空历史绕过。

#### 配置同步

```bash
node scripts/fusion/sync-config.mjs --diff
node scripts/fusion/sync-persona.mjs --diff
# 确认属于本次已授权的部署后：
node scripts/fusion/sync-config.mjs --apply
node scripts/fusion/sync-persona.mjs --apply
```

运行配置变更后要重启服务。只改四份受管人格文件时，宿主下一回合加载。身份登记有工作区准备顺序，见[文档24](24_统一身份与权限管理.md)。受管键、删除语义和凭据入口见[配置契约](../config/README.md)。行为模板 `scripts/fusion/templates/AGENTS.md` 改后按这个流程投影到运行 workspace。

#### 统一启停（kurumi-stack）

入口：`~/.local/bin/kurumi-stack`（仓库源 `scripts/fusion/stack.mjs`），桌面「Kurumi 栈」图标等价于 `kurumi-stack start`。调试单个单元仍可用 `systemctl --user restart kurumi-fusion.service`；`run-gateway.mjs` 是前台入口，日常不与 systemd 并开；`install-service.mjs` 只用于明确的旧助手切换。安装（每台机器一次）：

```bash
kurumi-stack install            # 安装命令/桌面快捷方式、启用用户单元自启、更新 /opt 启动器
kurumi-stack install --no-sudo  # 只做用户级步骤，打印待执行的 sudo 命令
```

`install` 的系统级步骤需要 sudo 密码：`systemctl enable dsh-web.service`，以及把仓库里的 `Start-DSH.sh`/`Stop-DSH.sh` 部署到 `/opt/deepseek-harness/`。脚本不保存密码；没有终端时只打印命令，不会卡住。

日常命令：

```bash
kurumi-stack status          # 服务、端口、自启、QQ 在线一张表
kurumi-stack start           # 收敛：健康组件只检查，异常退出/未运行的才拉起
kurumi-stack start --repair  # 允许重启“运行中但探针异常”的组件
kurumi-stack stop            # 默认停管理台、Fusion、DSH；保留 QQ/SnowLuma/KnowledgeMap
kurumi-stack stop --all      # 停整套（保留 MySQL 外部依赖；KM 网站停后 8443 暂时指向关闭端口）
kurumi-stack stop --dry-run  # 预览停止顺序与各组件状态，不执行
kurumi-stack start --dry-run # 预览本次会拉起哪些组件
kurumi-stack restart <组件>   # 显式重启单个组件
kurumi-stack logs <组件> [-f] # journalctl；同时提示 SnowLuma/Fusion 的文件日志位置
kurumi-stack doctor          # 只读诊断：单元、开机策略、部署漂移、转发、端口冲突
```

`/opt/deepseek-harness/Start-DSH.sh` 和 `Stop-DSH.sh` 是兼容入口的薄 wrapper，分别等价于 `kurumi-stack start` / `stop`。

`start` 的边界（不是 restart-all）：

| 组件状态 | `start` 的行为 |
| --- | --- |
| active 且端口/探针正常 | 只检查，不重启 |
| active 但探针异常 | 先等宽限时间；仍异常只报告，不自动重启（`--repair` 或 `restart` 才重启） |
| failed（异常退出） | `reset-failed` 后拉起 |
| inactive（干净停止） | 拉起（点击启动即表示要求它运行） |
| activating / deactivating | 等待到稳定状态，不重复启动 |
| 外部依赖（MySQL） | 只检查，永不启停 |
| 无图形会话时的 SnowLuma/QQ | 不启动，报告需要 `:0` |
| 未运行但端口被未知进程占用 | 拒绝启动该组件，避免双实例 |

退出码：`0` = 所有组件健康且语义自检通过；`1` = 有失败、降级或语义自检未通过；`2` = 用法/清单错误。`start` 结束会打印本机/Tailscale 入口（DSH、KnowledgeMap、SnowLuma WebUI、管理台），只在终端输出，不写入日志。

`stop` 先确认 sudo 可用（DSH 是系统单元）；无终端或密码不可用时整次停止不执行，避免只停一半。默认 `stop` 之后 QQ 通道仍在线、KnowledgeMap 网站仍在，消息可以排队；`--all` 才是整套停机。

`snowluma-qq` 重启后须等客户端更新、登录和协议会话恢复，耗时无固定保证；期间 3083/3084 可能不监听。日常重启 Fusion 或 DSH 不会要求重启已运行的 QQ 服务。

`start` 会等待各组件的探针就绪，再跑一次 `health.mjs`；重复执行是幂等的，第二次不会改变健康组件的启动时间。

#### 日常使用速查

| 场景 | 命令 |
| --- | --- |
| 看一眼是否正常 | `kurumi-stack status`（全好时退出码 0） |
| 点一下自检/拉起（桌面图标同此） | `kurumi-stack start` |
| 运行中但怀疑异常 | `kurumi-stack doctor` → `kurumi-stack restart <组件>` |
| 允许重启运行中但探针异常的 | `kurumi-stack start --repair` |
| 只操作指定组件 | `kurumi-stack start --only=fusion,admin-web` |
| 临时下班（消息可排队） | `kurumi-stack stop` |
| 整套停机维护 | `kurumi-stack stop --all` |
| 看日志 | `kurumi-stack logs <组件> [-f]` |
| 改过启动器后重新部署 | `kurumi-stack install` |

本机入口（`start` 在终端结束时也会打印；DSH token 和 KnowledgeMap 口令随之输出）：

| 服务 | 入口 |
| --- | --- |
| DSH | `http://127.0.0.1:3080/`（带 token 的链接以 `start` 输出为准） |
| KnowledgeMap | `http://127.0.0.1:8020/`（口令在 `~/.local/state/knowledgemap-launcher/web.json`） |
| SnowLuma WebUI | `http://127.0.0.1:3082/` |
| Fusion 管理台 | `http://127.0.0.1:3085/`（口令：`cat ~/.local/state/kurumi-admin-web/access-key`） |

只读命令（`status`、`doctor`、`logs`、`--dry-run`）可直接运行；`start`、`stop`、`restart`、`install` 会改变服务或系统状态，助手代跑前需要主人授权，见 [AGENTS.md](../AGENTS.md#需要单独授权的操作)。

## 原理

### 统一管理（清单 + 收敛式启停）

systemd 仍是唯一 supervisor，不引入 Docker 或 pm2。`config/stack.json` 是组件、端口、探针、启动顺序和开机策略的唯一声明；`scripts/fusion/stack.mjs` 只做编排，不复制服务逻辑。判断组件状态时组合四种事实：`systemctl show` 的 ActiveState/UnitFileState、`ss` 的实际监听端口、回环 HTTP/TCP 探针、`health.mjs` 的语义检查。

`start` 是收敛而不是 restart-all：健康组件只检查；failed 的 `reset-failed` 后拉起；inactive 的拉起；运行中但探针异常的只报告，`--repair` 才重启。这样避免“点一下启动把正在初始化或降级的组件全部打断”。只通过 systemd 操作进程，不 kill；单元未运行而端口已被占用时拒绝启动，避免双实例；外部 MySQL 只检查。sudo 只在真实终端请求一次，不保存密码；无终端时转为待执行命令。

开机策略 A：清单里 `boot.enabled` 的受管单元都要 enable，DSH 也不例外；`doctor` 对照清单与实际 UnitFileState，因此漏启用会被发现。`install` 负责安装命令/桌面快捷方式和用户单元；系统级三步（启用 DSH、部署 `/opt` 启动器）在终端里由 sudo 完成。

KnowledgeMap 只保留 `/home/afrangry/repository` 为事实源；启动器改为写持久用户单元（不再 `systemd-run` 临时单元），已存在的 8443 转发在指向本服务时保留，避免每次启动都请求 sudo。迁移用一次 `--adopt`。管理台是独立安装副本，`doctor` 对比安装版本与 main 的哈希；不一致时提示重新安装，不自动降级。

### 诊断日志与保留

宿主日志单文件按 10MiB 轮转；诊断清理在启动时和运行中每 6 小时执行，清理对象是 `logs/` 下的普通文件及 `runtime.1.log`、`runtime.2.log`。默认清理超过 7 天或超出 60 MiB 总预算的副本，预算计入活动 `runtime.log`，会话和业务库不参与。插件捕获是运行代码的临时副本，Gateway 退出后清理，不作为恢复数据。配置同步的待验证回退副本见[文档12](12_目录资产与Git备份整理.md#原理)。

### 固定依赖与升级

| 项目 | 约束与入口 |
| --- | --- |
| 宿主和连接库 | 版本由 `config/openclaw-release.json` 指定（OpenClaw 2026.11.1、`ws` 8.22.0），用 `verify-dependencies.mjs` 检查。仓库的 `node_modules/openclaw` 链接到全局安装，全局升级会同时替换它 |
| 全局升级 | 不直接运行 `openclaw update`。先更新版本契约和锁文件并验证。`run-gateway.mjs` 把非自身请求的子进程退出（含 0）视为失败，systemd 重试到上限后停在 failed，用 `systemctl --user --failed` 检查 |
| 交互保护 | `scripts/fusion/openclaw-update-guard.sh` 可由 `~/.bashrc` 加载，拦截普通 `openclaw update`，放行 `update status`、`--dry-run`、`--help`。显式升级用 `KURUMI_ALLOW_OPENCLAW_UPDATE=1`。它拦不住 `npm i -g`、绝对路径或 `command openclaw update` |
| 服务模板 | 源码模板和已安装单元分别维护，同步后执行 `systemctl --user daemon-reload` |
| 依赖安装 | 领域包按各自 lockfile `npm ci`；第三方 Tavily 由 `install-plugins.mjs` 和 `config/plugins.package-lock.json` 管理 |
| 主机工具 | Git、Bubblewrap、Poppler、prlimit |

升级顺序：先更新版本契约和锁文件，通过依赖检查、构建、领域回归和隔离恢复验证，再部署。恢复和升级演练见[文档12](12_目录资产与Git备份整理.md)。2026.11.1 的 DeepSeek 由独立官方插件 `@openclaw/deepseek-provider` 提供，版本锁在受管插件清单里，显式列入 allow/load/entries；数据库从 24 迁到 27 以及共享库迁移必须停写后运行官方 doctor，只替换 npm 包完成不了。

仅当当前数据库与批准版本匹配而全局宿主被意外替换时，才用系统 Node 重装批准版本。这会改全局安装，要作为已授权的修复步骤执行：

```bash
PATH=/usr/bin:/bin /usr/bin/npm i -g --prefix /home/afrangry/.npm-global openclaw@2026.11.1
```

### QQ 图片与引用

**图片入站。** `chatbot/plugins/kurumi-qq/src/media.js` 的 `stageImage` 只接受 QQ CDN 白名单里的精确主机（含 `multimedia.nt.qq.com.cn` 和 `multimedia.nt.qq.com`）或已暂存的本地图片，要求 HTTPS、无 URL 凭据、无非默认端口、禁重定向、不超过 8MiB、类型为图片。远程图片和表情共用它，下载走宿主 `fetchWithSsrFGuard` 的 `trusted_env_proxy` 模式，对本次白名单主机使用受信代理策略，15 秒超时。响应由 `saveResponseMedia` 做媒体大小检查并暂存。

图片加载失败时，先查频道暂存和附件状态，再查模型实际收到的媒体，不能只凭回复归因于视觉模型。识图细节和建议可能出错。

**私聊引用。** 配置 `replyToMode: off`（`config/runtime.config.json`）：普通回复不引用当前入站，只有模型为了回复较早的消息或区分话题而主动输出 SDK 显式引用标签时才保留引用。多段回复只有第一段带引用，状态和进度消息不自动引用。不从正文里的 CQ 字样或外部资料推断可信目标。

限制：未覆盖 WebP/GIF 入站、通用发图和 E7 图片。完整会话归档的保留、导出、恢复策略尚未确定，原生 `/new` 不等同于这个能力。`/new` 和记忆连续性见[文档25](25_人格、记忆与会话连续性.md)。

已有本人 QQ 的 JPG 入站与 PNG 表情外发验收；默认不引用与按需显式引用有隔离宿主证据，客户端视觉仍待真人观察。

### 代码项目与后台任务

- 当前没有通过项目注册表开放的编码项目。`projects.json` 保留空结构供插件兼容读取，日常编码走[文档28](28_本机编码工具委托与实验任务.md)的 `dsh-pilot` 专用工具。`register-project.mjs` 是操作员显式登记/移除的工具，不能绕过 `codeEnabled=false`。
- `kurumi_task` 只保留研究任务和历史任务的查询、取消。长篇论文用 `kind=research` 进入后台，来源 PDF 在 `research-cache`，报告在 `research-workspace/reports`，按 URL、哈希、下载时间区分版本。未提取、未看图、未复现实验的部分，报告里必须说明。
- 论文翻译的安装入口是 `chatbot/scripts/setup-paper-translation.sh`，凭据导入是 `chatbot/scripts/import-paper-credentials.mjs`，都由操作者执行。细节见[文档22](22_论文PDF翻译与文件投递.md)。
- 提醒列表用 `chatbot/scripts/reminder-list.mjs`，规则见[文档23](23_KnowledgeMap业务能力桥接.md)。一次性提醒由固定 runner 到点触发，投递说明依赖模型生成。每日天气播报以主人登记的周期任务为准。

## 限制与已知问题

- 旧 `project-fusion` 后台副本已结束使用，源码只在 kurumi-fusion 单线维护。恢复旧代码任务模式要另行确认需求和授权。
- 共享业务的 MySQL 不在 Fusion 备份里，见[文档12](12_目录资产与Git备份整理.md)和[文档23](23_KnowledgeMap业务能力桥接.md)。
- **QQ 客户端异常退出后，协议会话长时间不恢复（低优先级，未立项修复）。** QQ 客户端崩溃后，systemd 拉起进程到 OneBot 恢复监听曾相隔约两小时二十五分。Fusion 在端口不可用期间退避重连，重连间隙的入站可能丢失，Cron 投递可能失败。崩溃与会话延迟的根因均待查，进程状态需要结合 OneBot 在线状态和真实往返判断。复查用 SnowLuma 和 Fusion 的日志。
- KnowledgeMap 桌面旧副本已退役（移入回收站）；网站与助手 API 都跑 `/home/afrangry/repository` 同一份代码和同一个 MySQL 库，数据没有迁移动作。
- **SnowLuma 群申请扫描反复超时（低优先级，根因未定）。** 轮询器等 QQ 协议应答的默认超时为 15 秒。一次扫描结束后再等 15 秒，因此持续超时时约每 30 秒记录一次失败。部分群申请依赖轮询补齐，影响私聊的程度待评估，Fusion 群聊关闭。

## 如何验证

### 整套启停复验

```bash
kurumi-stack stop && kurumi-stack start   # 需要 sudo 密码
```

2026-11-21 通过：DSH、Fusion、管理台重启，QQ/SnowLuma/KnowledgeMap 保持运行；重启后 `doctor` 15 项 / 0 警告，`health.mjs` 全绿（QQ 在线、频道已连接）。停机窗口内没有制造真实 QQ 入站，消息排队行为未做真人往返验证。

### 开发与验证

先 `node scripts/fusion/link-dependencies.mjs` 准备开发依赖。下表是按领域选择的离线入口，不是全项目回归。测试使用满足 `config/openclaw-release.json` 约束的系统 Node（`/usr/bin/node`），与服务解释器一致。确认消费方的测试前，先依次构建确认核心、确认入口和共享领域库。

| 领域 | 命令 |
| --- | --- |
| 确认核心 | `npm --prefix chatbot/packages/confirmation-core run build`；`npm --prefix chatbot/packages/confirmation-core test` |
| 确认入口 | `npm --prefix chatbot/plugins/personal-confirmation run build` |
| 四领域共享实现 | `npm --prefix chatbot/packages/personal-domains test` |
| QQ、记忆、后台任务、研究 | `node --test chatbot/plugins/kurumi-qq/test/*.test.js chatbot/plugins/kurumi-memory/test/*.test.js chatbot/plugins/kurumi-tasks/test/*.test.js chatbot/plugins/kurumi-research/test/*.test.js` |
| 提醒列表 | `node --test chatbot/tests/reminder-list/*.test.mjs` |
| 后端边界 | `node --test chatbot/tests/backend-boundaries/*.test.mjs` |
| 适配器 | `node --test chatbot/tests/domain-adapters/*.test.mjs` |
| 权限 | `node --test chatbot/tests/access-control/*.test.mjs` |
| 编码委托 | `node --test chatbot/tests/coding/*.test.mjs` |
| 检索提供方 | `node --test chatbot/tests/web-deepseek/*.test.mjs` |
| E7 | `npm --prefix chatbot/plugins/kurumi-e7 run build`；`node --test chatbot/tests/e7/*.test.mjs` |
| 人格与记忆 | `node --test chatbot/tests/persona/*.test.mjs chatbot/tests/memory/*.test.mjs` |
| KnowledgeMap 桥接 | `node --test chatbot/tests/knowledgemap/*.test.mjs` |
| 邮件与论文 Node 层 | `node --test chatbot/plugins/kurumi-mail/test/*.test.js chatbot/tests/papers/*.test.mjs` |
| 论文 Python 层 | `python3 chatbot/tests/papers/responses_test.py`；`/home/afrangry/.openclaw-fusion/venvs/paper-translation/bin/python chatbot/tests/papers/engine_test.py` |
| 恢复工具 | `node --test scripts/fusion/test/recovery.test.mjs` |
| 统一启停 | `node --test scripts/fusion/test/stack.test.mjs`；`kurumi-stack status` / `doctor` |
| 运行健康判定 | `node --test scripts/fusion/test/health-cron.test.mjs` |

哪些脚本可以直接运行，见 [AGENTS.md](../AGENTS.md#需要单独授权的操作)。`scripts/fusion/test-*.mjs` 会真实发 QQ、创建任务或重启服务，不能当离线测试批量运行。

构建注意：`build-personal-plugins.mjs` 会先删后建 `personal-weather/dist`，服务运行时不要执行。不要删除旧的 `personal-weather/dist/reminder-cli.js`：恢复的旧 Cron 可能仍用它作执行地址，新提醒由 `personal-reminders` 处理。

