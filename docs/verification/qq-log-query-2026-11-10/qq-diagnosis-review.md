# 真实QQ日志诊断报告复核（2026-11-10）

状态：基础查询可用，诊断完整性待复验。本次按主人提供的02:24诊断报告，只读对照实际工具调用、宿主会话、列表SQLite审计/账本、原生Cron历史诊断及SnowLuma完整文本存储；核对源码基线7729bca/e8ec69f、OpenClaw2026.11.1。不新增真实QQ外发或模型调用，不改业务代码、配置、数据库或服务。本文只保存技术元数据，不复制私聊/事项正文或凭据。全局顺序只由《整理记录.md》维护。

## 实际查询与取回完整性

02:21:18–02:24:00（Asia/Shanghai）共5次kurumi_logs、1次工具描述、6次exec。5次日志调用均成功，没有query_failed、busy或宿主截断；实际经过dispatch_action调用。

| 查询 | 结果 | 完整性 |
| --- | --- | --- |
| generation_failed，since=26h，limit=5 | 3条审计：283/286/289 | 全部命中已返回 |
| 同类型，expand=true，limit=2 | 3条中返回2条，nextOffset=2 | 本页完整，未再展开第3条 |
| errors，11月9日11:58–12:02，expand=true | 3条错误记录，counts为failed=1/error=1/cron:WARN=1 | 4087字节分两次调用，0→2334→结束，已取完整 |
| openclaw-session，11月9日11:59–12:01 | 5条事件 | 4020字节，仅取0→2162首段，仍有nextContentOffset；没有后续调用 |

因此“几次查询”须区分逻辑查询和内容续读；会话全文当时没有取完。工具能继续提供后续内容，不能把首段当完整模型回复。3条错误记录属于同一失败链的不同来源，不能计成3次独立事故。

6次exec用于ls/find/grep源码及两次SQLite读取，没有读取runtime.log；退出码1和job信息已出现在kurumi_logs返回的runtime记录中。第一次SQLite mode=ro查询报错，第二次immutable=1查询成功但只返回最近6条，包含286/289、不含283；不能将第一次失败当成三条都查到，也不能把live WAL上的immutable读当一致性保证。本次开发侧另以只读连接核对实际283及相应账本。

## 开场校验及真实投递

[`notification.js:29–36`](../../../chatbot/plugins/personal-reminder-list/notification.js)把空文本、换行及事项资料重复都归为digest_opening_repeats_items，并在catch中丢弃异常。事项ID总是检查，标题/内容/备注才要求至少4字符。随后[`store.js:129–138`](../../../chatbot/plugins/personal-reminder-list/store.js)只写通用assistant_notice_generation_failed，并清空投递正文。

11月9日12:00模型正常stop，无模型调用错误；输入91808、输出221 token。完整结果为390字/17行，前两行相同，包含事项资料及历史错误文字，确实不符合开场契约。结合实现，校验失败的解释有充分依据，但运行时具体异常已被catch丢弃，不能声称有原始exception/stack直接证明；调用正常也不等于模型输出正确。

| 时段 | prepared | generation_failed | digest.delivered | 账本正文与实际消息 |
| --- | --- | --- | --- | --- |
| 11月9日12:00 | 12:00:01.260，审计282 | 12:00:05.402，283 | 12:00:31.165，284；距失败25.763秒 | 正文0字；实际62字runner错误通知，另有124字Cron失败告警 |
| 11月10日00:00 | 00:00:00.876，288 | 00:00:05.144，289 | 00:00:08.949，290；距失败3.805秒 | 正文0字；实际62字runner错误通知，另有124字Cron失败告警 |

两时段62字错误通知的SHA256均为a4022c648321538d1e5a864e24e1014b269e186ac8e2ef68bde114f5ff8d127e，与Cron summary/宿主合成错误说明一致。零点模型结果85字/2行，输出61 token；不能与前一天中午的221 token/17行混用。

[`store.js:143–153`](../../../chatbot/plugins/personal-reminder-list/store.js)对prepared/failed/unknown行接受Cron的任意delivered标记，没有要求生成成功、正文非空或run.status=ok。此处把错误说明的投递记成清单成功；两时段均没有清单正文成功补发的证据。纯command Cron没有另起模型轮次补发清单，宿主后置合成说明是0用量。报告中的“Cron自己对话补发”和“中午约3.8秒”均不准确。

## 六项不足的归属

| 反馈 | 核实结果与缺口 |
| --- | --- |
| 具体原因/拒绝文本没保存 | 真实异常message/cause/stack被业务catch丢弃，属写入缺口；失败模型全文已在会话库，kurumi_logs可取，只是本次未续读。不应重复宣称所有地方都没文本。应记录stage/ruleId/异常链及对应生成记录引用、哈希和校验标记 |
| 没有源码位置 | 已有sourceRef指日志文件行或DB表/审计ID，runtime的_meta.path也有fileLine/method；它们不等于异常抛出点。业务规则/函数/stack没有记录，新增时应与日志来源分开，行号可附源码版本 |
| 没有因果链 | 已有correlation字段和可信ID关联闭包，但prepared/failed只有slotKey（eventKey），cron.run_state只有cronJobId且runId为空，delivered才兼有两者；并非每条都共享两种键。业务尝试关联未贯通，QQ工具也没有直接slotKey/cronJobId过滤或因果树 |
| 没有code过滤/聚合 | 没有精确code参数/连续同因折叠，但已有counts、recordCount、可信调用分组。列表适配器仅将code保留在data.details.code，错误分类只读data.code/failureCode/error/status，导致实际assistant_notice_generation_failed统计为failed；需修正提取及业务事件去重，不能从3条记录推断3次故障 |
| 没有stack | 本次业务层未保存，查询工具不禁止返回已经记录的stack；合成多行stack取回已验证。它与第一项是同一条异常链丢失，不应改成内容白名单限制 |
| Cron没有exitCode/命令 | 宿主实际已保留。当前适配器只读cron_run_receipts的7列，连error_text都未读，并硬编码exitCode=null/exitCodeAvailable=false。只读cron.runs的11月8日/9日中午历史记录已有source=exec、exitCode=1及被调reminder-list.mjs命令；cron_jobs.state_json的lastDiagnostics也有最近一次结构化诊断。属查询适配器漏读，不是OpenClaw没记录；当前job_json命令不能冒充历史执行证据 |

查询缺口的代码位置：[`log-query-diagnostics.mjs:53–59`](../../../scripts/fusion/log-query-diagnostics.mjs)、[`log-query.mjs:457–470`](../../../scripts/fusion/log-query.mjs)、[`log-query-views.mjs:197–210`](../../../scripts/fusion/log-query-views.mjs)。源码行号对应本次基线，不是持久不变的运行定位键。

上述缺口和清单误记成功均尚未修复。本次只更正文档和记录核查结果；不以先前合成/隔离测试通过或本次能调用工具关闭整体诊断验收。

文档收尾：218份证据归属检查、240项脚本生成索引核对及本文6个本地链接目标检查通过；Git差异格式检查通过。本轮无代码变更，未重跑模型、真实外发或业务测试。
