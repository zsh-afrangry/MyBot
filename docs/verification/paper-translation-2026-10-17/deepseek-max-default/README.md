# DeepSeek V4.1 Flash/MAX 默认调整

归属：[文档22](../../../22_论文PDF翻译与文件投递.md)；2026-10-17主人明确不接 Grok，并指定 DeepSeek 默认使用 V4.1 Flash/MAX。整体未指定厂商时仍使用 GPT 6.1 Sol/MAX。

官方[模型页](https://api-docs.deepseek.com/quick_start/pricing/)在本次读取时明确：API 名称 `deepseek-flash` 对应 `DeepSeek-V4.1-Flash-1017`。只改共享注册表的 DeepSeek defaultEffort，不臆造 `v4.1f` API 标识；显式强度保持支持。Node 工具说明、运行提示词与断言同步更新。

状态：默认调整已部署，配置级验证通过；Flash/MAX全文未验收。两篇本人GPT/MAX任务均失败，新上游流错误的降级缺口待处理。

| 证据 | 结果与边界 |
| --- | --- |
| [node-tests.txt（历史材料）](README.md#historical-material)、[responses-tests.txt（历史材料）](README.md#historical-material)、[concurrency-tests.txt（历史材料）](README.md#historical-material)、[engine-tests.txt（历史材料）](README.md#historical-material) | Node28、Responses20、并发10、实际安装引擎11，共69/69；无真实API/QQ/SMTP或生产写入 |
| [api-batch.json（历史材料）](README.md#historical-material) | 官方deepseek-flash/max合成批次成功，1请求、580已报告tokens、1.815秒、未知用量0；强度回显max，公式/样式标记保留。不是论文全文验收，无QQ/邮件 |
| [host.json（历史材料）](README.md#historical-material) | 真实隔离OpenClaw与主模型四轮通过，实际选择DeepSeek默认max；翻译/OneBot为fixture，无生产写入或实际QQ/SMTP |
| [production-jobs.json（历史材料）](README.md#historical-material) | 只读观察本人已发起的两篇生产任务；记录快照时间、固定profile、状态和用量摘要，不含聊天原文，不是本轮自动重试或额外外发 |
| [deployment.json（历史材料）](README.md#historical-material)、[capture.json（历史材料）](README.md#historical-material) | 两篇终止后队列/投递/worker空闲才重载；生产捕获Node/Python默认均为official/deepseek-flash/max，实际Bubblewrap隔离检查成功，4并发/QPS1保持，无翻译API或外发 |
| [persona-apply.txt（历史材料）](README.md#historical-material)、[dependencies.txt（历史材料）](README.md#historical-material)、[sync-config.txt（历史材料）](README.md#historical-material)、[sync-persona.txt（历史材料）](README.md#historical-material)、[health.json（历史材料）](README.md#historical-material) | 仅同步受管AGENTS提示词；四项自检通过、配置/人格0漂移、服务active/enabled、testIngress=false |
| [closeout.json（历史材料）](README.md#historical-material) | 文档链接、证据分类、脚本边界与本地提交范围复核；记录未覆盖项，无新增付费调用或外发 |
| [budget-300k.json（历史材料）](README.md#historical-material) | 后续主人QQ复测前，单任务已报告token阈值150000→300000已同步并重载；保持4并发/QPS1与其它限额，四项自检通过。操作者不发起翻译，真实完成/耗时/降级等待本人测试 |

两篇任务均使用GPT6.1 Sol/MAX，按篇串行，profile未被本次默认调整改写。两篇于17:18、17:34终止，之后才同步提示词并重载Gateway；未打断或自动重跑任务。

| 本人任务 | 最终结果 | 已报告用量 |
| --- | --- | --- |
| arXiv 2609.24812，23页 | 17:18终止，`api_stream_error`；上游 `upstream_http2_stream_error` 未进入有界渠道切换白名单。014/030/040分别成功12/15/16次，备用渠道确实参与 | 47次尝试，121649tokens，其中推理86050；4次未知 |
| arXiv 2607.28165，19页 | 17:18出队，17:34终止，`translation_budget_exhausted`；触发150000tokens阈值，正文阶段约67%，未达到请求数或执行时限 | 88次尝试，153676tokens，其中推理95001；2次未知 |

两篇无完整产物或文件投递，成功批次缓存保留。预算阻止新请求，在途调用仍会计账；第二篇有一个600秒在途请求，延迟终态并使最终用量超过阈值。累计275325已报告tokens、6次未知，不能当实际账单。新错误分类缺口待处理，MAX全文预算/分段策略待评估；本轮未扩大重试或预算、未自动重跑，也未推送远端或重打状态快照。证据的源码起点见deployment，最终收录提交查Git历史。

<a id="historical-material"></a>

## 历史原始材料的保留位置

本目录生成的原始回执、日志和图片已退出活动树；既有结论及失败状态不因此改变，也不代表新版已验收。已入Git的内容可用 `git show c849e63:<原仓库相对路径>` 读取；表中的blob标识可核对原始字节。未入Git的临时输出按本次清理授权丢弃。当前执行状态只在全局《整理记录.md》维护。

| 原文件 | 原报告顶层字段（仅摘录） | Git blob |
| --- | --- | --- |
| `api-batch.json` | ok=True；at=2026-10-17T09:13:15Z | `120e5e58c1945ac331ed26fa8a95d2129f432659` |
| `budget-300k.json` | at=2026-10-17T10:36:32.176393+00:00 | `3e341b735087c7d4ede8c238964df98dc4db34e4` |
| `capture.json` | ok=True；exitCode=0；at=2026-10-17T09:36:25.840Z | `c17ba13a3dde3a0da659e008473879d23fdf10df` |
| `closeout.json` | at=2026-10-17T09:44:19.504160+00:00 | `f4acd4a88ded33b023713bcc9cf08a21b7ed04de` |
| `concurrency-tests.txt` | 未提取；以原材料及现有结论为准 | `deb67065ce0e703b3ace4e6b09490b92f5e87407` |
| `config-before.txt` | 未提取；以原材料及现有结论为准 | `eada40e092dd018889c932dd1f59879d51a09754` |
| `dependencies.txt` | 未提取；以原材料及现有结论为准 | `b39597afebc94c642d0b90a449359c7df6c20054` |
| `deployment.json` | at=2026-10-17T09:35:28.182825+00:00 | `4b80a2b23223b543aff2c828a7439e6d4c81d23d` |
| `engine-tests.txt` | 未提取；以原材料及现有结论为准 | `3d03a7f66af1cc3834dcb25cbaa2236eb6088518` |
| `health.json` | ok=True；at=2026-10-17T09:36:26.617Z | `f5850dbd0f378b9dc28c07c013736a28f8385d99` |
| `host.json` | passed=True；at=2026-10-17T09:13:52.749Z | `a43de4248d60f8a01225975d31eaf0f8506eb412` |
| `node-tests.txt` | 未提取；以原材料及现有结论为准 | `0d4b695781fab31fe1fb82778390d6930e58e8d5` |
| `persona-apply.txt` | 未提取；以原材料及现有结论为准 | `30727fc51d800c722375510c94c9c503be65ec50` |
| `production-jobs.json` | at=2026-10-17T09:36:25.796606+00:00 | `5865d2dad7e6d1d0486b673b7cd0e56117e3531d` |
| `responses-tests.txt` | 未提取；以原材料及现有结论为准 | `8c10864ddc0c700367f19733f7acfbcaea1c50e1` |
| `sync-config.txt` | 未提取；以原材料及现有结论为准 | `f213f317a97141af0a82ec853632b0f9b6ca0d7f` |
| `sync-persona.txt` | 未提取；以原材料及现有结论为准 | `60f644b6d0c52317a22a3d538d21f5277e1b1a06` |
