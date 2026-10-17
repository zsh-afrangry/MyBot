# 文档23第二轮验收证据

规则、需求、决定和开发记录唯一入口：[文档23](../../23_KnowledgeMap业务能力桥接.md#10-第二轮账单完整维护与调用链优化)。网站端契约和测试位于 `/home/afrangry/repository/docs/18_助手业务接口与共享数据.md`。本目录不存生产token或私聊原文。

| 文件 | 范围与结论 |
| --- | --- |
| `host.json` | 真实模型+隔离OpenClaw/HTTP/SQLite，14组通过；18条业务事件的runId逐条属于真实宿主transcript。新增金额算式、语义修改、网页修改后查询、new后实际删除、同名两笔澄清；账单schema首次参数错误0，模拟OneBot外发0，生产提醒状态未变 |

其他回归、部署和生产标记记录测试的结果正在补充；未列出的阶段不视为已完成。隔离宿主不证明手机QQ真人往返；合成入站的生产测试也不冒称真人消息。

变更前代码备份 `knowledgemap-bills-round2-2026-10-17-code`、共享MySQL备份 `knowledgemap-bills-round2-2026-10-17-mysql` 位于 `/home/afrangry/kurumi-backups/`；分时采集，非跨系统停写快照。代码包逐文件哈希与HEAD恢复通过；MySQL源1账单/19事项/37标签完整还原到唯一临时库，迁移/重跑无操作/版本与强制并发重放6组通过，临时库已删除。

返回[证据索引](../INDEX.md)。
