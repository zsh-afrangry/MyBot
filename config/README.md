# 配置来源与同步契约

融合系统的配置分两层：**仓库是意图（intent），运行目录是事实与私密状态**。
本目录只保存可公开、无凭据的那一层。

## 目录分工

| 位置 | 内容 | 是否进 Git |
|---|---|---|
| `config/runtime.config.json` | 运行配置的**权威副本**：模型、agent、插件、频道、工具策略、日志 | ✅ |
| `roles/` | 角色卡（人格来源） | ✅ |
| `scripts/fusion/` | 部署、配置同步、备份与恢复 | ✅ |
| `docs/` | 运维与历史说明 | ✅ |
| `.openclaw-fusion/runtime-env.json` | **凭据平面**：API Key、网关 token、代理 | ❌ 仅私有备份 |
| `.openclaw-fusion/{http,ws}-token` | SnowLuma 会话令牌 | ❌ 仅私有备份 |
| `.openclaw-fusion/state/` | 记忆、提醒、天气、Profile、行程 | ❌ 仅私有备份 |
| `.openclaw-fusion/channel/` | 频道账本、贴纸目录、发送回执 | ❌ 仅私有备份 |
| `.openclaw-fusion/agents/` | 会话记录（JSONL）与 agent 库 | ❌ 仅私有备份 |
| `.openclaw-fusion/plugins/` | 受控第三方插件安装（含锁文件） | ❌ 可重建 |

`runtime.config.json` **不含任何真实凭据**。它引用凭据的方式只有两种，二者都指向运行目录：

- `${OPENCLAW_GATEWAY_TOKEN}`、`${QWEATHER_API_HOST}` —— 由 `run-gateway.mjs` 从
  `runtime-env.json` 展开为子进程环境变量；
- `{"source":"env","id":"DEEPSEEK_API_KEY"}` 这类 **SecretRef** —— 由 OpenClaw 在运行时按名字解析。

因此改配置时的规则很简单：**要改行为改仓库，要改密钥只改运行目录，两者都不要互相复制。**

## 同步契约

`scripts/fusion/sync-config.mjs` 是唯一的配置同步入口。

```bash
node scripts/fusion/sync-config.mjs            # --check（默认）：只报告漂移，不写入
node scripts/fusion/sync-config.mjs --apply    # 把仓库意图写入运行配置
node scripts/fusion/sync-config.mjs --diff     # 显示逐项差异
```

保证：

1. **只写 `openclaw.json`**。脚本不会打开、移动或删除 `state/`、`channel/`、`agents/`、
   `workspace/`、`media/` 或任何数据库与 JSONL，因此不可能覆盖记忆、提醒或聊天历史。
2. **保留运行态独有键**。`--apply` 采用合并：仓库里有的键覆盖过去，仓库里没有、
   只有 OpenClaw 自己写进去的键原样保留，并在输出里列出，让漂移可见。
3. **写入前先备份**。每次 apply 都会留下 `openclaw.json.bak.<时间戳>`。
4. **`--check` 在漂移时以非零码退出**，可直接接进启停脚本或自检。

## 改配置的正确姿势

| 想改什么 | 改哪里 | 之后做什么 |
|---|---|---|
| 人格 / 语气 | `roles/*.md`，再跑 `scripts/fusion/configure-deepseek-persona.mjs` | 重启服务 |
| 工具白名单 | `config/runtime.config.json` 的 `agents.entries.main.tools.alsoAllow` | `sync-config.mjs --apply` |
| 禁用某类工具 | 同上文件的 `tools.deny` / `tools.fs` | `sync-config.mjs --apply` |
| 插件开关或参数 | 同上文件的 `plugins.entries.<id>` | `sync-config.mjs --apply` |
| 发送限额 / 分段 | 同上文件的 `channels.kurumi-qq` | `sync-config.mjs --apply` |
| 搜索 provider | 同上文件的 `tools.web` | `sync-config.mjs --apply` |
| 轮换 API Key | **只改** `.openclaw-fusion/runtime-env.json` | 重启服务 |
| 升级第三方插件 | `scripts/fusion/lib/plugins.mjs` 的版本表 | `install-plugins.mjs` 后跑验收 |

## 自检

```bash
node scripts/fusion/verify-dependencies.mjs   # 依赖自持、无归档树逃逸、SDK/插件版本
node scripts/fusion/sync-config.mjs           # 运行配置是否与仓库一致
node scripts/fusion/health.mjs                # 服务、QQ、频道、数据库
```

三项都通过，才算"改动已经记进版本且没有让系统偏离仓库"。
