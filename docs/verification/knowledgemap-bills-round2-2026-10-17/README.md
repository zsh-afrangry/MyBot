# 文档23第二轮验收证据

规则、需求、决定和开发记录唯一入口：[文档23](../../23_KnowledgeMap业务能力桥接.md#10-第二轮账单完整维护与调用链优化)。网站端契约和测试位于 `/home/afrangry/repository/docs/18_助手业务接口与共享数据.md`。本目录不存生产token或私聊原文。

| 文件 | 范围与结论 |
| --- | --- |
| `host.json` | 真实模型+隔离OpenClaw/HTTP/SQLite，14组通过；18条业务事件的runId逐条属于真实宿主transcript。新增金额算式、语义修改、网页修改后查询、new后实际删除、同名两笔澄清；账单schema首次参数错误0，模拟OneBot外发0，生产提醒状态未变 |
| `live.json` | 真实模型/生产API/MySQL/网页/天气，合成本人入站10组通过；12条API事件runId关联。测试ID4/5/6已清理，原有账单逐字段不变，入口关闭，回执保留；不发QQ |
| `migration.json` | 真实定向DDL仅新增bills.version；原1账单/19事项/37标签的业务行数和哈希保持 |
| `validation.json` | API43、账单13、桥接32、列表/日志54、天气162、网页9、临时MySQL恢复/强制并发6组，代码668+221文件恢复、构建及引用检查；额外只读核对真实歧义回复与3条后端写日志runId |

上述层次分别验收，不能累加成一个“全部功能通过”指标。实现提交Fusion `97ed797`、KnowledgeMap `1efec0e`；文档/SQL结构快照及证据收尾在后续本地提交中。隔离宿主不证明手机QQ真人往返；合成入站的生产测试也不冒称真人消息。模型可能错选分类再纠正；业务保持严格拒绝无效参数，本轮schema错误0不表示模型永不犯错。

变更前代码备份 `knowledgemap-bills-round2-2026-10-17-code`、共享MySQL备份 `knowledgemap-bills-round2-2026-10-17-mysql` 位于 `/home/afrangry/kurumi-backups/`；分时采集，非跨系统停写快照。代码包逐文件哈希与HEAD恢复通过；MySQL源1账单/19事项/37标签完整还原到唯一临时库，迁移/重跑无操作/版本与强制并发重放6组通过，临时库已删除。

本轮没有新的Fusion全量状态恢复演练或真人QQ新增外发；完整旧快照继续按首轮范围解释。共享默认城市、批量、删除撤销、TradeSim和Notes不在本轮。不同请求版本冲突与同键重试回执重放均保留。所有新脚本在[SCRIPTS](../SCRIPTS.md)及机器分类中登记，网站测试归网站文档18「测试与脚本」。

返回[证据索引](../INDEX.md)。

<a id="historical-material"></a>

## 历史原始材料的保留位置

本目录生成的原始回执、日志和图片已退出活动树；既有结论及失败状态不因此改变，也不代表新版已验收。已入Git的内容可用 `git show c849e63:<原仓库相对路径>` 读取；表中的blob标识可核对原始字节。未入Git的临时输出按本次清理授权丢弃。当前执行状态只在全局《整理记录.md》维护。

| 原文件 | 原报告顶层字段（仅摘录） | Git blob |
| --- | --- | --- |
| `host.json` | passed=True；at=2026-10-17T05:22:36.462Z | `41d2893a411dae09300b5a970a879e13e53cc286` |
| `live.json` | ok=True；at=2026-10-17T05:27:31.189Z | `450202edf3248e80df9b493a5f4dfe15ca4ba2dd` |
| `migration.json` | ok=True；at=2026-10-17T05:26:52.962992+00:00 | `b973eb0343128cf058b55474b38affdb30d78526` |
| `validation.json` | ok=True；at=2026-10-17T05:32:35.608643+00:00 | `233807a7c4cefd787fa2d2583a78ab8f659cbc5f` |
