# 配置来源与同步契约

融合系统的配置分两层：**仓库是意图（intent），运行目录是事实与私密状态**。
本目录只保存可公开、无凭据的那一层。

## 目录分工

| 位置 | 内容 | 是否进 Git |
|---|---|---|
| `config/runtime.config.json` | 运行配置的**权威副本**：模型、agent、插件、频道、工具策略、日志 | ✅ |
| `config/persona.json` | 当前角色声明（角色卡文件、身份名、AGENTS 替换） | ✅ |
| `config/plugins.package.json` + `config/plugins.package-lock.json` | 第三方插件清单与锁文件 | ✅ |
| `roles/` | 角色卡（人格来源） | ✅ |
| `scripts/fusion/` | 部署、配置同步、备份与恢复 | ✅ |
| `docs/` | 运维与历史说明 | ✅ |
| `.openclaw-fusion/runtime-env.json` | **凭据平面**：API Key、网关 token、代理 | ❌ 仅私有备份 |
| `.openclaw-fusion/{http,ws}-token` | SnowLuma 会话令牌 | ❌ 仅私有备份 |
| `.openclaw-fusion/workspace/` | **长期记忆 `MEMORY.md`**、`SOUL.md`、`IDENTITY.md`、`AGENTS.md`、`USER.md` | ❌ 仅私有备份 |
| `.openclaw-fusion/state/` | 提醒、天气、Profile、行程（SQLite） | ❌ 仅私有备份 |
| `.openclaw-fusion/channel/` | 频道账本、贴纸目录、发送回执 | ❌ 仅私有备份 |
| `.openclaw-fusion/agents/` | 会话记录（JSONL）与 agent 库 | ❌ 仅私有备份 |
| `.openclaw-fusion/{code,research}-workspace/`、`project-checks/`、`research-cache/` | 后台任务与研究的隔离工作区、检查夹具、缓存 | ❌ 仅私有备份 |
| `.openclaw-fusion/plugins/` | 受控第三方插件安装（由仓库锁文件重建） | ❌ 可重建 |

> **记忆不在 `state/` 里。** 长期记忆是 `workspace/MEMORY.md`（由 `kurumi-memory` 插件读写），
> `state/personal-weather/weather.sqlite` 存的是 Profile/行程，`state/personal-reminders/` 存提醒。
> 备份应包含整个运行目录的必需内容，仅备份 `state/` 会遗漏记忆。

`runtime.config.json` **不含任何真实凭据**。它引用凭据的方式只有两种，二者都指向运行目录：

- `${OPENCLAW_GATEWAY_TOKEN}`、`${QWEATHER_API_HOST}` —— 由 `run-gateway.mjs` 从
  `runtime-env.json` 展开为子进程环境变量；
- `{"source":"env","id":"DEEPSEEK_API_KEY"}` 这类 **SecretRef** —— 由 OpenClaw 在运行时按名字解析。

因此改配置时的规则很简单：**要改行为改仓库，要改密钥只改运行目录，两者都不要互相复制。**

## 同步契约

`sync-config.mjs` 是唯一的运行配置同步入口。

```bash
node scripts/fusion/sync-config.mjs            # --check（默认）：只报告漂移，不写入
node scripts/fusion/sync-config.mjs --diff     # 逐项差异 + 删除项 + 运行态独有键
node scripts/fusion/sync-config.mjs --apply    # 把仓库意图写入运行配置
```

### 仓库全权管理 vs 宿主自行维护

`runtime.config.json` 顶部的 `_managed` 列出**仓库全权拥有**的顶层键
（当前：`agents`、`bindings`、`channels`、`commands`、`discovery`、`gateway`、`logging`、
`models`、`plugins`、`secrets`、`session`、`skills`、`tools`）。语义是：

- **`_managed` 里的键：整棵子树由仓库替换**。所以从仓库删掉一个插件条目、一个模型 provider
  或一段工具策略，`--apply` 会**真的删掉**它；`--check` 也会把"运行态里还有、仓库里已删"
  报成漂移并以非零码退出。
- **不在 `_managed` 里的键：宿主自行维护，原样保留**，并在 `--diff` 里列为
  `RUNTIME-ONLY` 提示。

### 保证

1. **只写 `openclaw.json`**。脚本不会打开、移动或删除 `state/`、`channel/`、`agents/`、
   `workspace/`、`media/` 或任何数据库与 JSONL，因此不可能覆盖记忆、提醒或聊天历史。
2. **写入前先备份**为 `openclaw.json.bak.<时间戳>`（mode 600）。
3. **`--check` 在漂移时以非零码退出**，可直接接进启停脚本或自检。

## 改配置的正确姿势

| 想改什么 | 改哪里 | 之后做什么 |
|---|---|---|
| 人格 / 语气 | `config/persona.json` 的 `roleFile`（角色卡在 `roles/`） | `sync-persona.mjs --apply`，再重启服务 |
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
