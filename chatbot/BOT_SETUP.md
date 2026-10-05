# QQ Bot 当前状态与启用说明

当前工作区：`/home/afrangry/kurumi-fusion/chatbot`（融合项目的源码工作区）

> 历史说明：本文档早期描述的是旧 `/home/afrangry/.openclaw/chatbot` 工作区与其
> `/openclaw 18789` 端口方案。当前融合运行时是 `/home/afrangry/.openclaw-fusion`，
> 由 `scripts/fusion/run-gateway.mjs` 在 `127.0.0.1:18890` 启动，QQ 传输走 SnowLuma
> （3083 发送 / 3084 事件）。旧目录已归档，不再是运行依赖。

已完成：

- OpenClaw 与官方 QQ Bot 插件已安装。
- Gateway 仅监听本机 `127.0.0.1:18789` / `::1:18789`，并已作为用户服务启用。
- 已禁用命令执行、提权、主机文件访问与浏览器控制。
- QQ 私聊已启用，仅允许主人 OpenID 白名单。
- QQ 群聊为安全测试模式：仅允许主人触发、必须 @机器人，且文件、命令和 coder Agent 类工具保持禁用。
- 文件隔离目录：`inbox/`、`processing/`、`output/`。

## 凭证文件

运行凭证**不在**本工作区，也不在旧 `.openclaw` 目录。融合运行时的凭证平面是
`/home/afrangry/.openclaw-fusion/runtime-env.json`（JSON，权限 `600`），由
`scripts/fusion/prepare.mjs` 与 `scripts/fusion/configure-*.mjs` 写入、由 `run-gateway.mjs`
作为子进程环境加载。OpenClaw 会刻意忽略工作区 `.env` 内的模型 API Key，避免附件或工作区
内容注入凭证；因此不要在此目录复制真实密钥。

变量清单模板在项目根目录的 `gateway.systemd.env.example`。当需要重新配置或轮换凭证时：

- `OPENCLAW_GATEWAY_TOKEN`
- 当前模型提供商对应的 API Key（DeepSeek 为主模型；按实际 provider 契约启用）
- `TAVILY_API_KEY`（联网搜索 provider）
- 天气服务的 `QWEATHER_API_KEY` 与专属 `QWEATHER_API_HOST`（Key 通过 SecretRef 从环境读取）

旧 `/home/afrangry/.openclaw/gateway.systemd.env` 已归档，仅存在于恢复备份中，新系统不再读取它。

`chatbot/openclaw.env.template` 仅为旧文档保留的兼容指针，不再单独维护变量清单。不要把 Key
写入 `openclaw.json`，也不要提交到 Git。

QQ 的 `clientSecret` 已配置为从 `QQBOT_APP_SECRET` 环境变量读取，不会写入 `openclaw.json`。QQ AppID 不是密钥，但需要同步写入配置。

## 重新配置 QQ（仅在凭证或账号变更时）

在终端执行以下命令；不要把密钥粘贴进聊天、截图或 shell 历史：

```bash
read -rp 'QQ AppID: ' QQ_APP_ID
openclaw config set channels.qqbot.appId "$QQ_APP_ID"
unset QQ_APP_ID
openclaw config set channels.qqbot.allowFrom '["替换为你的 QQ OpenID"]'
openclaw config set channels.qqbot.enabled true
openclaw gateway restart
openclaw channels status --deep
```

当前模型与 QQ 文本对话已验收。天气插件已链接安装，`personal_weather_get_brief`、
`personal_planning_state_get` 和 `personal_planning_change_propose` 已精确准入主人
私聊；群聊显式拒绝这三个工具。天气
模型调用回归和 QQ 主动发送 API 回执已通过；每日 10:30 Cron 已正式启用。
主人已确认收到第一次主动测试和第二条 Cron 真实简报。手动 Cron 回归为
`ok/delivered`，每日任务现已启用，将按 Asia/Shanghai 每天 10:30 运行。
Markdown、图片、语音和文件也需逐项验收；P2A 提案工具只生成 pending 预览，不提交
行程、不切换地点、不修改提醒或 Cron；不要把未授权能力描述成已上线。
