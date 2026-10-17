# 论文 PDF 翻译与文件投递验收（2026-10-17）

归属：[文档 22](../../22_论文PDF翻译与文件投递.md)。开发起点 `df376ca9`；并行 KnowledgeMap 已独立合入 `4f26366`，本需求提交仅收录论文/文件/附件相关差异。完整提交号以 Git 历史为准。

**结论：实现和部署已完成；第一页翻译、本人 QQ 与修复邮件收件通过，全文验收阻塞。** 2026-10-17 本人确认修复邮件正文正常、PDF 附件可打开且第一页原文/译文排版正常；不将平台受理、模拟编排或第一页成功扩大成全文通过。

## 授权与隔离

主人指定 `/home/afrangry/桌面/2609.32536v1.pdf`，允许真实翻译和本人 QQ 测试；邮件发件为 1794511189@qq.com，唯一收件白名单 365999865@qq.com。没有向其他人或群发送，不推送远端，不收录文档23的并行开发。GPT凭据只在私有运行目录；默认 GPT 6.1 Sol / MAX / 原生 Responses 保持。

样本16页、646721字节，SHA256 `71658ea5beea1cf5f9485d825f57b8a545e7645a5ff5bbe79fe9a45e30a8d6db`。Python3.12.15 / pdf2zh-next2.9.0 / BabelDOC0.6.2 / bitstring4.3.1，CPU。上游不遵守输出上限，页数/请求数/已报告用量/时间限制不保证金额上限；未知用量不记为零。

真实任务与资产在 `/home/afrangry/.openclaw-fusion/paper-acceptance/mvb7tbhu/` 的 `jobs/`、`records/`、`files/`；API凭据不进仓库。`baseline-output/` 是早期失败任务留下的原始产物，不能当后来成功的译稿。生产任务根为独立的 `.openclaw-fusion/documents/`。

## 真实结果

| 证据 | 实际结果与边界 |
| --- | --- |
| `one-page/acceptance.json` | 第1页成功，588.58秒、3请求、27462已报告tokens；mono 806159字节、dual 348896字节，不是整篇译稿 |
| `one-page/{mono,dual}-page1.png`、`{mono,dual}-text.txt` | 已查看两份页图：正文中文可读，标题/脚注存在；作者/单位区域合并，不能声称出版质量或全文语义/公式正确 |
| `delivery/acceptance.json` | 原单页QQ/邮件投递回执；QQ被平台接受，**主人另已确认正常收到**。原邮件虽SMTP接受，但主人报告乱码，因此邮件这一轮未通过 |
| `mail-mime.json` | 用实际失败标题和真实PDF生成完整邮件，以标准Python email解析：修复前text/plain且0附件；修复后multipart/mixed，正文/标题完整，附件348896字节、SHA256与原PDF一致。不是从收件箱取出的原始邮件 |
| `delivery-mail-fixed/acceptance.json` | 修复后只向本人重新发邮件，复用已有产物，无新增翻译/QQ发送；SMTP接受。**2026-10-17 本人另确认正文、PDF 附件与第一页排版正常**，反馈摘要见 observations.json。程序化测试批准不等于真实QQ确认往返 |
| `delivery/retrieval-fixed.json` | 对原机器人上传的文件实际鉴权取URL、HTTPS下载、隔离PDF检查；348896字节且哈希一致。不是主人上传事件 |
| `delivery/{retrieval,cdn-probe,ftn-tls-probe,nt-tls-probe}.json` | 回取失败的定位证据：QQ返回公开IPv4的/asn.com路径；改域名破坏路由，以原IP连接并验证固定QQ SNI成功。无签名URL令牌落盘，不关闭TLS验证 |
| `full-document/acceptance.json` | 整篇首轮失败：1020.995秒、6请求，5批成功49849已报告tokens，末次`upstream_stream_read_error`且用量未知；无完整译稿 |
| `full-document-recheck/acceptance.json` | 开发者在已有授权范围内显式新建一次复验任务，命中前轮成功缓存；518.522秒、5请求，新增12501已报告tokens后再次同类流中断，末次用量未知；无完整译稿。本轮停止继续付费复试 |
| `observations.json` | 主人反馈、最新回执、质量边界的独立汇总；保留原邮件乱码失败及后续修复邮件本人确认，不能用旧acceptance.json中的ok=true替代实际收件反馈 |
| `download.json` | 实际arXiv下载与网络隔离PDF解析通过；15页、2215244字节，无模型/外发 |
| `host.json` | 独立OpenClaw+真实DeepSeek主模型三轮工具编排通过；翻译worker和OneBot是fixture，没有实际GPT/QQ/SMTP；会话重置不重复任务/发送 |

以上任务用量各自独立，缓存复验的12501不是全文总消费。初探、早期失败和重复单页验证另有请求，未知消费无法据本报告折算账单。MAX推理开销波动明显，单页9.8分钟也未达到“GPT整篇约10分钟”的参考预期。

## 离线、部署与索引证据

| 文件 | 已证明的边界 |
| --- | --- |
| `papers-node-tests.txt` | 20/20；实际PDF解析、受管目录、QQ身份/URL/文件账本、任务生命周期、附件确认/篡改/大小、完整SMTP MIME解码与字节哈希、日志及实际进程隔离/超时 |
| `responses-tests.txt` | 11/11；原生请求体/流终态、三凭据顺序/冷却、预算、未知结果；模拟网络，无真实模型 |
| `engine-tests.txt` | 4/4；实际锁定安装引擎的探测/缓存/JSON批次/公式样式契约；无模型调用 |
| `existing-tests.txt` | 112/112；既有邮件/QQ/日志查询，本地mock SMTP，无真实外发 |
| `boundary-recovery-tests.txt` | 54/54；共享适配器、后端边界和既有恢复隔离，含当前工作树文档23新增包发现用例（本需求不收录该修改）；不是新功能全量灾难恢复 |
| `recovery-tests.txt` | 开发阶段既有恢复10/10的单独原始回执；完整最新合并回归见上一行 |
| `deployment.json`、`dependencies.txt`、`sync-config.txt`、`sync-persona.txt` | 配置/人格核对对齐后重载kurumi-fusion，四项自检通过，testIngress=false；不改变SnowLuma启停，不代表新功能端到端全部成功 |
| `cache-warm.json` | 39文件344869220字节预热生产模型/字体/缓存，2个SQLite在线备份以保持源并发一致；没有导入验收凭据冷却，已有目标不覆盖 |
| `capture-smoke.json` | 实际生产插件捕获路径中的runner能在真实Bubblewrap中导入固定Python排版代码；不调用模型、不外发，不能据此声称真实入站翻译链路已通过 |
| `doc-links.json`、`closeout.json`、`final-audit.json` | 当时的文档链接、证据/脚本分类、提交范围、私密值与运行复核记录；原始时点邮件为待确认，保留不回写。后续本人收件确认及 B2 关闭以 observations.json 和本文为准 |

新增测试均在 `chatbot/tests/papers/`，运维脚本在 `chatbot/scripts/`；统一脚本/副作用索引见 [SCRIPTS.md](../SCRIPTS.md)，证据覆盖由命名目录规则检查。长日志为可提交的txt，未依赖被.gitignore排除的log文件。

## 保留的失败与纠错

| 文件 | 事实与处理 |
| --- | --- |
| `edge-403.json` | urllib默认UA遭边缘403/1010；不是凭据无效证据，显式UA后可用 |
| `request-400.json` | 引擎None能力探测误发API，已改成本地探测并回归 |
| `timeout-90s.json`、`nonstream-edge-timeout.json` | 早期90秒未知用量超时、非流式524/503；当前采用原生Responses流式，不切Chat |
| `baseline-batch.json` | 生成过PDF但引擎异步结束回调不退出，停止后任务失败；固定CLI改同步排版API，父任务仍异步 |
| `stream-error.json` | 简化提示词早期复验：第1批成功、第2批流式错误，285.287秒、3663已报告tokens，第二批用量未知；未外发 |

原协议合成测试另见 [paper-api](../paper-api-2026-10-17/README.md)。初探的1次列表+8次生成只属于那组实验，不能当作整轮全部调用或账单。

## 阻塞与未覆盖

- **B1 全文验收阻塞**：两轮上游流中断，未取得完整16页译稿；停止本轮付费重试。后续需渠道稳定后明确复验，或主人决定扩展其他渠道/厂商；不静默降MAX、换模型或拼凑不完整PDF。
- **B2 已验收（2026-10-17）**：本人确认修复邮件正文正常、PDF 作为附件收到且能打开，第一页原文与译文排版正常；只覆盖该单页样稿及邮件收件，不覆盖全文语言/公式质量。
- 真实成功API仅014。030/040鉴权与额度故障切换仅模拟，未故意撤销/耗尽014。
- 未验证：主人真实上传原PDF→模型→实际翻译→交付的完整链路、整篇语义/公式、扫描OCR/GPU、并发压力、第三方账单硬上限。
- DeepSeek官方、naiccc Grok翻译未实现。多人/群、登录受限论文、邮件收信不在当前范围。
- 已有停写恢复点不含本功能。本轮仅回归恢复隔离，未做新增功能全量备份/恢复；不得只退旧邮件源码后继续发送包含新字节快照的草稿，源码/配置/私有状态须联动回退。
