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

## 收件人白名单

收件人受 `plugins.entries.kurumi-mail.config.allowedRecipients` 限制（**精确地址，不支持通配符**）：

```json
"kurumi-mail": { "enabled": true, "config": { "allowedRecipients": ["365999865@qq.com"] } }
```

- **未配置时按"全部拒绝"处理**（fail-closed）：不会出现"看着有保护、其实什么都没拦"的情况。
  拒绝信息里会写明该去哪个配置项加地址。
- `To` 与 `Cc` 都受同一名单约束；比较时忽略大小写与首尾空格。
- 草稿创建时与投递前**各校验一次**：即使草稿建好后名单被收紧，也不会被投递出去。
- 策略拒绝会保留主人的授权（什么都没发出，就没有消耗），名单放开后仍可发送。

## 实现选择（适配器）

策略与存储通过共享注册表选定，默认组合是 `default` + `sqlite`：

```json
"kurumi-mail": { "enabled": true, "config": {
  "allowedRecipients": ["365999865@qq.com"],
  "policyAdapter": "default",
  "storeAdapter": "sqlite"
} }
```

- 换实现只需在 `adapters.js` 注册并在配置里选 id，**不必改工具、确认后端或服务**；
  确认后端取的是 `application.openStore(...)`，因此同样跟随所选存储。
- **未知 id 会在加载时明确失败**（`Unavailable mail adapter selection`），不会静默回退。
- `email_status` 会报告当前生效的 `policyAdapter` / `storeAdapter`。
- 存储契约是**同步**的：返回 Promise 的 store 会被注册表直接拒绝；投递是异步动作，因此它在服务层。

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

## 真实投递验收

```bash
node scripts/fusion/test-mail-delivery.mjs --to 365999865@qq.com --dry-run   # 只建草稿，不批准不发信
node scripts/fusion/test-mail-delivery.mjs --to 365999865@qq.com             # 真实外发，需主人授权
```

脚本用真实授权码走真实 SMTP，并把记录写进生产状态库。它**只证明投递链路可用**：
确认步骤由脚本调用宿主路由用的同一个 store 方法记录，**不是** QQ 里的真实往返；
到信与否也只有主人能确认。脚本属于"需要授权"的一类，见[文档 16](../../../docs/16_验收与测试总表.md)。

## 已知边界

- 只支持纯文本正文（`html` 会被拒绝），附件上限 10 个、单个 10 MiB。
- 收件人白名单已实现（见上），当前只放行 `365999865@qq.com`。
- 只发信，不收信（无 IMAP）。
- 当前只验证过 QQ 邮箱的 465 隐式 TLS；Gmail 需要先解决非 HTTP 协议的代理接入（见文档 20）。
