# 正文无进展超时

归属：[文档22](../../../22_论文PDF翻译与文件投递.md)；总索引：[INDEX](../../INDEX.md)。开发基线 `0b8366c`，起点工作区干净；主人授权改动并部署，之后由本人在QQ实测全流程。

状态：**开发、离线回归和部署检查通过；本人QQ全流程待复验。** 新增100秒正文无进展计时，按单请求开始/最后有效正文计时，不被心跳、创建请求、隐藏思考或纯空白延长；总请求600秒与整篇1800秒继续约束。超时终止一次性HTTP子进程，只重试当前批次，沿用厂商内渠道/冷却/有限恢复及预算；不自动重启整篇。日常并发4/QPS1保持，不以此前单次6测试改变默认。

已完成：操作者配置 `requestIdleTimeoutSeconds=100`（整数1–600）从仓库/schema，经固定worker stdin、引擎和客户端传入HTTP监督进程。只有非空白 `response.output_text.delta` 发送无正文的进程内活动时间戳；不逐token写用量文件、不采集思考文本。超时回执为 `api_output_idle_timed_out_unknown`，含 `timeoutKind=output_idle`、空闲时长、阈值、是否已出现正文；沿用共享冷却与有界切换，旧600秒总期限独立。

回归合计 **110/110**，全部离线或本机HTTP/实际子进程，没有付费API、QQ或SMTP外发。HTTP测试使用0.2–0.6秒缩短期限验证真实等待、杀进程/回收、同批次014→030切换与三渠道有界耗尽；100秒默认及操作者范围另有配置/schema/实际worker贯通检查。不能据此声称真实网络已提速或上游停止计费。

| 证据 | 结论与边界 |
| --- | --- |
| [node-tests.txt](node-tests.txt) | 36/36：操作者100秒默认/范围、实际隔离stdin及既有产物/预算/权限等回归 |
| [responses-tests.txt](responses-tests.txt) | 20/20：协议、用量、凭据与错误处理 |
| [concurrency-tests.txt](concurrency-tests.txt) | 11/11：4/6并发、额外请求排队及共享计账/冷却 |
| [engine-tests.txt](engine-tests.txt) | 15/15：安装引擎与参数贯通、产物选择；无真实翻译 |
| [reliability-tests.txt](reliability-tests.txt) | 28/28：无头/静默/心跳/思考/空白、正文重置/停滞、独立总期限、切换及进程回收；保留批次与冷却回归 |
| [deployment-before.json](deployment-before.json) | 同步前无queued/running或dispatching任务，原配置无空闲键、日常4/QPS1 |
| [captured-worker.json](captured-worker.json) | 重载后生产捕获Node/Python与源码hash一致，真实Bubblewrap可导入、100秒配置/错误分类贯通；不调用API |
| [health.json](health.json) | Gateway/QQ/频道/业务数据库健康，testIngress=false |
| [dependencies.txt](dependencies.txt)、[config-check.txt](config-check.txt)、[persona-check.txt](persona-check.txt) | 依赖自持、受管配置与人格对齐 |
| [closeout.json](closeout.json) | 部署后配置/服务、源码hash、证据/脚本索引、本地文件链接和私密范围收尾核对 |

部署只新增受管100秒配置，`sync-config --apply`保存私密运行配置备份后重载 `kurumi-fusion.service`；没有改数据库、SQL、依赖、权限、旧系统/归档或文档23。本轮本地提交见Git历史，不推送；恢复点未重打。已在文档22/16、总索引和脚本索引登记。

后续由本人QQ验证上传/获取PDF→模型调用→真实翻译→收件；重点比较成功率、耗时及回执中的空闲超时、014/030/040、冷却/未知用量。保留原论文与失败回执，不自动重跑旧付费任务。

关键边界：没有可见正文不能证明上游没有思考/计费；本地终止不保证上游停止。新超时回执记为未知用量，不采用未完成增量作为译文。
