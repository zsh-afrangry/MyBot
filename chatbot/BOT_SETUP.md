# QQ Bot 当前状态与启用说明

当前工作区：`/home/afrangry/.openclaw/chatbot`

已完成：

- OpenClaw 与官方 QQ Bot 插件已安装。
- Gateway 仅监听本机 `127.0.0.1:18789` / `::1:18789`，并已作为用户服务启用。
- 已禁用命令执行、提权、主机文件访问与浏览器控制。
- QQ 私聊已启用，仅允许主人 OpenID 白名单。
- QQ 群聊为安全测试模式：仅允许主人触发、必须 @机器人，且文件、命令和 coder Agent 类工具保持禁用。
- 文件隔离目录：`inbox/`、`processing/`、`output/`。

## 凭证文件

实际运行凭证文件是 `~/.openclaw/.env`（权限 600），而不是本工作区的 `.env`。
OpenClaw 会刻意忽略工作区 `.env` 内的模型 API Key，避免附件或工作区内容注入凭证；因此不要在此目录复制真实密钥。

模板在 `openclaw.env.template`。当需要重新配置或轮换凭证时，根据模板更新实际的 `~/.openclaw/.env`：

- `QQBOT_APP_ID`
- `QQBOT_APP_SECRET`
- 所选模型提供商对应的 API Key（模板默认 `OPENAI_API_KEY`）
- 天气服务的 API Key 和专属 Host（插件代码已完成本机验收，但尚未链接安装或授权）

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

当前模型与 QQ 文本对话已验收。天气插件只完成了代码与本机真实 API 验收，尚未
安装、准入模型或创建 Cron，因此仍不属于线上能力。Markdown、图片、语音和文件
也需按开发备忘录逐项验收；不要把未授权能力描述成已上线。
