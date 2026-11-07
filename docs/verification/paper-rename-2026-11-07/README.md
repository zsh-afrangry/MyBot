# 受管PDF对外名称维护

2026-11-07。专用rename动作已实现并独立验收，生产尚未授予`papers.rename`，没有修改实际论文。

37/37离线回归：`node --test chatbot/tests/papers/rename.test.mjs chatbot/tests/papers/mail.test.mjs chatbot/tests/papers/documents.test.mjs chatbot/tests/papers/jobs.test.mjs chatbot/tests/access-control/policy.test.mjs`。覆盖真实文档目录、CAS/幂等/旧元数据、危险名字/锁/字节损坏拒绝、输入/译稿独立、同内容再导入、新旧QQ名称及已确认旧邮件通过本机TLS SMTP发送原冻结名称和字节；主人缺新权限与成员拒绝，日志不记文件名。

[真实隔离宿主与模型](native-live.json)：OpenClaw2026.11.1、配置的主模型、真实论文/QQ插件，3/3通过。模型自行查询真实ID/版本后改名、不自动发送；明确请求后模拟OneBot收到新名；/new后按新名查到且不重发。PDF哈希/ID不变。翻译worker为夹具，本次没有启动翻译或请求翻译API；只使用合成PDF和临时状态，没有真实QQ/邮件或生产写入。

旧验收入口携带了两个已登记成员binding但只建立main，最初隔离启动被宿主配置校验拒绝；已仅在隔离夹具滤除不存在的agent绑定后重跑通过。生产身份表未改。

新权限启用由主人具体决定；真人QQ客户端的名称呈现和实际收件仍属于平台体验，开发侧已验证真实插件发出的字段及保持旧回执不重投的机制。
