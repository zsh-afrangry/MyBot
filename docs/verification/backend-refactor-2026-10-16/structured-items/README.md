# 提醒列表已有项调用链验收

规则与开发记录见[文档 21](../../../21_后端职责分层与代码整理.md)。2026-10-16。

- [offline-tests.txt](offline-tests.txt)：59/59，真实工具工厂/临时 SQLite；涵盖原三种表达、旧工厂、跨会话、过期、版本、事务与幂等。
- [model.json](model.json)：7/7，真实配置的 DeepSeek、实际插件工具与合成可信入站，隔离数据库。展示六项后插入一项改变数据库排序，仍删除此前展示的第六项；完整标题加“删掉”/“作废”、否定、假设及新会话无列表先澄清通过。

复现：`node --test chatbot/tests/reminder-list/*.test.mjs chatbot/tests/backend-boundaries/*.test.mjs`；`node chatbot/tests/reminder-list/acceptance-model.mjs --ordinal --out docs/verification/backend-refactor-2026-10-16/structured-items`。

生产数据库指纹前后相同。没有生产 QQ 外发、没有真实聊天入站、没有修改生产 Cron。本报告不把模型样例通过当作任意自然语言零误解的保证。
