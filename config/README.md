# 配置来源与同步契约

类型：配置规则与同步操作手册。状态：维护现行配置来源和部署契约；具体业务的实现范围及验收分别进入领域文档与[文档16](../docs/16_验收与测试总表.md)。

仓库保存配置意图，运行目录保存实际配置与私密状态。按[来源与目录](#目录分工) → [受管键与删除语义](#仓库全权管理-vs-宿主自行维护) → [同步命令](#同步契约) → [生效条件](#改配置的正确姿势)阅读。同步源码为`sync-config.mjs`和`sync-persona.mjs`，文中的历史迁移时点不构成新的执行授权。

## 目录分工

| 位置 | 内容 | 是否进 Git |
|---|---|---|
| `config/runtime.config.json` | 运行配置的**权威副本**：模型、agent、插件、频道、工具策略、日志 | ✅ |
| `config/access-control.json` | QQ 身份/显式功能权限/邮件目标的唯一编辑来源；同步时编译到运行配置 | ✅ 无凭据，含已授权 QQ 与目标邮箱 |
| `config/persona.json` | 当前角色声明（共享角色卡、按可信角色选择的关系素材、身份名、AGENTS 替换） | ✅ |
| `config/plugins.package.json` + `config/plugins.package-lock.json` | 第三方插件清单与锁文件 | ✅ |
| `roles/` | 角色卡（人格来源） | ✅ |
| `scripts/fusion/` | 部署、配置同步、备份与恢复 | ✅ |
| `docs/` | 运维与历史说明 | ✅ |
| `.openclaw-fusion/runtime-env.json` | **凭据平面**：API Key、网关 token、代理 | ❌ 仅私有备份 |
| `.openclaw-fusion/{http,ws}-token` | SnowLuma 会话令牌 | ❌ 仅私有备份 |
| `.openclaw-fusion/workspace/` | **人格/规则文件与 `MEMORY.md` 说明文件**、`SOUL.md`、`IDENTITY.md`、`AGENTS.md`、`USER.md` | ❌ 仅私有备份 |
| `.openclaw-fusion/workspace/.kurumi-memory/state.sqlite` | 主人连续性记忆唯一事实：长期事实、7天（可配置1–30天）近期摘要、来源、版本与遗忘屏障 | ❌ 仅私有备份；由备份脚本做 SQLite 一致快照 |
| `.openclaw-fusion/users/<QQ>/workspace/` | 成员独立 Agent 的四份受管人格/规则文件及个人会话环境，不复制主人记忆/资料 | ❌ 仅私有备份 |
| `.openclaw-fusion/state/` | 一次性提醒、天气、Profile、行程；共享列表的设置/投递账本及冻结旧事项（SQLite） | ❌ 仅私有备份 |
| `.openclaw-fusion/channel/` | 频道账本、贴纸目录、发送回执 | ❌ 仅私有备份 |
| `.openclaw-fusion/agents/` | 各 Agent 的原生会话 SQLite、保留的历史 JSONL 等资料；读取归属见文档25 | ❌ 仅私有备份 |
| `.openclaw-fusion/{code,research}-workspace/`、`project-checks/`、`research-cache/` | 后台任务与研究的隔离工作区、检查夹具、缓存 | ❌ 仅私有备份 |
| `.openclaw-fusion/plugins/` | 受控第三方插件安装（由仓库锁文件重建） | ❌ 可重建 |
| `.openclaw-fusion/paper-credentials.json` | 论文翻译凭据，0600；GPT 014 → 030 → 040 与独立 DeepSeek 官方 Key，按本次厂商选取 | ❌ 仅私有备份 |
| `.openclaw-fusion/documents/` | 受管 PDF、任务/产物记录、论文链路事件及模型/字体/译文缓存 | ❌ 仅私有备份；缓存可重建 |
| `.openclaw-fusion/venvs/paper-translation/` | 按锁文件重建的 Python 3.12 翻译环境 | ❌ 可重建 |
| `.openclaw-fusion/paper-acceptance/` | 明确授权的真实 PDF 验收状态与缓存，归属文档 22 | ❌ 私有验收资料 |

> **业务记忆不在 `state/` 里。** 连续性模式下 `workspace/.kurumi-memory/state.sqlite` 是唯一事实，
> `workspace/MEMORY.md` 只保留迁移说明；当前连续性模式不允许旧写入接口把它当作第二事实源。
> `state/personal-weather/weather.sqlite` 存 Profile/行程，`state/personal-reminders/` 存提醒。
> 备份必须包含整个运行目录；仅备份 `state/` 会遗漏人格和主人记忆。

`runtime.config.json` **不含任何真实凭据**。其凭据来源包含运行目录和业务服务的专用私密文件：

- `${OPENCLAW_GATEWAY_TOKEN}`、`${QWEATHER_API_HOST}` —— 由 `run-gateway.mjs` 从
  `runtime-env.json` 展开为子进程环境变量；
- `{"source":"env","id":"DEEPSEEK_API_KEY"}` 这类 **SecretRef** —— 由 OpenClaw 在运行时按名字解析。
- `plugins.entries.kurumi-papers.config.credentialsFile` —— 翻译进程启动时读取 0600 私密 JSON，只选择该厂商的 Key，经 stdin 传入；不能在配置、命令行或工具参数中写密钥。操作者用 `chatbot/scripts/import-paper-credentials.mjs --provider openai|deepseek` 导入；已有目标需 `--replace` 原子合并并保留另一厂商，具体来源和命令见文档 22。

- KnowledgeMap专用Bearer仅从 `/home/afrangry/.config/knowledgemap/assistant-token` 读取（600），两端共享此凭据文件，不共享MySQL密码；属于私密备份范围。

因此改配置时的规则很简单：**要改行为改仓库，要改密钥只改登记的私密位置，两者都不要互相复制。**

## 主模型与人格切换

- 主模型由 `runtime.config.json` 的 `models` 与 `agents.defaults.model` 管理；当前为官方 `deepseek/deepseek-flash`，直连 `https://api.deepseek.com` 的 OpenAI兼容 Chat Completions，声明text/image输入。主聊天不经过DSH或NAICCC，未单独指定模型的后台agent继承默认值；继承配置不等于每个后台任务均已重验。历史实测见[模型与图片证据](../docs/verification/deepseek-whale/README.md)。
- 人格只从 `persona.json`、`roles/`和受管模板投影，使用 `sync-persona.mjs --diff` → `--apply`。当前角色及本人/成员关系、记忆与 `/new` 的业务规则由[文档25](../docs/25_人格、记忆与会话连续性.md)维护；不将角色名当作权限依据。
- `configure-deepseek-persona.mjs`是2026-10-05的一次性迁移脚本，**不是日常人格切换入口**。它会重写provider、默认模型、`runtime-env.json`并删除`OPENAI_API_KEY`，还会写四份工作区文件。迁移私密材料位于 `.openclaw-fusion/migration/before-deepseek-whale-2026-10-05/`，只代表当时状态，不是当前完整回退点。改配置与回退先按本文及文档16的契约核对，不删除运行目录或业务状态。

## 仓库全权管理 vs 宿主自行维护

`runtime.config.json` 顶部的 `_managed` 列出**仓库全权拥有**的顶层键
（当前：`agents`、`bindings`、`channels`、`commands`、`discovery`、`gateway`、`logging`、
`models`、`plugins`、`secrets`、`session`、`skills`、`tools`）。语义是：

- **`_managed` 里的键：整棵子树由仓库替换**。所以从仓库删掉一个插件条目、一个模型 provider
  或一段工具策略，`--apply` 会**真的删掉**它；`--check` 也会把"运行态里还有、仓库里已删"
  报成漂移并以非零码退出。
- **不在 `_managed` 里的键：宿主自行维护，原样保留**，并在 `--diff` 里列为
  `RUNTIME-ONLY` 提示。

## 同步契约

`sync-config.mjs` 是唯一的运行配置同步入口。它先校验 `access-control.json`，编译 `channels.kurumi-qq.accessControl`、ownerId、主人命令名单、天气 scheduledOwnerId、邮件 allowedRecipients 以及成员 Agent/binding，再按受管键同步；这几项不在 `runtime.config.json` 重复编辑。配置原子替换，错误策略不写入；更换既有 owner QQ 要显式迁移个人数据，不能直接改表。完整权限、资源归属与登记步骤见[文档24](../docs/24_统一身份与权限管理.md)。

### 只读核对

```bash
node scripts/fusion/sync-config.mjs
node scripts/fusion/sync-config.mjs --diff
node scripts/fusion/sync-persona.mjs --diff
```

配置默认`--check`只报告漂移；`--diff`列差异、删除项和运行态独有键。人格预览只比较投影，不写记忆或会话。

### 应用与生效

```bash
node scripts/fusion/sync-config.mjs --apply
node scripts/fusion/sync-persona.mjs --apply
```

以上写入命令按本次已授权变更选择。运行配置需重启生效；仅四份人格文件由当前固定宿主下一回合加载。成员登记/撤权还需遵循文档24的工作区顺序；不手改运行副本。

<a id="保证"></a>

### 写入保证

1. **只写 `openclaw.json`**。脚本不会打开、移动或删除 `state/`、`channel/`、`agents/`、
   `workspace/`、`media/` 或任何数据库与 JSONL，因此不可能覆盖记忆、提醒或聊天历史。
2. **写入前先备份**为 `openclaw.json.bak.<时间戳>`（mode 600）。
3. **`--check` 在漂移时以非零码退出**，可直接接进启停脚本或自检。

### 分阶段部署

并行开发需要按插件分阶段部署时，可显式使用 `--diff --defer-plugin=<插件ID>`，审阅后用同一参数配合 `--apply`。该参数保留该插件**完整的当前运行条目**，输出 `DEFERRED`；只允许仓库与运行态均启用、在 `plugins.allow` 中且加载路径一致的既有插件，不能延缓新增、禁用或路径变更。它不保留其它键，也不跳过构建或加载验收。**普通 `--check` 仍比较全部仓库意图**，不接受延期参数，延期期间可能正常报漂移；不能将部分部署写成全量对齐。完成延期模块后由对应任务同步并重新检查。10项自检、allow成员检查补正及原回执见[结构整理报告](../docs/verification/capability-decoupling-2026-10-20/README.md)。

## 改配置的正确姿势

| 想改什么 | 改哪里 | 之后做什么 |
|---|---|---|
| 人格 / 语气 / 关系背景 | `config/persona.json`、`roles/` 及主人/成员模板 | `sync-persona.mjs --diff` → `--apply`；当前宿主下一回合加载，不复制记忆 |
| QQ 身份/功能权限/邮件目标 | `config/access-control.json`，递增 revision | 校验/矩阵/漂移审阅，先准备成员人格，再同步配置、重启；按文档24验收 |
| 模型 / provider | `config/runtime.config.json` 的 `models` 与 `agents.*.model` | `sync-config.mjs --apply` |
| 工具白名单 | 同上，`agents.entries.main.tools.alsoAllow` | `sync-config.mjs --apply` |
| 禁用某类工具 | 同上，`tools.deny` / `tools.fs` | `sync-config.mjs --apply` |
| 插件开关或参数 | 同上，`plugins.entries.<id>` | `sync-config.mjs --apply` |
| 发送限额 / 分段 | 同上，`channels.kurumi-qq` | `sync-config.mjs --apply` |
| 搜索 provider | 同上，`tools.web` | `sync-config.mjs --apply` |
| 轮换 API Key | **只改** `.openclaw-fusion/runtime-env.json` | 重启服务 |
| 升级第三方插件 | `scripts/fusion/lib/plugins.mjs`、`config/plugins.package.json` 和锁文件 | `install-plugins.mjs` 后跑验收 |

> **不要用 `configure-deepseek-persona.mjs` 改人格。** 它是一次性迁移脚本，除了角色卡还会重写
> `models.providers`、默认模型、`runtime-env.json`（并删掉 `OPENAI_API_KEY`）以及四份工作区文件。
> 脚本开头已加警告。

### 人格投影契约

`config/persona.json` 的 `roleFile` 指向共享角色卡，`identityName` 指定角色名；SOUL/IDENTITY对每个已启用聊天身份相同。`relationshipFiles` 可省略以兼容旧配置；一旦配置，必须且只能包含 `owner`、`member` 两项，指向 `roles/` 下的非空 Markdown。当前分别为世凪共享性格、本人恋人和成员普通朋友背景，素材与边界见[文档25](../docs/25_人格、记忆与会话连续性.md)。

投影依据 `access-control.json` 校验后的可信角色选关系：本人 USER 为 `userFile` 加本人关系，成员 USER 为独立用户说明加成员关系；不把本人 USER、MEMORY或会话复制给成员。本人 AGENTS 沿用模板并要求替换源恰好出现一次，成员使用专用模板。关系不改变权限或成员工具上限。

角色/关系素材只接受 `roles/` 下的普通 `.md` 文件，拒绝路径穿越、符号链接、空内容和未替换的 `{{...}}` 占位符；身份名须为非空单行。同步前完整计算并校验投影，错误配置不写文件；每个目标文件分别原子替换且权限0600，多个文件不是一个事务。同步失败后重新检查漂移再处理，不宣称整组自动回滚。

本机 OpenClaw `2026.9.7` 每回合重新核对 bootstrap 文件；文档25的真实隔离宿主已验证同一会话 SOUL 更新生效。因此只同步这四份人格文件无需重启服务。新增身份/路由、工具或运行配置变更仍按各自契约同步并重启。旧聊天不重置，既有历史可能影响表达；人格同步不等于新增长期记忆或情绪持久化。

## 领域配置查询

参数以各插件schema、执行代码及`runtime.config.json`为依据；本节提供键与归属，详细业务解释只维护在领域文档。

| 领域 / 来源键 | 配置与同步边界 | 详细规则 |
| --- | --- | --- |
| 列表：`dataSource/bridgeBaseUrl/bridgeTokenFile/backendRoot/defaultTimes` | 共享工具及固定runner共同读取；`backendRoot`指持久`/home/afrangry/kurumi-fusion/chatbot`。`defaultTimes`只用于首次建库，个人设置不被同步覆盖 | [19](../docs/19_提醒列表与定时汇总.md)、[23迁移/切换](../docs/23_KnowledgeMap业务能力桥接.md#迁移) |
| 四领域：`plugins.entries.personal-{weather,profile,planning,reminders}` | 独立allow/load/开关；天气持天气参数，Profile持地理解析/默认城市桥接，一次性提醒的`reminderRunnerRoot`指持久reminders插件 | [21当前生产实现](../docs/21_后端职责分层与代码整理.md#当前生产实现) |
| 阅读：`kurumi-research.config.cacheRoot` | 显式缓存位置，不从QQ频道目录推导 | [21共享边界](../docs/21_后端职责分层与代码整理.md#共享代码与插件生命周期) |
| 记忆：`continuity.enabled/summaryTtlDays/maxContextChars` | 仓库为true/7/6000；TTL范围1–30天、缺省7；资料预算2000–12000字符、缺省6000 | [25存储与检索](../docs/25_人格、记忆与会话连续性.md#记忆存储与检索) |
| 连续性适配器：`continuityPolicyAdapter/continuityStoreAdapter` | 当前`current-owner/sqlite`，不与旧`policyAdapter/storeAdapter`混用；配置选择不自动迁移数据 | [25](../docs/25_人格、记忆与会话连续性.md)、[21兼容实现](../docs/21_后端职责分层与代码整理.md#兼容实现) |
| 旧本地列表/显式记忆：`policyAdapter/storeAdapter` | 缺省分别`default/sqlite`、`explicit/memory-file`；未知ID失败，连续性启用后旧记忆写入拒绝 | [21兼容实现](../docs/21_后端职责分层与代码整理.md#兼容实现) |
| 论文：`root/python/credentialsFile/liveTranslationEnabled` | 路径与付费开关属于受管配置；成员目录/任务绑定不靠模型参数选择，凭据不写入配置 | [22产物与运维](../docs/22_论文PDF翻译与文件投递.md#精确产物与运维)、[24隔离](../docs/24_统一身份与权限管理.md#资源与投递隔离) |
| 论文：`maxPages/maxRequests/maxReportedTokens/apiConcurrency/apiQps` | 源码缺省、仓库生产配置与可配置范围统一查参数表，模型不能改预算/并发 | [22默认资源](../docs/22_论文PDF翻译与文件投递.md#默认资源与用量限制) |
| 论文：`batchValidationRetries/channelRecoveryRetries/requestIdleTimeoutSeconds/timeoutSeconds` | 参数表包含缺省与范围；两类重试独立计数，共同受任务预算约束 | [22重试与时限](../docs/22_论文PDF翻译与文件投递.md#重试与渠道切换) |

四领域保留历史共库与旧Cron转发地址；列表切换标记、连续性SQLite、文档/任务归属属于运行状态，不由配置同步迁移。详情见21/23/25。论文队列、冷却、正文空闲与未知计费处理归22，本页不重复展开。

## 首次记忆迁移

连续性配置不自动导入旧事实，首次迁移先预览、私密备份再应用：

```bash
node chatbot/scripts/memory-migrate.mjs  # 只读预览
node chatbot/scripts/memory-migrate.mjs --apply \
  --backup-root /home/afrangry/.openclaw-fusion/migration
```

迁移会把原 `MEMORY.md` 保存到私密备份、建立 `.kurumi-memory/state.sqlite` 并把 `MEMORY.md` 替换为说明文本；已有连续性数据库若与导入事实不一致会拒绝覆盖。2026-10-20首次迁移完成时为revision=4、6条事实，后续修复版真人QQ复验已推进版本，不能将首次迁移号当作当前库版本；各时点见文档25。原文和配置备份在`/home/afrangry/.openclaw-fusion/migration/before-memory-p2-2026-10-19T16-53-12-652Z/`。记忆生命周期与遗忘边界见[文档25](../docs/25_人格、记忆与会话连续性.md#会话生命周期)。备份需验证新增的 `state/runtime/home/afrangry/.openclaw-fusion/workspace/.kurumi-memory/state.sqlite` 条目。

## 自检

```bash
node scripts/fusion/verify-dependencies.mjs   # 依赖自持、无归档树逃逸、版本与锁文件一致
node scripts/fusion/sync-config.mjs           # 运行配置是否与仓库一致（含删除项）
node scripts/fusion/sync-persona.mjs          # 角色卡是否与运行工作区一致
node scripts/fusion/health.mjs                # 服务、QQ、频道、数据库
```

这四项是**运行态对齐**检查：通过表示运行目录没有偏离仓库意图、服务当前健康。三项含义不同，不要互相替代：

| 概念 | 由什么证明 | 不证明什么 |
| --- | --- | --- |
| 配置对齐 | `sync-config.mjs`（漂移时非零退出）与 `sync-persona.mjs` | 代码已提交、已推送；模型风格符合主观预期 |
| 依赖自持 | `verify-dependencies.mjs` | 领域功能正确、隔离恢复可运行 |
| 服务健康 | `health.mjs` | 真实模型理解、真实 QQ 往返、提醒一定送达 |
| 版本收录 | `git status` / `git log` / 远端实查 SHA（见文档 12、15） | 运行配置与仓库一致 |

**四项自检全过不等于改动已提交或已推送。** 提交范围与远端同步状态必须单独用 Git 命令核对，
远端要看实查 SHA（`git ls-remote`），不能只看缓存的 `origin/main`。

## 恢复副本

生产配置包含本机路径，不能原样用于隔离启动。恢复工具会重映射配置、项目注册表和符号链接，换成测试凭据，并只在Bubblewrap中执行构建与Gateway探针。详见[验收总表](../docs/16_验收与测试总表.md)；不要直接运行恢复仓库中的生产启动脚本。

返回[文档入口](../docs/README.md)。
