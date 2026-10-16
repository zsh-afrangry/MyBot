# 注册表同步返回与注销身份补正

2026-10-16（Asia/Shanghai），基于 `1fc0ca3`。范围与契约见[文档 21](../../../21_后端职责分层与代码整理.md)和[包说明](../../../../chatbot/packages/domain-adapters/README.md)。本次只修复共享注册库，不更改领域语义、存储选择或数据格式。

修复前先添加两项定向回归，注册表测试为 **4 过 / 2 失败**：普通 `read()` 返回 Promise 没有抛错；同一工厂注销后重新注册，旧句柄将新注册删除。原有 9 项适配器测试没有覆盖这两个分支。

| 证据 | 结论 |
| --- | --- |
| [node-tests.txt](node-tests.txt) | 201/201（含子测试），适配器部分 31/31。覆盖读/写/事务/关闭的 fulfilled/rejected Promise 和 thenable，旧句柄隔离、固定选择、冻结对象/私有字段/getter/附加资源读取，非法打开的资源清理；无未处理 rejection |
| 同份 Node 输出中的两组实际领域回归 | 临时 SQLite 的 `addItem` 与 `recordRequest` 先执行写入再返回 Promise：同步服务拒绝，业务数据/审计/请求账本全部回滚。记忆写入 Promise 被拒绝，不缓存成功结果且正常关闭资源 |
| [confirmation-core-tests.txt](confirmation-core-tests.txt)、[confirmation-inbound-tests.txt](confirmation-inbound-tests.txt)、[weather-tests.txt](weather-tests.txt) | 17/17、15/15、162/162；与 Node 合计 **395/395** |
| [builds.txt](builds.txt) | 三个 TypeScript 包构建，注册库和两个领域接口的 strict 声明检查通过 |
| [selfchecks.json](selfchecks.json)、[runtime.json](runtime.json) | 依赖自持、配置 13 键零漂移、人格 4 文件一致、健康通过；服务 09:19:46 CST 重载，QQ 在线、testIngress=false；runtime 含已重载源码的 SHA-256 |
| [documentation.json](documentation.json)、[report.json](report.json) | 本轮文档链接、证据/脚本索引和复验结果摘要 |

复现专项：

```bash
node --test chatbot/tests/domain-adapters/*.test.mjs
```

完整 Node 回归在[初次可插拔报告](../adapters/README.md)所列集合执行，构建与其余回归按[文档 10](../../../10_融合助手运行维护.md#开发与验证)。所有新增测试位于现有 `chatbot/tests/domain-adapters/{registry,integration}.test.mjs`，使用临时状态；没有新增生产探针或运行注册。

边界：本次未重跑真实模型对话或隔离 OpenClaw 宿主；其 7/7、6/6 证据仍属于前一阶段。没有测试 QQ/邮件外发、生产数据迁移、远端写入、快照或后台副本同步；并行邮件文档修改保留。接口返回值检查不能取消适配器已经启动的异步副作用，也不能证明其内部事务语义。
