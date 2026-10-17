# 批次重试、渠道恢复与及时取消

归属：[文档22](../../../22_论文PDF翻译与文件投递.md)；总索引：[INDEX](../../INDEX.md)。开发基线 `5f29fa1`。主人授权实现有限重试并真实翻译至完整成功，本轮本人QQ投递已获授权；不向其他人/群发送、不推送、不收录文档23。

当前状态：本轮功能与收尾检查已验收。最终版本23页与19页high/dual均在各自全新译文缓存中一次提交成功，均已投递本人QQ，平台受理与实际TLS回取hash一致；实际本人收件未确认。论文101项（Node35、Responses20、并发10、安装引擎15、可靠性21）和相关112项通过，最终生产捕获代码与固定Python/HTTP子进程、四项运行自检、索引/链接和私密范围检查通过。仅论文范围本地提交，准确提交号查Git历史，未推送。默认high、30分钟、30万已报告tokens、4并发/QPS1保持，操作请求数200经本轮实测不足统一改300。

## 实现、修正与回归

- 批次校验仅重试当前输入，默认额外1次、操作者允许0–4；JSON/数量/ID类型/公式和样式标记严格校验，失败输出不缓存。第三轮暴露通用重试提示不足，补失败项具体标记计数及缺失/多余清单，不回显正文或失败译文，默认机会不增加。实际安装BabelDOC缓存检查覆盖无效结果不写缓存。
- 渠道恢复独立默认额外1轮、允许0–4；临时故障冷却300秒、每轮最多330秒等待，014→030→040且每渠道每轮一次临时故障尝试。同一恢复渠道仅一个半开探测。第二轮暴露错峰冷却时提前耗尽，补齐剩余渠道各自到期等待与禁止同轮反复探测的回归。鉴权24小时冷却不等待；HTTP2流错误进入有限切换。
- 每次HTTP使用沙箱内一次性子进程，私密输入/结果仅匿名管道；无服务或监听端口。全局终态中断连接/响应头/流等待，实测取消0.012–0.108秒；完成响应仍计账，取消或缺终态的用量标未知。相关回归使用真正本机HTTP服务器和实际子进程，不调付费API。
- 诊断只记批次/尝试ID、机器错误、errno/TLS校验码、阶段、最后事件/正文增量时间、预算类型与取消延迟。第三轮600.004秒慢请求只有response.created和0正文；可判本地无可见输出，不能断言上游没有隐藏推理/计费。第四轮030最后一个请求同类，600秒后切040成功。
- HEAD连通性探查8次（直连4、本机既有代理4）均200；只证明公开首页可达，不能定位付费API故障或证明代理更稳，生产网络路由未改。

## 逐轮真实记录

各轮均独立译文缓存，只从生产复制36个公开排版模型/字体/tokenizer，不复制译文SQLite、凭据冷却或其它论文缓存。原PDF和任务回执保留，不把缓存续验当全文新耗时。

| 轮次 | 任务ID | 结果 | 秒 | 请求 / 已报告tokens / 未知 | 私密根（下表根基于 `/home/afrangry/.openclaw-fusion/paper-acceptance/`） |
| --- | --- | --- | --- | --- | --- |
| 23页1 | `job_293723955d0942486db80564` | 98.8748%命中旧200请求上限 | 640.889 | 200 / 138312 / 5 | `batch-recovery-20261017/runs/23p-cold-01/acceptance.json` |
| 23页2 | `job_cc515bd25da15b78052b62ea` | 错峰冷却恢复提前耗尽，已修复 | 466.712 | 65 / 59885 / 7 | `batch-recovery-20261017-cold-final/runs/23p-cold-02/acceptance.json` |
| 23页3 | `job_8876e24cc75b28628efa9f23` | 3批重试成功、1批两次仍丢标记；补具体清单 | 1282.517 | 148 / 164784 / 6 | `batch-recovery-20261017-cold-03/runs/23p-cold-03/acceptance.json` |
| **23页4** | `job_3396fa64792440e7f99adebf` | **一次提交成功，仅dual完整23页** | **1548.803** | **209 / 171035 / 7** | `batch-recovery-20261017-cold-04/runs/23p-cold-04/acceptance.json` |
| **19页1** | `job_df73bdfdde2f420e6382049e` | **一次提交成功，仅dual完整19页** | **1258.571** | **160 / 121713 / 5** | `batch-recovery-20261017-cold-19/runs/19p-cold-01/acceptance.json` |

第四轮峰值4、1批校验失败局部重试成功、7次渠道故障切换、4次冷却探测全部成功；19页峰值4、1批重试成功、5次渠道故障切换、2次冷却探测成功。两篇三渠道均有成功回执。19页最后两个600.004秒慢请求分别来自014/040，均无可见正文；切030后10.399秒/7.164秒成功，未重译已完成批次。表中用时为验收脚本从提交至终态的墙钟时间，不含之后投递/人工抽查；只预热公开资源，不等于首次安装/下载时间。单篇一次提交成功表示内部有界恢复完成，不是无故障或长期成功率保证。未知用量不记0，不承诺金额硬上限。

## 文件与质量/外发边界

| 完整双语产物绝对路径 | 字节 / SHA256 | 结构与抽样证据（相对该根） |
| --- | --- | --- |
| `/home/afrangry/.openclaw-fusion/paper-acceptance/batch-recovery-20261017-cold-04/files/pdf_f7c75852647bd238c59a938709b0b83b.pdf` | 5293109 / `f7c75852647bd238c59a938709b0b83b75ac73a1e766940dbef476589ce54373` | `runs/23p-cold-04/pdf-check.json`、`render/page-{1,12,23}.png` |
| `/home/afrangry/.openclaw-fusion/paper-acceptance/batch-recovery-20261017-cold-19/files/pdf_0a4ae5eebb6882279b3516dc15606173.pdf` | 27979440 / `0a4ae5eebb6882279b3516dc15606173cdcf9e391a9e7e5471360d6c25e0f22b` | `runs/19p-cold-01/pdf-check.json`、`render/page-{1,10,19}.png` |

两篇仅dual，解析/登记/hash一致，完整23/19页每页均有中英文本；已实际查看各自三张Poppler页图。抽样正文/图表可读，作者/单位间距及部分代码标签翻译/换行不理想，未做全文语义/公式校对。上述render目录在各自`runs/<轮次>/`之下。

本人QQ投递均复用成功任务，无新增付费翻译；OneBot受理，实际TLS回取hash相同，私密 `runs/23p-owner-delivery/acceptance.json` 和 `runs/19p-owner-delivery/acceptance.json` 保存原回执。19页约26.7 MiB，验收脚本复用原文入站路径回取时按25 MiB上限拒绝（原始`qqRoundTrip.ok=false`保留）；另对该已登记、已上传产物做只读鉴权URL查询和HTTPS流式回取，严格按已知27979440字节及100 MiB产物上限核验，字节/hash一致，证据为同目录`outbound-retrieval.json`。没有扩大生产原文入站限制，不把入站拒绝改写为通过。本人收件未确认，不冒称真人入站或主模型发起全链路，本轮未发SMTP。

## 本目录证据清单

- 离线：`node-tests.txt`、`responses-tests.txt`、`concurrency-tests.txt`、`engine-tests.txt`、`reliability-tests.txt`、`related-tests.txt`。
- 生产捕获：`captured-worker.json`、`captured-worker-final.json`、`captured-production-contract.json`、`captured-recovery-round-fix.json`、`captured-marker-retry-fix.json`。前四份为演进快照，最后一份是当前运行源码检查。
- 网络：`network-diagnostics.json`，无认证HEAD，不调用翻译。
- 在线：`online-results.json` 收录五次翻译终态、两次本人投递、错误/取消时间和产物检查；不含密钥、正文、签名URL或原始API响应ID。完整私密回执路径逐项可追溯，所有失败保留。
- 运行：`deployment.json` 收录四项只读自检和投递后健康复核，QQ在线、testIngress=false。
- 收尾：`closeout.json` 收录349个证据全分类、169个脚本无声明冲突、7个变动Markdown的86个本地文件链接目标、10个私密值0匹配、生产捕获源码hash/预算和无活动任务检查。路径用Git NUL输出读取，含中文文档；不检查外链/锚点。该回执记录提交前审计，版本收录以随后论文范围本地提交及Git状态为准。

已回填文档22/16、本页与在线汇总，按论文范围收录本地提交，不推送。失败半成品治理/断点重做经主人确认延期；DeepSeek当前high/MAX完整复验、GPT/MAX冷译文缓存全文、全文人工质量、真实本人上传→主模型→翻译全链路、长期压力/恢复仍未由本轮证明。
