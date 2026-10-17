# DeepSeek V4.1 Flash/MAX 默认调整

归属：[文档22](../../../22_论文PDF翻译与文件投递.md)；2026-10-17主人明确不接 Grok，并指定 DeepSeek 默认使用 V4.1 Flash/MAX。整体未指定厂商时仍使用 GPT 6.1 Sol/MAX。

官方[模型页](https://api-docs.deepseek.com/quick_start/pricing/)在本次读取时明确：API 名称 `deepseek-flash` 对应 `DeepSeek-V4.1-Flash-1017`。只改共享注册表的 DeepSeek defaultEffort，不臆造 `v4.1f` API 标识；显式强度保持支持。Node 工具说明、运行提示词与断言同步更新。

状态：默认调整已部署，配置级验证通过；Flash/MAX全文未验收。两篇本人GPT/MAX任务均失败，新上游流错误的降级缺口待处理。

| 证据 | 结果与边界 |
| --- | --- |
| [node-tests.txt](node-tests.txt)、[responses-tests.txt](responses-tests.txt)、[concurrency-tests.txt](concurrency-tests.txt)、[engine-tests.txt](engine-tests.txt) | Node28、Responses20、并发10、实际安装引擎11，共69/69；无真实API/QQ/SMTP或生产写入 |
| [api-batch.json](api-batch.json) | 官方deepseek-flash/max合成批次成功，1请求、580已报告tokens、1.815秒、未知用量0；强度回显max，公式/样式标记保留。不是论文全文验收，无QQ/邮件 |
| [host.json](host.json) | 真实隔离OpenClaw与主模型四轮通过，实际选择DeepSeek默认max；翻译/OneBot为fixture，无生产写入或实际QQ/SMTP |
| [production-jobs.json](production-jobs.json) | 只读观察本人已发起的两篇生产任务；记录快照时间、固定profile、状态和用量摘要，不含聊天原文，不是本轮自动重试或额外外发 |
| [deployment.json](deployment.json)、[capture.json](capture.json) | 两篇终止后队列/投递/worker空闲才重载；生产捕获Node/Python默认均为official/deepseek-flash/max，实际Bubblewrap隔离检查成功，4并发/QPS1保持，无翻译API或外发 |
| [persona-apply.txt](persona-apply.txt)、[dependencies.txt](dependencies.txt)、[sync-config.txt](sync-config.txt)、[sync-persona.txt](sync-persona.txt)、[health.json](health.json) | 仅同步受管AGENTS提示词；四项自检通过、配置/人格0漂移、服务active/enabled、testIngress=false |
| [closeout.json](closeout.json) | 文档链接、证据分类、脚本边界与本地提交范围复核；记录未覆盖项，无新增付费调用或外发 |

两篇任务均使用GPT6.1 Sol/MAX，按篇串行，profile未被本次默认调整改写。两篇于17:18、17:34终止，之后才同步提示词并重载Gateway；未打断或自动重跑任务。

| 本人任务 | 最终结果 | 已报告用量 |
| --- | --- | --- |
| arXiv 2609.24812，23页 | 17:18终止，`api_stream_error`；上游 `upstream_http2_stream_error` 未进入有界渠道切换白名单。014/030/040分别成功12/15/16次，备用渠道确实参与 | 47次尝试，121649tokens，其中推理86050；4次未知 |
| arXiv 2607.28165，19页 | 17:18出队，17:34终止，`translation_budget_exhausted`；触发150000tokens阈值，正文阶段约67%，未达到请求数或执行时限 | 88次尝试，153676tokens，其中推理95001；2次未知 |

两篇无完整产物或文件投递，成功批次缓存保留。预算阻止新请求，在途调用仍会计账；第二篇有一个600秒在途请求，延迟终态并使最终用量超过阈值。累计275325已报告tokens、6次未知，不能当实际账单。新错误分类缺口待处理，MAX全文预算/分段策略待评估；本轮未扩大重试或预算、未自动重跑，也未推送远端或重打状态快照。证据的源码起点见deployment，最终收录提交查Git历史。
