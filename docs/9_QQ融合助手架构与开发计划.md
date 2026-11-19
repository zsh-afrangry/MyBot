状态：开发中（运维入口可用；Cron 健康判定、整套启停与端到端复验未完成）

# 运行维护

本文说明目录和服务怎么分工，日常怎么检查、同步、启停，开发时用哪些离线测试，以及升级依赖的做法。系统组成和分层见[文档1](1_总体架构与设计原则.md)。配置意图和运行事实的分工见[配置契约](../config/README.md)。

## 功能

### 当前资产

| 职责 | 路径或状态 |
| --- | --- |
| 源码主仓库 | `/home/afrangry/kurumi-fusion`，保存源码和配置意图 |
| 私有运行状态 | `/home/afrangry/.openclaw-fusion`，凭据、会话、数据库、任务状态 |
| 共享业务 | `/home/afrangry/repository` 的 KnowledgeMap MySQL；`knowledgemap-assistant.service` 在 loopback 3086 提供 API |
| QQ 传输 | `/home/afrangry/snowluma`，由 `snowluma.service`、`snowluma-qq.service` 管理 |
| 恢复材料 | `/home/afrangry/kurumi-backups`，见[文档12](12_目录资产与Git备份整理.md) |

融合助手不依赖 `/home/afrangry/.openclaw`。

## 接口

### 服务

- `kurumi-fusion.service`：默认助手，Gateway 监听本机 18890。模板在 `scripts/fusion/systemd/`，`Wants=` 含 SnowLuma 两个单元，`Conflicts=` 含 `qq-bridge.service` 和 `openclaw-gateway.service`。
- `knowledgemap-assistant.service`：常驻业务 API，独立于网站开发服务器。
- `snowluma.service`、`snowluma-qq.service`提供 QQ 传输，OneBot HTTP 发送使用本机 3083，WebSocket 接收事件使用 3084。
- `qq-bridge.service`、`openclaw-gateway.service`：旧消费者，保持屏蔽，不与 Fusion 同时运行。
- `dsh-web.service`：可独立运行，不消费 QQ。
- `testIngress=false`：验收入口关闭，日常不运行真实外发的测试脚本。

实时的 active/enabled 状态以 `health.mjs` 为准，不以本节为准。

### 日常操作

在 `/home/afrangry/kurumi-fusion` 执行，按当前任务选一组。

#### 只读检查（日常自检）

```bash
node scripts/fusion/health.mjs            # 运行连接、服务、数据库、Cron、旧消费者、testIngress
node scripts/fusion/verify-dependencies.mjs   # 依赖与批准版本
node scripts/fusion/sync-config.mjs       # 配置意图与运行配置是否一致（默认只读）
node scripts/fusion/sync-persona.mjs      # 人格投影是否一致（默认只读）
systemctl --user status kurumi-fusion.service snowluma.service snowluma-qq.service
journalctl --user -u kurumi-fusion.service -n 100 --no-pager
```

这四项只证明检查时的运行与对齐状态，不证明 Git 已提交推送，也不证明人格体验或业务端到端成功。`health.mjs` 不发 QQ、不创建任务。QQ 断线先看 SnowLuma/QQ 服务和在线状态，不重启旧 bridge。当前配置的滚动 24 小时 500 条额度按发送预留计数，含失败和未知回执，不能靠清空历史绕过。

#### 配置同步

```bash
node scripts/fusion/sync-config.mjs --diff
node scripts/fusion/sync-persona.mjs --diff
# 确认属于本次已授权的部署后：
node scripts/fusion/sync-config.mjs --apply
node scripts/fusion/sync-persona.mjs --apply
```

运行配置变更后要重启服务。只改四份受管人格文件时，宿主下一回合加载。身份登记有工作区准备顺序，见[文档24](24_统一身份与权限管理.md)。受管键、删除语义和凭据入口见[配置契约](../config/README.md)。行为模板 `scripts/fusion/templates/AGENTS.md` 改后按这个流程投影到运行 workspace。

#### 服务启停

这些命令会改变服务状态，按本次授权执行。

```bash
systemctl --user restart kurumi-fusion.service
systemctl --user stop kurumi-fusion.service
systemctl --user start kurumi-fusion.service
```

停服务要用 `stop`，只杀子进程会被 Restart 策略拉起。`run-gateway.mjs` 是前台入口，日常不与 systemd 并开。`install-service.mjs` 会禁用旧助手并启用融合，只用于明确的切换。

#### DSH 与融合栈统一启停

```bash
cd /opt/deepseek-harness
./Start-DSH.sh
./Stop-DSH.sh
```

脚本直接操作 DSH 和融合助手。QQ 传输由独立单元管理，Fusion 的 `Wants=` 可以在启动时拉起依赖单元。

| 动作 | Start | Stop |
| --- | --- | --- |
| `dsh-web.service`（系统） | 启动 | 停止 |
| `kurumi-fusion.service`（用户） | 启动 | 先停止 |
| `snowluma`、`snowluma-qq` | 脚本检查状态，允许 systemd 按 `Wants=` 拉起 | 脚本不停止 |
| 旧 `qq-bridge`、`openclaw-gateway` | 由 `Conflicts=` 停止 | 不单独操作 |

- `snowluma-qq` 重启后须等客户端更新、登录和协议会话恢复，耗时无固定保证；期间 3083/3084 可能不监听，日常重启 Fusion 不会要求重启已运行的 QQ 服务。
- Start 的退出码包含 QQ 状态：QQ 传输未运行时以非零退出。这是“未就绪”，不是“启动失败”，此时融合助手可能已经在跑。
- Stop 之后助手不可用，QQ 通道仍在，停机期间没有融合回复。
- Start 会等待健康检查，失败以非零退出并显示原因，可以重复执行。状态摘要包含 DSH 3080、Fusion 18890、SnowLuma WebUI 3082、OneBot HTTP 3083、OneBot WS 3084 和 QQ 在线状态，由 `scripts/fusion/stack-summary.mjs` 生成。Start 另显示可用的 DSH 入口，该入口可能包含认证信息。`--verbose` 看完整健康 JSON。Stop 的默认输出区分“已停止”和“已停止，退出状态异常”，`--verbose` 显示原始 ActiveState/Result。SnowLuma 曾超过停止期限被 SIGKILL，所以要看 `ActiveState` 和 `Result`，不能把“进程停止”当作“正常退出”。
- 脚本源在 `scripts/fusion/launchers/`，实际入口在 `/opt/deepseek-harness/`（所有者 `dsh:dsh`，权限 755）。改了源文件必须同步到实际入口，否则以部署副本为准。脚本不保存 sudo 密码。

### 跨模块链路查询

还原一轮 QQ 对话用只读入口 `chatbot/scripts/log-query.mjs`，规则见[文档18](18_跨模块链路日志查询.md)：

```bash
node chatbot/scripts/log-query.mjs --message-id=<QQ消息ID>
node chatbot/scripts/log-query.mjs --proposal-id <提案ID> --json
node chatbot/scripts/log-query.mjs --source papers --contains <job_ID> --json
```

没有消息 ID 时给明确的 `--from`/`--to`，无时区的时间按 `Asia/Shanghai`。查询不调用 Gateway、OneBot、模型或 Cron，输出可能含私聊正文，不提交到 Git。

## 原理

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
- `health.mjs` 会列出 Cron 最后失败，但尚未把它加入 `issues`，可能同时出现 Cron error 与 `ok=true`。须核对执行、冻结正文和送达账本，不能仅凭总状态判播报成功。
- **QQ 客户端异常退出后，协议会话长时间不恢复（低优先级，未立项修复）。** QQ 客户端崩溃后，systemd 拉起进程到 OneBot 恢复监听曾相隔约两小时二十五分。Fusion 在端口不可用期间退避重连，重连间隙的入站可能丢失，Cron 投递可能失败。崩溃与会话延迟的根因均待查，进程状态需要结合 OneBot 在线状态和真实往返判断。复查用 SnowLuma 和 Fusion 的日志。
- **SnowLuma 群申请扫描反复超时（低优先级，根因未定）。** 轮询器等 QQ 协议应答的默认超时为 15 秒。一次扫描结束后再等 15 秒，因此持续超时时约每 30 秒记录一次失败。部分群申请依赖轮询补齐，影响私聊的程度待评估，Fusion 群聊关闭。

## 如何验证

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

哪些脚本可以直接运行，见 [AGENTS.md](../AGENTS.md#需要单独授权的操作)。`scripts/fusion/test-*.mjs` 会真实发 QQ、创建任务或重启服务，不能当离线测试批量运行。

构建注意：`build-personal-plugins.mjs` 会先删后建 `personal-weather/dist`，服务运行时不要执行。不要删除旧的 `personal-weather/dist/reminder-cli.js`：恢复的旧 Cron 可能仍用它作执行地址，新提醒由 `personal-reminders` 处理。

## 进行中：运行与端到端复验

- 修正 Cron 失败的健康判定；播报生成与技术错误外发的缺口归[文档23](23_KnowledgeMap业务能力桥接.md#限制与已知问题)。
- 整套 DSH 启停和后台模型 90 秒严格断言待复验。会话归档产品的保留、导出和恢复策略另待决定。
