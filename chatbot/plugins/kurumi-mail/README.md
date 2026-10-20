# kurumi-mail

本人私聊的邮件草拟与投递插件。**业务规则、凭据步骤、唯一收件人配置来源和验收边界统一见[文档20](../../../docs/20_邮件能力与横切扩展.md)**；身份与功能授权见[文档24](../../../docs/24_统一身份与权限管理.md)。本页只说明组件开发入口，不另列配置副本或当前白名单。

- `index.js`登记四个email工具与可注销的确认backend；`inbound.js`先检查共享access-control与可信scope。
- `application.js`通过 `adapters.js` 选择Policy/Store，默认default/sqlite；未知id明确失败，替换同步Store必须覆盖确认与附件读取。
- `service.js`编排发送，`store.js`保存草稿/快照/确认/审计；异步SMTP留在服务层，不注册成同步Store。
- `mime.js`与 `smtp.js`负责MIME和465隐式TLS协议。凭据来自运行环境，To/Cc来自受管派生名单；不在运行配置里手改allowedRecipients。

```bash
npm --prefix chatbot/plugins/kurumi-mail test
```

`test/fixtures/`的自签证书仅供本地mock服务器；上述测试不发送真实邮件。真实投递脚本的授权与副作用见[脚本索引](../../../docs/verification/SCRIPTS.md)，不要批量运行acceptance或运维脚本。
