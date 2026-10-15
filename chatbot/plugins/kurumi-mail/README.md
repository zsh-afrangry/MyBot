# kurumi-mail

主人私聊专用的邮件草拟与投递能力，走共享确认闸门。规则与决策见[文档 20](../../../docs/20_邮件能力与横切扩展.md)。

## 边界

- **仅主人私聊**：每个工具在执行时用 `ownerAuthorized` 校验（四重校验，含 `direct:` 会话），非主人上下文直接报错。
- **发送前必须确认**：草稿经 `@kurumi/confirmation-core` 生成提案与确认口令；只有主人本人在私聊里回复该口令，
  宿主才会记录授权。模型无法自行批准。
- **凭据不出现在任何输出里**：工具不回显授权码，审计表不写凭据，错误信息只带协议状态码。

## 配置（需要主人操作）

凭据只放在运行目录的凭据平面，不进 Git：

```bash
# 1) QQ 邮箱 → 设置 → 账户 → 开启 SMTP 服务 → 生成授权码（不是 QQ 密码）
# 2) 写入运行环境（示例键名；值由你填写，助手不读取也不回显）
$EDITOR /home/afrangry/.openclaw-fusion/runtime-env.json
```

需要的键：

| 键 | 说明 |
| --- | --- |
| `KURUMI_MAIL_USER` | 发件邮箱地址，例如 `365999865@qq.com` |
| `KURUMI_MAIL_AUTH_CODE` | SMTP 授权码（QQ 邮箱生成的那一串，不是登录密码） |
| `KURUMI_MAIL_HOST` | 可选，默认 `smtp.qq.com` |
| `KURUMI_MAIL_PORT` | 可选，默认 `465`（隐式 TLS） |

`run-gateway.mjs` 会把该文件的键展开成网关进程的环境变量，因此改完需要重启 `kurumi-fusion.service`。

## 工具

| 工具 | 作用 |
| --- | --- |
| `email_status` | 报告是否已配置（发件账号、SMTP 主机端口），**不回显授权码**；`probe=true` 时额外做一次真实 TLS 连接与认证，不发信 |
| `email_draft` | 创建待确认草稿，返回确认口令、预览与草稿 ID；**不发信** |
| `email_send` | 投递已获批准的草稿；没有授权时返回 `approval_required` 且不发信；重复发送被拒 |
| `email_outbox` | 列出草稿与状态、读取审计、取消待确认草稿（只读，除取消外） |

## 测试

```bash
cd chatbot/plugins/kurumi-mail
npm test        # 47 个用例：MIME 编码、SMTP 协议、闸门、端到端
```

测试对**本地 mock SMTP 服务器**跑真实 TLS 与真实 SMTP 对话（自签证书在 `test/fixtures/`，仅测试用），
不联网、不发真实邮件。其中最关键的一条是负向断言：**主人确认之前，服务器收到的邮件数必须为 0**——
这个数字来自服务器本身，不是本地计数。

## 已知边界

- 只支持纯文本正文（`html` 会被拒绝），附件上限 10 个、单个 10 MiB。
- 收件人白名单**尚未实现**（按主人决定排在最后）；当前任何合法地址都可作为收件人。
- 只发信，不收信（无 IMAP）。
- 当前只验证过 QQ 邮箱的 465 隐式 TLS；Gmail 需要先解决非 HTTP 协议的代理接入（见文档 20）。
