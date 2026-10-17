# 三渠道故障切换与 DeepSeek 官方接入

归属：[文档 22](../../../22_论文PDF翻译与文件投递.md)。授权：先补 014 → 030 → 040 的渠道故障切换，再接 DeepSeek 官方 Key；保持 GPT 6.1 Sol/MAX 默认，不推送远端，不收录文档 23 的并行开发。起点 `f8fd5fc`，阶段一提交 `f049a64`，后续提交见 Git 历史。

**该阶段结论：渠道切换和官方Key接入已部署，DeepSeek/low已生成16页，GPT/MAX串行当时超时。后续四并发缓存续验已生成完整GPT/MAX与DeepSeek译稿，当前69项回归与部署见[四并发报告](../concurrency-four/README.md)。** 原先本人 QQ/邮件单页收件确认仍有效；本轮没有真实 QQ/邮件外发。

## 真实结果

样本 `/home/afrangry/桌面/2609.32536v1.pdf`，16 页、646721 字节，输入哈希沿用[原报告](../README.md)。完整任务/文件保留在私有 `paper-acceptance/`，不混入生产 `documents/`。

| 证据 | 结果与边界 |
| --- | --- |
| [channels-api.json](channels-api.json) | 014/030/040 各一次真实短句 Responses 成功：8.336/4.418/5.433 秒、91/188/205 已报告 tokens；均为 gpt-6.1-sol/max，只证明该次可用 |
| [gpt-full/acceptance.json](gpt-full/acceptance.json) | `job_a51b4c45cedd67c31c9fc54f`，1800.748 秒超时；41 请求/87359 已报告 tokens/3 次未知用量。014 用 24 次、030 用 17 次，实际在 server_error 与 HTTP524 后两次 014 → 030；014 冷却到期恢复。030未失败，未触发040。段落60.52%/总66.93%，无完整译稿；不自动付费复试 |
| [deepseek-api.json](deepseek-api.json)、[deepseek-pro-api.json](deepseek-pro-api.json) | 官方 Flash/none、V4 Pro/none 各一次真实短句成功：0.591/0.898 秒、29/28 tokens；不是两种模型全文通过 |
| [deepseek-batch-api.json](deepseek-batch-api.json)、[deepseek-structured-api.json](deepseek-structured-api.json) | 合成 JSON 批次；后一份使用官方原生 text.format=json_schema，本地条数/ID/公式样式校验通过 |
| [deepseek-low/acceptance.json](deepseek-low/acceptance.json) | Flash/low 105 个实际请求均完成，136595 已报告 tokens，458.441 秒；无渠道/批次/占位符失败。Save PDF100% 后因本次新增取消适配遗漏 finish_callback 而 TypeError，原任务仍如实记 failed；成功译文缓存保留 |
| [deepseek-layout/acceptance.json](deepseek-layout/acceptance.json) | 35.045 秒/0请求/0tokens，复用成功缓存定位上述结束错误。安全堆栈定位 ProgressMonitor.on_finish，不记录异常原文/正文；不是又一次付费翻译 |
| [deepseek-final/acceptance.json](deepseek-final/acceptance.json) | 修复结束回调后 `job_3f4e489ccd6d69d2f92be1b5` succeeded；31.047 秒、0新增请求/用量，缓存生成 mono/dual 各16页。实际翻译工作耗时458.441秒，不能宣传为31秒或约1分钟 |
| [deepseek-final/quality/checks.json](deepseek-final/quality/checks.json) 及 quality/ 全部文件 | 页数/大小/哈希匹配，16页均有中文，提取0替换字符。已查看 mono/dual 第1/8/16页共6图：正文可读、抽样数值表存在；作者/单位间距欠佳、部分术语/换行需校对。Poppler有字体类型警告。不代表整篇语义/公式/出版质量通过 |

DeepSeek 这次实测消耗低于生产默认的 200 请求/150000 已报告 tokens/1200秒，但运行的**验收脚本限额**为300/200000/1800，不能冒称在生产限额下执行了完整真人链路。GPT默认不变；不存在 GPT → DeepSeek 自动回退。none实际论文标记不稳，因此DeepSeek默认low；显式none仍如实执行，不自动升级/重跑。预算统计不是账单金额保证，未知用量不能记为0。

最终完整产物位于 `/home/afrangry/.openclaw-fusion/paper-acceptance/deepseek-official-fresh-20261017/files/`：

| 产物 | 文件名 | 字节/页数 | SHA256 |
| --- | --- | --- | --- |
| 纯译文 | `pdf_42b9ee78fe7a909ad755faa17acdc83f.pdf` | 1067273 / 16 | `42b9ee78fe7a909ad755faa17acdc83f804b41bca46915c6ec6f17dc90913fe0` |
| 中英对照 | `pdf_88c4abbf04e7eca327502e83b0d7e70a.pdf` | 1711462 / 16 | `88c4abbf04e7eca327502e83b0d7e70ad5532e23f714795a7fb153e0b4cf7319` |

## 最终回归与部署

| 文件 | 已证明的范围 |
| --- | --- |
| [paper-node-tests.txt](paper-node-tests.txt) | 该阶段源码 Node26/26：厂商默认/冲突、凭据隔离/原子合并、任务/产物、受管文件、附件/本地TLS SMTP、边界与恢复隔离；无真实外发 |
| [responses-final-tests.txt](responses-final-tests.txt) | 20/20，含渠道有界切换/冷却/预算、未知用量、官方配置与凭据/格式；网络注入 |
| [engine-tests.txt](engine-tests.txt) | 9/9，实际安装 BabelDOC0.6.2 的缓存、批次/标记及正常结束/取消契约；API模拟 |
| [host-final.json](host-final.json) | 真实隔离 OpenClaw/主模型四轮：列文件、GPT默认且仅dual一份、会话重置后不重发、DeepSeek/low且仅生成。翻译/OneBot模拟；无真实翻译API或QQ/邮件 |
| [capture-final.json](capture-final.json) | 最终生产捕获runner在真实Bubblewrap中导入固定Python、双厂商注册表；engine.py/responses.py/profiles.json哈希与源码一致。无凭据/API/模型/外发 |
| [deployment-final.json](deployment-final.json)、[health.json](health.json) | 最终重载2026-10-17 12:59:58（Asia/Shanghai），运行健康、QQ连接正常、testIngress=false；凭据四个名称均存在且0600，不记录值 |
| [dependencies.txt](dependencies.txt)、[sync-config.txt](sync-config.txt)、[sync-persona.txt](sync-persona.txt) | 依赖自持、受管配置0漂移、人格四文件对齐；不等于模型/实际交付全验收 |
| [doc-links.json](doc-links.json)、[closeout.json](closeout.json) | 本轮维护文档的本地目标存在检查、脚本/证据分类、差异/私密值检查与提交范围；不验证远端链接、标题锚点或人工分类的语义正确性 |

该阶段回归合计55/55；原报告中的112、54项是早期时点回执，本轮未重跑。`tool-fields-tests.txt` 是字段说明调整后的中间定向回归，最终以 Node26/26为准。`paper-node-phase1.txt`、`responses-tests.txt`、`engine-phase1.txt` 为阶段一的20/17/4通过记录，未覆盖后续DeepSeek最终实现。

新增/更新脚本均在 `chatbot/tests/papers/`；凭据导入脚本在 `chatbot/scripts/`。`acceptance-api.py` 用显式私密凭据调用合成短文/批次；`acceptance.mjs` 用指定PDF，支持已登记厂商/模型/强度及新证据目录；`acceptance-host.mjs` 真实主模型但模拟翻译/OneBot；`acceptance-worker.mjs` 只测实际隔离进程。授权/副作用与完整清单见[SCRIPTS.md](../../SCRIPTS.md)。

## 保留的失败与纠错证据

这些文件保留真实失败，文件名中的 fixed 不表示通过；最终能力以上表为准。

| 文件组 | 结论 |
| --- | --- |
| `deepseek-full/acceptance.json` | none首轮144.164秒/1请求/583tokens，结构失败；当时尚无终态失败取消 |
| `deepseek-format/acceptance.json` | 41.052秒/4请求/5407tokens，无效JSON；增加结构诊断/失败取消后仍拒绝 |
| `deepseek-fixed/acceptance.json` | 28.059秒/1请求/576tokens，样式标记期望4、实际6；精确围栏兼容不放松标记校验 |
| `deepseek-structured/acceptance.json` | none启用官方schema后仍丢样式标记（4变2）；格式约束不能保证内容占位符 |
| `host.json`、`host-fixed.json` | 动态fs注册表无法被OpenClaw捕获；改静态JSON import后通过当时四轮none默认测试，后续默认low的最终证据见host-final |
| `host-low.json` | 主模型将“一份双语”误选both；旧fixture两种输出字节相同，不能充分发现。改独立输出fixture并明确dual/both/自动投递语义后最终四轮通过 |
| `capture-smoke.json`、`capture-smoke-fixed.json` | 首个探针用python -c遗漏/app导入路径；修探针后当时捕获通过。最终代码以capture-final为准，不把首失败归因于生产引擎 |
| `deepseek-assets-prewarm.json` | 36个模型/字体/tokenizer资产、344746304字节；仅资源预热，不复制译文SQLite、任务、凭据或冷却，不是翻译验收 |

## 仍未覆盖

- B1的全文产物缺口已由后续四并发缓存续验关闭，见[四并发报告](../concurrency-four/README.md)；全新缓存耗时/稳定性仍未证明，不自动付费重试。
- DeepSeek完整产物未向本人实际发送；本人真实上传→主模型→真实翻译→收件的完整链路、真实邮件带码确认往返、整篇人工语义/公式校对未覆盖。
- 030→040的真实故障、真实额度耗尽/吊销未制造；注入覆盖全部顺序/冷却/预算。V4 Pro全文、none全文成功未证明；Grok未实现。
- GPU/OCR、超过4并发压力、新功能完整灾难恢复和第三方账单硬上限未验收；恢复点未重打。旧系统和文档23开发未改。
