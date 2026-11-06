# QQ 融合助手架构与运行维护

<a id="qq-融合助手架构与边界"></a>
<a id="融合助手运行维护"></a>

类型：架构规则与操作手册。状态：维护现行架构、开发运维与后台副本契约；各领域上线范围、验收结论和未完成项分别见归属文档与[验收总表](16_验收与测试总表.md)。

本文说明系统如何组成、职责与能力边界，以及开发、检查和维护的操作路径。阅读入口见[README](README.md)，配置意图与运行事实的分工见[配置契约](../config/README.md)；逐轮开发和部署过程进入验证记录。

按需阅读：[系统架构](#架构决定) · [三模块](#人格记忆与功能三模块) · [目录与资产](#当前资产) · [能力边界](#能力边界) · [服务职责](#服务职责与运行检查) · [健康与同步](#常用操作) · [开发验证与升级](#开发与验证) · [QQ图片与引用](#qq图片与引用) · [链路查询](#跨模块链路查询) · [项目接入](#代码项目接入与合入) · [副本维护](#后台开发副本契约) · [栈启停](#dsh与融合栈统一启停)。

先做只读检查，再按本次改动与授权选择构建、同步或重启。已结束的依赖部署与基线观察见[阶段记录](archive/documentation-2026-10-23/10_融合助手运行维护.md)。

## 架构决定

**OpenClaw 是唯一助手宿主，Kurumi 是能力项目，SnowLuma 提供 QQ 传输，DSH 不在助手主链路内。**

```mermaid
flowchart TD
  Q[已登记身份的 QQ 私聊] <--> S[SnowLuma / OneBot]
  S <--> C[Kurumi QQ 频道\n身份 / 图片 / 文件 / 分段 / 回执]
  C <--> O[OpenClaw\n会话 / 工具 / Cron]
  O --> P[共享人格 / 按身份关系]
  O --> MEM[记忆插件\n长期事实 / 连续性摘要]
  MEM --> MDB[(私有记忆 SQLite)]
  O --> CF[确认入口\n高影响操作二次确认]
  O --> B[天气插件]
  O --> PF[Profile插件]
  O --> PL[行程插件]
  O --> RM[一次性提醒插件]
  O --> RL[提醒列表插件\n待做 / 每日汇总]
  O --> K[记账桥接插件]
  B --> API[KnowledgeMap 助手API]
  RL --> API
  K --> API
  API --> DB[(网站与助手共享业务库)]
  O --> ML[邮件插件\n白名单收件人]
  O --> PA[论文插件\nPDF 翻译]
  O --> SR[web_search / web_fetch\nTavily / 宿主直取]
  O --> W[隔离代码项目]
  O --> R[研究与报告]
  PA --> D[结果投递]
  W --> D
  R --> D
  D --> C
```

不再维护第二套会话、提醒或 QQ 投递宿主。DSH 可以独立提供网页或模型服务，但启动它不应启动旧 qq-bridge，也不能成为 QQ 消费者。

## 人格、记忆与功能三模块

项目同时承担情感陪伴与 AI 助手两种角色。三模块是逻辑职责划分，不要求每个模块独占数据库、构建或进程：

| 模块 | 负责什么 | 代码与规则入口 |
| --- | --- | --- |
| 人格 | 性格、身份、表达方式及按可信身份选择的关系背景 | `roles/`、`config/persona.json`、`scripts/fusion/templates/` → `scripts/fusion/sync-persona.mjs`；规则归[25](25_人格、记忆与会话连续性.md) |
| 记忆 | 本人的长期事实、有限期近期摘要；与宿主聊天历史共同提供连续性 | `chatbot/plugins/kurumi-memory/continuity/`、`chatbot/plugins/kurumi-memory/inbound.js`；宿主管理原生会话，规则归[25](25_人格、记忆与会话连续性.md) |
| 功能 | 天气、资料/行程、提醒、日志、论文、邮件及后台项目等能力 | `chatbot/plugins/`、共享 `chatbot/packages/` 与运维 `scripts/fusion/`；代码分层归[21](21_后端职责分层与代码整理.md) |

角色设定不自动成为用户事实；聊天原文、运行日志与任务账本也不自动成为陪伴记忆。工具执行仍受可信身份、授权和领域事务约束，不能由人格关系或模型自述决定权限。

早期设计素材保留在[tp.txt](tp.txt)。其中“能力边界明确、模型负责理解、后端负责确定执行、稳定事实与动态状态分离”等原则与当前分层一致；PlanIR、DAG 和完整控制平面不据此视为已实现或当前开发任务。

## 当前资产

| 职责 | 路径或状态 |
| --- | --- |
| 源码主仓库 | `/home/afrangry/kurumi-fusion`，保存源码与配置意图；Git 状态按[资产文档](12_目录资产与Git备份整理.md#git-与实时状态查询)实查 |
| 私有运行状态 | `/home/afrangry/.openclaw-fusion`，凭据、会话、数据库和任务状态 |
| 旧系统 A | `/home/afrangry/kurumi-archive/legacy-openclaw`，只作为回退材料 |
| 旧系统 B | `/home/afrangry/kurumi-archive/qq-bridge`，配合 SnowLuma 和 DSH |
| 共享业务 | `/home/afrangry/repository` 的 KnowledgeMap MySQL；`knowledgemap-assistant.service` 提供 loopback 3086 API |
| QQ 传输 | `/home/afrangry/snowluma` 的受管服务 |
| 恢复材料 | `/home/afrangry/kurumi-backups` |

融合助手不依赖 `/home/afrangry/.openclaw`。旧系统封存与恢复统一见[资产与回退手册](12_目录资产与Git备份整理.md#旧系统回退)，不能直接从归档路径启动。

## 能力边界

- QQ 身份及功能授权由 `config/access-control.json` 统一管理；只接收已登记用户私聊并回传自身，群聊关闭。成员使用独立 Agent/workspace，只允许聊天与自身论文等首期能力；个人业务仍仅主人。当前名单及真人验收状态见[文档24](24_统一身份与权限管理.md)。
- 人格素材来自 `roles/`，共享世凪性格并按可信身份选择关系，主人记忆不进入成员会话；人格与连续性唯一事实边界见[文档25](25_人格、记忆与会话连续性.md)。DeepSeek Flash 是当前主模型；模型配置见[配置契约](../config/README.md#主模型与人格切换)，图片验证边界见[QQ图片与引用](#qq图片与引用)。
- 天气、Profile、行程和一次性提醒是四个独立插件，分别注册工具、确认后端和服务生命周期；默认实现共用 `packages/personal-domains`，Profile/行程仍保留历史共享SQLite。通用确认由 `confirmation-core` 提供，业务提交、grant消费、幂等、取消和投递对账在领域内完成。现行职责、共享代码、下载/阅读与生命周期统一归[文档21](21_后端职责分层与代码整理.md)；待实施检索设计见[文档26](26_基础能力插件边界整理与检索接入设计.md)。
- [提醒列表、记账与天气](23_KnowledgeMap业务能力桥接.md)经KnowledgeMap业务API共用网站数据；用户规则、每日播报、接口、版本与迁移在同一文档维护。
- 代码任务在独立项目副本和 Bubblewrap 中执行；项目检查不能访问生产目录、主机服务总线或真实网络。
- 研究材料与报告保存在私有运行目录；原始论文和页图与可写笔记分离。

## 服务职责与运行检查

- `kurumi-fusion.service`：默认助手。
- `knowledgemap-assistant.service`：常驻业务API，独立于网站开发服务器。
- `snowluma.service`、`snowluma-qq.service`：QQ 传输。
- `openclaw-gateway.service`、`qq-bridge.service`：旧消费者；日常保持屏蔽。恢复旧系统前须按[旧系统回退](12_目录资产与Git备份整理.md#解除屏蔽的阶段)只解除所选单元的屏蔽。
- `dsh-web.service`：可独立运行，但不消费 QQ。
- `testIngress=false`；验收入口关闭，日常不执行真实外发测试脚本。

上面列服务职责与预期约束，实时 active/enabled 状态由 `node scripts/fusion/health.mjs` 核对；操作见[常用操作](#常用操作)。

## 维护边界

行为修改先改源码和配置来源，再同步私有运行目录；会话和长期记忆在运行目录维护；业务数据库和专用token在各自登记的私密位置备份。配置同步遵循 [`config/README.md`](../config/README.md)，资产归属、备份保留与旧系统切换遵循[资产与回退手册](12_目录资产与Git备份整理.md)，Fusion备份与恢复的验收标准遵循[验收总表](16_验收与测试总表.md)；测试证据统一从文档 16 和 `verification/INDEX.md` 查找。

## 常用操作

以下命令在`/home/afrangry/kurumi-fusion`执行；按当前任务选择一组，不整页批量执行。

### 只读检查

```bash
node scripts/fusion/health.mjs
systemctl --user status kurumi-fusion.service
journalctl --user -u kurumi-fusion.service -n 100 --no-pager
systemctl --user status snowluma.service snowluma-qq.service
```

`health.mjs`只读，不发QQ、不创建任务；兼容入口`probe-final.mjs`指向同一检查。合法活动提醒会列出状态。QQ断线先看SnowLuma/QQ服务及online状态，不重启旧bridge。默认滚动24小时500条额度按物理消息计数，不清空历史绕过。

### 配置同步

先分别审阅配置与人格差异，只读命令为：

```bash
node scripts/fusion/sync-config.mjs --diff
node scripts/fusion/sync-persona.mjs --diff
```

确认改动属于本次已授权部署后，按涉及内容选择写入命令：

```bash
node scripts/fusion/sync-config.mjs --apply
node scripts/fusion/sync-persona.mjs --apply
```

运行配置变更同步后需要重启；仅四份受管人格文件变更，当前宿主下一回合加载。身份登记还有工作区准备顺序，见[文档24](24_统一身份与权限管理.md#登记与撤权)。受管键、删除语义及凭据入口以[配置契约](../config/README.md)为准。

### 服务启停

以下均改变服务状态；按本次具体授权执行所需动作：

```bash
systemctl --user restart kurumi-fusion.service
systemctl --user stop kurumi-fusion.service
systemctl --user start kurumi-fusion.service
```

停止服务不只杀子进程，否则Restart策略会拉起。`run-gateway.mjs`是前台入口，日常不与systemd并开。首次`install-service.mjs`会禁用旧助手并启用融合，只用于明确切换；`configure-production.mjs`要求先审阅活动任务，不是日常重置脚本。DSH与Fusion联合启停另见[栈启停](#dsh与融合栈统一启停)，QQ传输独立管理。

## 开发与验证

开发目录与私有运行状态按[目录与资产](#当前资产)和[维护边界](#维护边界)区分。人格行为模板在`scripts/fusion/templates/AGENTS.md`，修改后按[配置同步](#配置同步)投影到私有workspace；人格来源仍由roles/config管理。

先用`node scripts/fusion/link-dependencies.mjs`准备开发依赖。下表是按领域选择的离线构建/验证入口，不是一次全项目验收；确认消费方测试前先依次构建确认核心、确认入口和共享领域库。

| 领域 | 命令与前提 |
| --- | --- |
| 确认核心 | `npm --prefix chatbot/packages/confirmation-core run build`；`npm --prefix chatbot/packages/confirmation-core test` |
| 确认入口 | `npm --prefix chatbot/plugins/personal-confirmation run build` |
| 四领域共享实现与兼容CLI | `node chatbot/scripts/build-personal-plugins.mjs`；`npm --prefix chatbot/packages/personal-domains test` |
| QQ、旧记忆接口、后台任务与研究 | `node --test chatbot/plugins/kurumi-qq/test/*.test.js chatbot/plugins/kurumi-memory/test/*.test.js chatbot/plugins/kurumi-tasks/test/*.test.js chatbot/plugins/kurumi-research/test/*.test.js` |
| 提醒列表 | `node --test chatbot/tests/reminder-list/*.test.mjs` |
| 后端边界 | `node --test chatbot/tests/backend-boundaries/*.test.mjs` |
| 适配器 | `node --test chatbot/tests/domain-adapters/*.test.mjs` |
| 权限 | `node --test chatbot/tests/access-control/*.test.mjs` |
| 本机编码委托 | `node --test chatbot/tests/coding/*.test.mjs`；真实DSH、隔离宿主与QQ按[文档28](28_本机编码工具委托与实验任务.md#后续实施与验收)分别授权与记录，不批量执行`acceptance-*.mjs` |
| 检索提供方 | `node --test chatbot/tests/web-deepseek/*.test.mjs` |
| E7只读数据 | `npm --prefix chatbot/plugins/kurumi-e7 run build`；`node --test chatbot/tests/e7/*.test.mjs`；实际HTTP/宿主/模型记录归文档27，不能用离线结果代替QQ验收 |
| 人格与连续性记忆 | `node --test chatbot/tests/persona/*.test.mjs` |
| KnowledgeMap桥接 | `node --test chatbot/tests/knowledgemap/*.test.mjs` |
| 邮件与论文Node层 | `node --test chatbot/plugins/kurumi-mail/test/*.test.js chatbot/tests/papers/*.test.mjs` |
| 论文协议Python层 | `python3 chatbot/tests/papers/responses_test.py`；其余并发/可靠性用例见文档22 |
| 论文排版引擎 | `/home/afrangry/.openclaw-fusion/venvs/paper-translation/bin/python chatbot/tests/papers/engine_test.py` |


后端职责分层、Policy/Store 适配器与确认共享接口见[文档 21](21_后端职责分层与代码整理.md)；跨层回归在 `chatbot/tests/backend-boundaries/`，替换回归在 `chatbot/tests/domain-adapters/`。确认消费方回归须先构建确认核心、确认入口和共享领域库三个 TypeScript 包。

天气、Profile、行程、一次性提醒在各自插件独立装配；`build-personal-plugins.mjs` 集中构建共享实现并生成兼容CLI。不要删除旧 `personal-weather/dist/reminder-cli.js`：恢复的旧Cron可能仍以此为执行地址；新提醒使用 `personal-reminders`。原天气包的build/test命令只作转交；依赖安装按共享库自己的锁文件进行。现行归属与兼容规则见[文档21](21_后端职责分层与代码整理.md#共享代码与插件生命周期)，独立启停证据见其专项报告。

QQ 身份/权限/邮件目标只改 `config/access-control.json`，用 `chatbot/scripts/access-control.mjs --check/--matrix` 审阅；成员人格和路由均由同步工具生成，不能只改频道 owner 或工具上限。登记、撤权、独立目录与真人验证按[文档24](24_统一身份与权限管理.md)。

<a id="依赖与升级"></a>

### 固定依赖与升级恢复

| 项目 | 当前约束与操作入口 |
| --- | --- |
| 宿主/连接库 | OpenClaw **2026.9.7**、`ws` **8.21.3**；以 `verify-dependencies.mjs` 检查。仓库 `node_modules/openclaw` 链接到全局安装，全局升级也会替换仓库依赖 |
| 全局升级 | 不直接运行 `openclaw update`；先更新版本契约、锁文件并验证。`run-gateway.mjs` 将非自身请求的子进程退出（含0）视为失败，systemd 按失败重试；版本检查持续失败时重试到限后停在 failed，用 `systemctl --user --failed` 检查 |
| 交互保护 | `scripts/fusion/openclaw-update-guard.sh` 可由 `~/.bashrc` 加载；拦截普通 `openclaw update`，放行 `update status`、`--dry-run`、`--help`。显式升级用 `KURUMI_ALLOW_OPENCLAW_UPDATE=1`；它不能拦截 `npm i -g`、绝对路径或 `command openclaw update` |
| 服务模板 | 源码模板和已安装单元分别维护；同步单元后执行 `systemctl --user daemon-reload`。Fusion 的 `Wants=` 包含 SnowLuma/QQ；是否运行仍以健康检查为准 |
| 依赖安装 | 领域包按各自 lockfile 执行 `npm ci`；第三方 Tavily 由 `install-plugins.mjs` 和 `config/plugins.package-lock.json` 管理 |
| 主机工具 | Git、Bubblewrap、Poppler、prlimit；不依赖旧 `.openclaw` 或归档树 |

全局宿主意外被替换时，使用系统 Node 重装固定版（shell 中 nvm 的 Node 22 低于该宿主要求）：

```bash
PATH=/usr/bin:/bin /usr/bin/npm i -g --prefix /home/afrangry/.npm-global openclaw@2026.9.7
```

该命令会更改全局安装，须作为已授权的修复步骤执行，不能放进日常只读检查。2026-10-21–22 的重启、模板同步及交互保护验证仅属原时点记录，见[阶段记录](archive/documentation-2026-10-23/10_融合助手运行维护.md#依赖与服务部署记录原文)与[验收总表](16_验收与测试总表.md)。

升级先更新版本契约与锁文件，完成依赖检查、构建、领域回归和隔离恢复验收后再部署。运行状态不进入Git。隔离恢复使用固定哈希 SDK 包，具体流程见[验收总表](16_验收与测试总表.md)。

离线测试、真实验收和探针的完整清单见[测试与证据索引](verification/INDEX.md)。`scripts/fusion/test-*.mjs` 可能真实发本人 QQ、创建任务或重启服务，不能按普通离线测试批量运行。执行前审阅脚本，使用独立会话/项目和有限发送预算；结束后关闭 `testIngress`、正常取消测试任务并检查真实终态，不删除账本。

## QQ图片与引用

图片入站通过 `chatbot/plugins/kurumi-qq/src/media.js` 的 `stageImage`：仅接受确切QQ CDN白名单或已暂存的本地图片，保留HTTPS、无URL凭据/非默认端口、禁重定向、8MiB及图片类型校验。`multimedia.nt.qq.com.cn`与`multimedia.nt.qq.com`均在白名单；加载失败先查频道暂存和附件状态，再查模型实际收到的媒体，不能只凭回复归因于视觉模型。

远程图片与表情共用 `stageImage`。URL通过QQ CDN白名单校验后，按该次请求的精确主机生成Fake-IP策略，字段与天气插件所用SDK helper一致（RFC 2544与IPv6 ULA兼容，不启用通用私网放行）。下载使用 `fetchWithSsrFGuard` 的 `trusted_env_proxy` 模式，保留15秒超时、HTTPS和禁重定向；响应交给 `saveResponseMedia` 做大小、类型校验及暂存，并在结束时释放请求资源。

历史CDN下载、独立DeepSeek看图与频道回归见[模型与图片证据](verification/deepseek-whale/README.md)；2026-10-27本人QQ新图与表情复测见[QQ图片验收](verification/qq-image-2026-10-27/retest-0119.md)。验收结论与未覆盖范围统一见[文档16](16_验收与测试总表.md)，不能据一次图片往返保证识图细节或建议正确。

**私聊引用优化待实施**：配置未显式指定 `replyToMode`，频道 `transport.js` 只在分段第一条附带宿主传来的 `replyToId`。目标是默认普通发送，仅在明确回复较早消息或区分话题时引用；频道/SDK引用策略尚未按该目标调整。旧验收历史清理与完整会话归档同属[待办N11](待办清单.md#n11)。`/new`及记忆保留按[人格与连续性规则](25_人格、记忆与会话连续性.md)，不把该部分已实现的连续性写成未实施。

## 跨模块链路查询

需要还原一轮 QQ 对话时使用只读入口 [`scripts/fusion/log-query.mjs`](../scripts/fusion/log-query.mjs)，它按统一事件契约读取 SnowLuma 日志、OpenClaw runtime/transcript、频道回执和提醒数据库：

```bash
node scripts/fusion/log-query.mjs --message-id=<QQ消息ID>
node scripts/fusion/log-query.mjs --proposal-id <提案ID> --json
```

没有消息 ID 时给出明确的 `--from`/`--to` 时间范围。默认按 `Asia/Shanghai` 解释无时区时间。查询只读，不调用 Gateway、OneBot、模型或 Cron；输出可能包含私聊正文和本机路径，不提交到 Git。扩展新功能时保留其原始日志，并按[文档 18](18_跨模块链路日志查询.md)接入事件适配器或可选结构化 sink，不另造一套业务日志数据库。

日常配置只使用 [config/README.md](../config/README.md) 中的同步入口；`prepare.mjs`、`configure-*.mjs`、`copy-domain-state.py` 为迁移工具，不是日常更新命令。

## 代码项目接入与合入

当前新增编码请求走[文档28的单目录DSH试点](28_本机编码工具委托与实验任务.md#单目录qq试点授权2026-10-30)，仅登记`dsh-pilot`；旧`kurumi_task`的`codeEnabled=false`，不再启动fusion开发副本。下述登记与副本维护契约保留供已有资产维护，不是本轮扩大项目授权的入口；重新启用旧编码或登记其他项目需主人另行决定。

当前`fusion`是`.openclaw-fusion/projects/fusion`独立副本，主聊天可说“让后台检查fusion项目……”，完成后查询或取消。模型可读写项目并做本地Git，固定检查在隔离环境运行，不提供宿主shell、网络安装或push。副本提交不会自动部署；操作者审阅diff/测试后再合入`kurumi-fusion`，重启服务。

新增项目时，**两类信息各有唯一维护入口**，不要混用：

| 要改什么 | 唯一入口 | 生效方式 |
| --- | --- | --- |
| agent 定义（`agents.entries.<id>`：workspace、工具 allow/deny、`fs.workspaceOnly`） | 仓库 `config/runtime.config.json`——`agents` 是 `_managed` 键，**仓库全权拥有** | `sync-config.mjs --apply` → 重启融合服务 |
| 项目注册表（`projects.json`：id、agentId、root、checks、只读依赖、fixtures） | `scripts/fusion/register-project.mjs`（校验 + `--apply` 写 `projects.json`） | 立即被插件读取；重启服务后仍生效 |

**不要用 `configure-projects.mjs` 做日常维护。** 它是一次性首次引导脚本：只在 id 不存在时追加登记，
**不会更新已存在的登记**；它会重写运行 `openclaw.json` 的 agent 定义（绕过仓库意图），
还会改副本的 `AGENTS.md`/`.gitignore`。修改 agent 后如果不改仓库配置，`sync-config --apply` 会把它覆盖回去。

步骤：

1. 在`.openclaw-fusion/projects/<id>`建立独立Git clone --no-hardlinks，原项目不改，移除不需要的remote；不能把两套旧原件注册成工作目录。
2. 把登记写成 JSON 条目文件（字段见下），先校验再应用：

```bash
node scripts/fusion/register-project.mjs --list                      # 当前登记
node scripts/fusion/register-project.mjs --check <file>              # 只校验，不写
node scripts/fusion/register-project.mjs --add <file>                # 预览将写入的内容
node scripts/fusion/register-project.mjs --add <file> --apply        # 写入 projects.json
node scripts/fusion/register-project.mjs --remove <id> [--apply]     # 移除
```

   **`<file>` 接受三种输入**（`--check` 与 `--add` 相同）：单条条目对象、条目数组、
   或完整注册表对象 `{version:1, projects:[...]}`。`--add` 要求其中**恰好一条**。
   注册表 `version` 只支持 `1`，其它值直接拒绝。

   校验规则中**保护根一项与运行时共用同一实现**（`chatbot/plugins/kurumi-tasks/protected-roots.js`，
   由 `projects.js` 与 CLI 同时导入）；其余字段由 CLI 按运行时规则复刻，**并非全部逻辑共用**：
   id 匹配 `^[a-z][a-z0-9-]{0,39}$`、`agentId` 必须是 `project-<id>`、root 必须是 canonical 且自带 `.git`、
   fixture target 只能是 `/checks/<文件名>`；root 不能是**整个归档目录** `/home/afrangry/kurumi-archive`
   （含 `legacy-openclaw`、`qq-bridge`、`legacy-units`）、运行目录、备份、固定 SDK 或实时源码树
   （`projects/` 下的工作区除外）。
   `readOnlyDependencies` 必须位于 `/home/afrangry/.npm-global/lib/node_modules/` 之内——
   这是沙箱唯一会只读挂载的路径，写别的值会在运行 `kurumi_project_check` 时被 `sandboxArguments` 拒绝。

   校验覆盖的是这里列出的字段（身份、root、`.git`、checks、fixture、依赖路径与保护根）。
   **它不保证运行时永不拒绝**：运行时还要求 `workspaceDir` 与登记 root 一致、agentId 与调用方匹配等条件，
   这些依赖运行上下文，CLI 无法在离线时判定。修改校验器或沙箱规则时必须同步修改另一侧。
3. 在仓库 `config/runtime.config.json` 的 `agents.entries` 增加同名 agent，workspace 指该副本，
   沿用 project-fusion 的精确工具 allow 和 workspaceOnly；跑 `sync-config.mjs --diff` 审阅后 `--apply`。
   同时在副本加项目 `AGENTS.md`，忽略 Host 生成的 IDENTITY/SOUL/USER/MEMORY。
4. 先由操作者运行登记的Bubblewrap检查，确认依赖可见、项目可写、外部检查只读、主机私有目录及网络不可达，再重启融合服务；用kurumi_task list验证。

注册表由操作者管理，模型只收项目ID。扩大检查范围应修改已有checks而不是新增第二套任务引擎；复杂项目的依赖需要预先准备并在隔离环境验证。`projects.json` 与运行 `openclaw.json` 都是**运行事实，不是编辑入口**；但它们的**来源不同**——前者用 `register-project.mjs` 维护，后者由仓库配置同步，见 [`config/README.md`](../config/README.md)。副本的基线、同步与合入流程见下一节。


## 后台开发副本契约

> 本节承接原独立后台开发副本维护契约；基线、同步、隔离检查和合入规则在此统一维护。

2026-10-30起，QQ的旧`kurumi_task kind=code`新任务启动已关闭；旧任务仍可查询/取消，论文研究继续使用`kind=research`。本节不替代文档28的任务工作树与确认合入规则。

后台代码任务（`kurumi_task kind=code`）不在 `/home/afrangry/kurumi-fusion` 里改代码，而在独立副本
`/home/afrangry/.openclaw-fusion/projects/fusion` 中工作。本节说明该副本的基线、同步、验证、合入和回退规则。
验收标准见[文档 16](16_验收与测试总表.md)。

### 当前基线

副本路径为 `/home/afrangry/.openclaw-fusion/projects/fusion`。它有独立 Git 历史，不自动追平主仓库；无 remote、不推送。开始每次任务前，分别读取主仓库和副本的 HEAD、分支及工作区状态，依下面维护流程审阅和同步，不使用文档中的旧 SHA 代替检查。

2026-10-10–17 的分支、同步基线、封存标签与当时工作区状态保留在[阶段记录](archive/documentation-2026-10-23/10_融合助手运行维护.md#当前基线)；旧线保留在归档标签及 bundle 中。Host 生成的上下文与 `node_modules` 由副本本地 `.gitignore` 忽略。

### 适用版本（重要）

同步只说明副本包含被审阅合入的源码版本，不证明与当前生产一致。任务开始前重新 fetch 并审阅 `git log`/`git diff`，不能把副本旧的 `config/` 或 Host 生成文件当生产事实。


### 与主仓库的有意差异（2026-10-11 实测）

相对最后一次同步基线，副本保留下面 3 项有意差异，**不是**“只差几个文件”的笼统说法：

| 差异 | 类型 | 原因 |
| --- | --- | --- |
| `.gitignore` | 修改 | 追加副本本地规则，忽略 Host 生成的 `IDENTITY.md`/`SOUL.md`/`USER.md`/`MEMORY.md` |
| `AGENTS.md` | 修改 | 副本专用开发指令：只在本副本内工作、不推送、检查在隔离命名空间 |
| `scripts/fusion/fixtures/stats.py` | 新增 | 后台代码任务的固定验收 fixture（`test_stats.py` 的 `mean`/`moving_average`）。**移走该文件会让固定测试失败**，已实测 |

融合前提示词原位于 `chatbot/AGENTS.md`，在2026-10-11核对时与主仓库一致；2026-10-28移至
[`docs/archive/chatbot-AGENTS.md`](archive/chatbot-AGENTS.md)，避免被开发工具当作目录指令加载。
旧验收脚本 `model-driver.mjs`、`run-retrieval-t3.mjs` 按自身模块位置显式读取仓库内的归档文件，
`KURUMI_SOURCE_ROOT` 仍只指定旧配置、依赖代码与报告所在的提取副本，不再提供这份提示词。
首次创建副本时，`configure-projects.mjs` 只写副本根 `AGENTS.md`，保留克隆下来的归档提示词，
不另建 `chatbot/AGENTS.md`；后续一致性随每次基线同步实查。归档与路径验证见[本轮记录](verification/chatbot-agents-archive-2026-10-28/README.md)。

另有三类内容**不出现在 Git 树差异里**，但确实存在于副本目录，排查时不要混淆：

- `IDENTITY.md`、`SOUL.md`、`USER.md`：Host 生成的 agent 上下文，被副本本地 `.gitignore` 忽略（`git status --ignored` 可见）。
- `node_modules/`：指向固定 SDK 的符号链接，忽略且由操作者维护。
- `config/`（含 `runtime.config.json`、`persona.json`、`README.md` 等）：**来自主仓库同步基线且被 Git 跟踪**。
  副本里存在这些文件是正常的；副本不负责**同步**生产配置，配置契约见 [`config/README.md`](../config/README.md)。

### 维护流程

1. **开始任务前同步**：确认主仓库工作区状态和目标提交，再在副本执行
   `git fetch /home/afrangry/kurumi-fusion main:main-sync`，用 `git log --oneline HEAD..main-sync` 与
   `git diff --stat HEAD main-sync` 审阅将合入的内容。**fetch 只更新引用，不等于合入**；
   合入是单独的 `git merge` 步骤，且要先看清楚“谁改了哪些文件、哪些是副本刻意保留的差异”。
   有疑问先停下问操作者；`-X theirs` 只在差异已确认时用于首次基线切换，
   **不得用来掩盖没看懂的冲突**（文档 16 要求验收结论与证据对应，静默合并会让证据失真）。
2. **建任务分支**：`git switch -c kurumi/<任务名>`；一个任务一个分支，不在基线上直接改。
3. **修复与验证**：复现问题、修改、运行登记检查。检查必须在 `kurumi_project_check` 的 Bubblewrap 边界内运行，
   实际退出码与输出是唯一依据；不得删除或改弱现有测试来让检查通过。
4. **提交**：用 `kurumi_project_git` 的 `commit` 并**明确列出本次文件**，只提交这些文件；消息写清改了什么和验证结果。
5. **审阅合入**：操作者审阅副本 diff 与检查输出后，才在主仓库以同样内容提交。
   **副本提交不会自动部署**，也不得由 agent 直接 `push` 或重启生产服务。
6. **回退**：副本出错优先用 `git switch` 切回基线分支，或 `git restore <文件>` 撤销单文件改动；
   `git reset --hard <基线提交>` 会丢弃副本未提交的改动，**只在确认没有需要保留的内容时使用**，
   且事后要检查 `git status` 与 `git log`。历史与旧线仍在标签和归档 bundle 中，不需要靠 reset 找回。

### 登记检查与隔离边界

检查登记在 `.openclaw-fusion/projects.json`（agent 可读，只有操作者能改；入口见[代码项目接入与合入](#代码项目接入与合入)）。下面是2026-10-10–11验收的登记与隔离约束；当前检查名、argv和覆盖领域须以注册表实查，不据旧清单保证新增领域已覆盖：

- 检查名 `fusion-offline-regression`，超时 60s，argv 固定为
  `/checks/fusion-memory-revision.mjs` 加 8 个插件测试文件（`kurumi-qq`×3、`kurumi-memory`×1、`kurumi-tasks`×3、`kurumi-research`×1）。
- fixture `/checks/fusion-memory-revision.mjs` 来自 `.openclaw-fusion/project-checks/`，在沙箱内**只读**挂载。
- 沙箱参数以 `chatbot/packages/sandbox/index.js` 的 `sandboxArguments` 为准：
  `--unshare-all --die-with-parent --new-session --clearenv`，只读挂载 `/usr`、`/bin`、`/lib`、`/lib64` 和固定 SDK 路径，
  副本挂到 `/workspace`，`HOME=/tmp`，PATH 固定。因此**主机 HOME、生产目录、服务总线与外网都不可见**；
  沙箱内 `/workspace` 就是副本根本身，fixture 里写 `/workspace/chatbot/...` 才能解析。
- 检查的 argv 在宿主机无法直接运行（fixture 的 `/checks/...` 与 `/workspace` 路径不存在），
  必须通过 Bubblewrap 或 `kurumi_project_check` 执行；直接在主机跑会得到 `ERR_MODULE_NOT_FOUND`，那不是真实失败。
- 新增项目或扩大检查范围按[代码项目接入与合入](#代码项目接入与合入)的步骤修改已有 `checks`，不新增第二套任务引擎。

### 证据

- 2026-10-10 副本同步与复验：`docs/verification/2026-10-10_projects-fusion-sync.md`。
- 2026-10-11 副本最终同步与引导脚本复验：`docs/verification/2026-10-11_projects-fusion-sync.md`。
- 旧副本线的完整历史与独有提交：`/home/afrangry/kurumi-backups/projects-fusion-copy-2026-10-10/`
  （`projects-fusion-before-rebase.bundle`、`copy-only-9-commits.patch`、生成的 workspace 文件）。

## 研究与提醒

提醒列表维护与每日汇总见[提醒列表与定时汇总](23_KnowledgeMap业务能力桥接.md#提醒列表与定时汇总)。固定程序位于 `chatbot/scripts/reminder-list.mjs`；共享模式和原SQLite兼容实现的测试入口、自然录入夹具及证明范围统一见[测试与脚本](23_KnowledgeMap业务能力桥接.md#测试与脚本)。`*.test.mjs` 可离线执行；`acceptance-*.mjs` 可能调用真实模型、原生调度或真实业务，按[脚本索引](verification/SCRIPTS.md)的副作用与授权范围单独执行。

长篇论文通过kurumi_task kind=research进入后台。来源PDF在research-cache，报告在research-workspace/reports；按URL/哈希/下载时间区分版本。未提取、未看图或未复现实验时必须说明。可要求后台读取已有报告进一步展开；主会话不直接读取任意文件。

一次性提醒使用领域提案和短码确认；固定runner到点执行不依赖模型。周期天气使用原生automations，仅允许天气读取工具和本人投递；依赖模型与天气API。插件不默认创建每天播报；日常播报以主人已登记的周期任务为准，早期验收任务的删除不表示当前无日常任务。所在地与行程改变仍需原文确认。

## 论文 PDF 翻译

安装入口为`chatbot/scripts/setup-paper-translation.sh`，凭据导入为`chatbot/scripts/import-paper-credentials.mjs`，均由操作者执行；主聊天使用受管PDF ID及窄工具。当前模型、并发、时限、重试、任务/投递状态及性能方案统一见[文档22](22_论文PDF翻译与文件投递.md)，配置键入口见[配置契约](../config/README.md#领域配置查询)。人格、记忆读取与写入、`/new`及压缩行为见[文档25](25_人格、记忆与会话连续性.md)。

论文链路的日常只读查询：

```bash
node scripts/fusion/log-query.mjs --source papers --contains <job_ID> --json
```

## 配置、备份与旧系统回退

- 共享天气、待做与记账的部署、迁移及配对恢复按[KnowledgeMap共享业务规则](23_KnowledgeMap业务能力桥接.md)。其 MySQL 不在 Fusion SQLite 备份中，完整业务恢复必须同时保存网站数据库和私密配置；具体业务动作、版本和幂等规则在共享业务文档维护。
- 修改运行配置或四份受管人格文件：按[配置同步](#配置同步)选择入口与生效方式；关系分离及验证边界见[人格与连续性规则](25_人格、记忆与会话连续性.md)。
- 制作与验证新系统恢复点：按[验收总表](16_验收与测试总表.md)操作，停写、凭据与重复投递的边界都在该文件维护。
- 切回旧系统：只按[旧系统回退](12_目录资产与Git备份整理.md#旧系统回退)选择 A 或 B、还原原路径并审查外发规则；不能仅启用旧单元。

## DSH与融合栈统一启停

以afrangry普通用户执行：

```bash
cd /opt/deepseek-harness
./Start-DSH.sh
./Stop-DSH.sh
```

**当前契约：只启停 DSH 与融合助手，QQ 传输独立管理。** 具体行为：

| 动作 | Start | Stop |
| --- | --- | --- |
| `dsh-web.service`（系统） | 启动 | 停止 |
| `kurumi-fusion.service`（用户） | 启动 | 先停止 |
| `snowluma`、`snowluma-qq` | **不启动**，只检查状态 | **不停止**，保持原状态 |
| 旧 `qq-bridge`、`openclaw-gateway` | 启动 Fusion 时由 `Conflicts=` 停止旧消费者 | 不单独操作旧服务 |

要点与理由：

- **QQ 传输独立管理**：`snowluma-qq` 重启后需要约 2 分钟完成客户端热更新与登录，期间 3083/3084 不监听；
  因此启停融合助手不再连带重启 QQ 传输。Start 只检查它们是否在运行，不自动拉起（2026-10-10 起的行为）。
- **Start 的退出码包含 QQ 状态**：紧凑摘要要求 DSH、融合链路与 SnowLuma/QQ 各项都就绪，
  因此 **QQ 传输未运行时 Start 会以非零退出**并提示检查已有 QQ 登录与 SnowLuma 状态。
  这是“未就绪”而不是“启动失败”——此时融合助手可能已经在跑，应先去核对 SnowLuma 再决定是否手动启动它。
- **旧消费者仍会被停**：靠 `kurumi-fusion.service` 的 `Conflicts=qq-bridge.service openclaw-gateway.service`
  由 systemd 处理，不是脚本显式 `stop`。所以“只启停 DSH/Fusion”不等于“旧助手可能还在跑”。
- Stop 之后助手不可用，但 QQ 通道仍在（传输没停）；停机期间不会有新的融合回复。
- 操作保留源码、登录信息、聊天、提醒与开机启动设置。所谓“新 bridge”是融合服务中的 QQ 插件，
  没有额外创建同名 bridge 进程；SnowLuma 复用已有传输服务。

版本源文件在 `scripts/fusion/launchers/`；实际入口在 `/opt/deepseek-harness/`；旧入口备份在
`/opt/deepseek-harness/launcher-backup-before-fusion/`。2026-10-10 的逐字节核对只证明当时时点；
修改源文件后必须同步到实际入口（文件所有者 `dsh:dsh`、权限 755），否则下次以部署副本为准。
脚本不保存 sudo 密码。Start 会等待实际健康检查，失败以非零退出并显示原因，允许重复执行。

启停证据见 [stack-lifecycle.json](verification/deepseek-whale/stack-lifecycle.json)，各阶段覆盖范围见[验收总表](16_验收与测试总表.md)。历史记录中 SnowLuma 曾超过停止期限并被 SIGKILL；操作时应检查 `ActiveState` 和 `Result`，不能把“进程停止”当作“正常退出”。

### 紧凑启动输出

默认Start仅显示DSH 3080、Fusion 18890、SnowLuma WebUI 3082、OneBot HTTP 3083、OneBot WS 3084、QQ在线状态及最终结果，最后保留DSH认证入口。健康探测仍检查数据库、Cron、旧消费者与测试入口等，显示层为`scripts/fusion/stack-summary.mjs`，不以端口监听替代实际链路状态。

终端等待行原地更新，重定向时不输出控制字符。`./Start-DSH.sh --verbose`查看完整健康JSON和附加诊断；只在健康探测进程隐藏已知ExperimentalWarning。`./Stop-DSH.sh --verbose`显示原始ActiveState/Result；默认停机输出区分“已停止”和“已停止，退出状态异常”。默认隐藏已停止的旧助手行，旧助手异常仍显示。

启动输出同时显示DSH本地与Tailscale远端认证入口。远端域名读取dsh-web.service的`--trusted-host`（限定*.ts.net），使用HTTPS并保留本地入口路径和认证参数；沿用现有Tailscale Serve转发，不修改网络配置。

返回[文档入口](README.md)。
