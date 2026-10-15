# Policy/Store 可插拔与调用链复验

2026-10-16（Asia/Shanghai）。规则、接口、决策与开发记录见[文档 21](../../../21_后端职责分层与代码整理.md)。本目录只保存本次复验，不覆盖初轮证据。

| 证据 | 结论与边界 |
| --- | --- |
| [node-tests.txt](node-tests.txt) | 179/179；包含 9 项新增适配器回归、实际插件工具的独立策略/存储替换、不可覆盖的入站校验、存储版本及关闭检查、调度/runner 同源与错绑拒绝 |
| [confirmation-core-tests.txt](confirmation-core-tests.txt) | 17/17，共享确认 |
| [confirmation-inbound-tests.txt](confirmation-inbound-tests.txt) | 15/15，可信确认入站 |
| [weather-tests.txt](weather-tests.txt) | 162/162，天气/Profile/行程/一次性提醒 |
| [model/model.json](model/model.json) | 7/7，真实配置的 DeepSeek + 实际插件工厂，合成入站/隔离库；序号对应此前展示的列表，新增事项改变排序后仍选对 ID；否定/假设和无列表澄清 |
| [host/host.json](host/host.json) | 6/6，真实 OpenClaw、配置模型、入站及新组合模块加载，独立运行目录和模拟 OneBot；新增/修改/完成/调时刻/暂停/恢复通过，隔离进程已结束 |
| [report.json](report.json) | 最终构建、自检、索引、文档链接与加载摘要，不复制生产业务数据 |

共 373/373。三个 TypeScript 包构建通过。扩展回归位于 `chatbot/tests/domain-adapters/`；默认实现的一致性由原领域/事务/重放/版本测试继续覆盖。独立替换夹具只用于验证接口消费，不声明其为可部署存储。

复现命令：

```bash
node --test chatbot/tests/domain-adapters/*.test.mjs chatbot/tests/reminder-list/*.test.mjs chatbot/tests/backend-boundaries/*.test.mjs chatbot/plugins/kurumi-memory/test/*.test.js
node chatbot/tests/reminder-list/acceptance-model.mjs --ordinal --out docs/verification/backend-refactor-2026-10-16/adapters/model
node chatbot/tests/reminder-list/acceptance-host.mjs --out docs/verification/backend-refactor-2026-10-16/adapters/host
```

完整离线包命令见[初轮报告](../README.md)，其 Node 命令额外追加 `chatbot/tests/domain-adapters/*.test.mjs` 即覆盖本轮集合。

两份真实模型/宿主报告均确认生产数据库指纹不变。没有真实 QQ/邮件发送，没有把生产数据库用于测试，没有更换生产存储或迁移其数据，没有重打快照、更新后台副本或推送远端。服务重载与配置/人格同步的具体结果见 `report.json`。
