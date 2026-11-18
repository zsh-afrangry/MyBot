# 验收基础设施与历史入口

当前功能验收入口见各领域 `chatbot/tests/<领域>/` 和[文档索引](../../../docs/README.md)，脚本副作用的判断规则见根目录 [AGENTS.md](../../../AGENTS.md#需要单独授权的操作)。本目录不作为全项目批量测试入口。

本次升级在 `access-control`、`host-exec`、`persona`、`coding`、`e7` 等领域的独立宿主测试中验证当前 Fusion 通道、可信身份和工具契约。确定性测试只使用临时状态、本地模型替身和模拟投递；`acceptance-live`、`acceptance-model` 等真实外部调用必须按各脚本声明取得授权。

本目录当前保留：

- `call-analysis.mjs`、`call-analysis.test.mjs` 及两份 `fixtures/`：仍在使用的回合/调用结果分析回归，可离线运行 `node --test chatbot/tests/acceptance/call-analysis.test.mjs`。
- `host-driver.mjs`、`domain-fixture.mjs`、`run.mjs`、`verify-restart.mjs`：历史确认流程的隔离基础设施，合成身份、临时数据库和本地回复收集，不证明当前 QQ 网络链路。
- 真实模型、GeoAPI、Cron 入口：用于追溯旧验收方法；部分依赖融合前配置与 `KURUMI_SOURCE_ROOT`，不保证兼容当前内核。不得根据旧结果宣称新版通过。`run-real-cron.mjs` 已按现行驱动修复，文件头写明了范围。

依赖腾讯 `qqbot`、旧源码安装索引及私有 dist 导出的 `run-retrieval-smoke.mjs`、`run-retrieval-host.mjs` 和专用 `retrieval-config.mjs` 已退役，可从 Git `90a02a6` 追溯。现行 Fusion 使用自研 OneBot `kurumi-qq`；原 2026-10-01/04 的检索结论仍属历史，不再保留失效运行命令。

旧模型基础提示词是 [fixtures/legacy-system-prompt.md](fixtures/legacy-system-prompt.md)，只供 `model-driver.mjs` 读取，不是当前运行规则。旧完整运行归档已退役，禁止使用不存在的 `2026-10-05-pre-consolidation` 路径作为恢复说明。当前恢复以文档12规定的 v3 恢复点及其配套工件为准。
