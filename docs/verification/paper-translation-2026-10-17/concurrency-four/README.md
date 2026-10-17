# 单篇 API 四并发验证（2026-10-17）

归属：[文档22](../../../22_论文PDF翻译与文件投递.md)。起点`9346f87`，仅论文范围，本地提交、不推送。主人要求多篇仍逐篇翻译，单篇先试4个API请求并发；每完成一篇就发送一篇。后者本已存在，本轮新增顺序回归并明确工具/人格说明。

## 实现与离线证据

本机`apiConcurrency=4`、`apiQps=1`。网络等待不持全程互斥锁；主/回退池共同受客户端4槽信号量约束。请求数、用量、冷却、每线程回执与不可变快照短锁管理。到达预算只停止新调用，已在途请求仍可能计费；成功响应/译文缓存保留，未知用量不记0。不是3个Key的负载均衡，014→030→040仍仅故障降级。

| 证据 | 范围 |
| --- | --- |
| [node-tests.txt](node-tests.txt) | 28/28，包含真实阻塞首篇发送：第二篇必须仍排队，发送结束后才开始翻译；另含沙箱stdin贯通4/1与既有领域边界。API/外发模拟 |
| [responses-tests.txt](responses-tests.txt) | 20/20，原生协议、三Key顺序、冷却/限额、未知用量；注入网络 |
| [concurrency-tests.txt](concurrency-tests.txt) | 10/10，4个真实重叠注入请求与额外调用等待、乱序归账/不可变快照、预算、终态取消、共享冷却/重试频率、同时原子写；无真实网络 |
| [engine-tests.txt](engine-tests.txt) | 11/11，真实安装引擎的线程池/两个限速器、成功在途结果缓存、批次/样式、结束与取消；独立HOME/cache、API模拟 |
| [host.json](host.json) | 真实隔离OpenClaw/主模型四轮编排，翻译/OneBot模拟，无实际QQ/邮件；不替代真实翻译 |

## 指定 PDF 实测

样本`/home/afrangry/桌面/2609.32536v1.pdf`，16页。测试逐一执行，没有同时翻译两篇，没有QQ/SMTP外发。验收限额300次/200000已报告tokens/1800秒，与生产200/150000/1200不同。GPT保持6.1 Sol/MAX，DeepSeek保持Flash/low，不自动换模型或强度。

| 回执 | 结果与边界 |
| --- | --- |
| [cache-preparation.json](cache-preparation.json) | 每个私密测试root仅复制36份公开模型/字体/tokenizer资源；GPT额外在线备份旧成功译文SQLite，DeepSeek首轮无译文缓存。不复制密钥/冷却/生产任务 |
| [gpt-resume/acceptance.json](gpt-resume/acceptance.json) | **成功**167.192秒、57次新请求、40439已报告tokens、未知用量0、峰值4。复用旧成功缓存，不能当GPT冷启动全文耗时。mono/dual各16页，均不实际发送 |
| [deepseek-fresh/acceptance.json](deepseek-fresh/acceptance.json) | **失败**52.075秒、5请求/14085tokens、峰值4；首批样式标记期望4实际2，严格校验拒绝。其余已在途4批成功/用量保留。不是全文提速通过 |
| [deepseek-recheck/acceptance.json](deepseek-recheck/acceptance.json) | **成功**155.163秒、101新请求/119848tokens、0未知用量、峰值4，mono/dual各16页。复用首轮4批成功缓存；两轮累计207.238秒、106请求/133933tokens，不隐藏首轮失败 |
| [gpt-resume/quality/checks.json](gpt-resume/quality/checks.json)、[deepseek-recheck/quality/checks.json](deepseek-recheck/quality/checks.json)及各quality目录 | 页数/字节/hash与记录匹配，各页中文/替换字符统计；已查看双语第1/8/16页，正文/抽样表格可读，作者/单位间距仍欠佳，存在Poppler字体警告。不是全文人工语言/公式质量或本人收件验收 |

GPT本轮新增请求平均8.782秒、中位4.816秒、最大50.027秒，耗时总和500.588秒；4路实际重叠，不是把同步循环的配置数字改成4。原串行未完成与本轮缓存补译的数据集和上游时点不同，不能用1800秒除167秒声称10倍加速。

耗时与用量的完整重算见[timing.json](timing.json)。这里的响应耗时是完整响应返回时间，不是首token时间。DeepSeek复验101次平均3.788秒、中位3.179秒、最大9.399秒；此前串行105次平均4.062秒。复验155.163秒比串行458.441秒短，但缓存、输出波动和模型时点不同，只作参考。包括首轮失败的累计207.238秒仍短于串行，样式丢失的偶发风险继续保留，不自动修复/重试。

| 测试 | 整体耗时 | 新请求 | 已报告tokens | 单次平均 / 中位 / 最长 |
| --- | --- | --- | --- | --- |
| GPT/MAX缓存续验 | 167.192秒 | 57 | 40439 | 8.782 / 4.816 / 50.027秒 |
| DeepSeek/low首轮失败 | 52.075秒 | 5 | 14085 | 8.992 / 6.510 / 20.197秒 |
| DeepSeek/low复验 | 155.163秒 | 101 | 119848 | 3.788 / 3.179 / 9.399秒 |

三次实际请求起始间隔均≥1秒，基于start+elapsed重算峰值均4；各回执输入/输出用量之和均与总计一致。本轮三次翻译任务合计163次API尝试、174372已报告tokens；不含历史调用与真实主模型编排用量。

受管完整产物保留在私密验收root的files目录，没有导入生产或自动外发：

| 厂商 / root | mono / dual产物ID（文件名为ID加.pdf） |
| --- | --- |
| GPT `/home/afrangry/.openclaw-fusion/paper-acceptance/gpt-four-resume-20261017/` | `pdf_6975b0afb3ed55ac2c17c08a9a1cc4cc` / `pdf_ad2e8d1df40b449078821f600be0ae62` |
| DeepSeek `/home/afrangry/.openclaw-fusion/paper-acceptance/deepseek-four-fresh-20261017/` | `pdf_b73d3346522c7c42f00c9b07cf4b28a2` / `pdf_1a79842abf7e5135541065807ae2acf2` |

## 部署与收尾

| 证据 | 范围 |
| --- | --- |
| [config-apply.txt](config-apply.txt)、[persona-apply.txt](persona-apply.txt) | 唯一同步工具应用操作者配置4/1与逐篇投递说明 |
| [capture.json](capture.json) | 重载后的实际生产捕获代码在Bubblewrap内导入固定Python，Node/Python均解析4/1，双厂商注册表通过；无凭据/API/外发 |
| [health.json](health.json)、[dependencies.txt](dependencies.txt)、[sync-config.txt](sync-config.txt)、[sync-persona.txt](sync-persona.txt) | 四项自检通过，运行/配置对齐，不代表全部业务验收 |

[closeout.json](closeout.json)记录代码/配置/生产捕获哈希对齐、私密值扫描、提交范围与证据清单；[doc-links.json](doc-links.json)检查本轮文档的本地链接目标。B1的全文产物缺口已关闭，全新缓存GPT性能、长时间稳定性、全文人工校对和本人整篇收件仍未验证。旧恢复点不包含本功能；没有更新后台开发副本、操作旧系统/归档或远端推送。
