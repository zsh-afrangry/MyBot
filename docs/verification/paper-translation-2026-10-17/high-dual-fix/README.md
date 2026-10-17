# high 默认、30 分钟期限与双语产物修复

归属：[文档22](../../../22_论文PDF翻译与文件投递.md)。起点 `f976db3`；仅论文范围，本地提交、不推送。状态：本轮修复、离线/隔离集成与生产部署检查已完成；high默认的实际整篇翻译待本人复测。

## 需求和实现

- GPT 6.1 Sol、DeepSeek V4.1 Flash 默认 high；显式 MAX 规范化为 max 后保留，模型、渠道顺序、聊天模型不变。
- 单篇 worker 墙钟期限 1800 秒，插件 schema 与 runner 缺省一致，拒绝配置超过 1800 秒。排队不占本篇执行期限；单次请求仍是 600 秒总期限，CPU 1200 秒是独立资源限制。
- `output` 由 service 的持久化 `deliveryKind` 传入 runner/Python 的 `outputKind`；BabelDOC 的 no_mono/no_dual 控制最终文件，runner 只接受所选文件，登记与发送共用选择函数。dual/mono/both 各自有回归，缺失所选版本不回退到另一个版本。
- 原始 PDF 导入仍限 25 MiB；受管翻译产物单独限 100 MiB，与 worker 单文件上限一致，读取和重新打开也执行此限。邮件单附件10 MiB/总20 MiB不变。登记失败记录固定机器码及所选版本，不记录异常原文。
- 原始 PDF、译文缓存与历史回执保留。失败工作目录清理逻辑没有改动；断点重做/半成品治理经主人决定延期，不自动发起付费重跑。

## 生产故障事实

只读核对 `job_d8956d9d982ff59946115396` 与 `job_0f7d53f973a8db0053f3db1e`，均明确要求 dual，profile 均为 GPT/MAX；不是模型传了 both。

- 第一篇23页，18:40:23开始，19:00:23被旧1200秒期限结束，正文翻译约75.316%，94次尝试、172858已报告tokens、7次用量未知（包含终止时4个在途）。014有34次成功/3次渠道失败/1次在途，030有53次成功/3次在途，040未用。
- 第二篇19页，等待第一篇结束才开始，19:03:55结束；实际执行约212秒，68次成功全在030，43851已报告tokens、0未知，Save PDF已100%。旧代码先登记mono，登记dual失败，最终translation_failed且未投递。已保留mono为14362304字节；原dual随工作目录清理，不能恢复其精确大小或原始异常。
- 用保留原文及mono，在隔离worker中调用锁定BabelDOC0.6.2的同一个side-by-side组合函数并按压缩参数序列化，不调用翻译API，得到19页、**27974086字节**，超过25 MiB。它是可复现的大小限制缺口，不是原失败dual的找回或原异常的确定证明。临时副本已删除，不向生产登记新文件。

## 600 秒究竟在等待什么

`ResponsesClient(timeout=600)` 从一次HTTP请求开始建立绝对deadline，包含连接、响应头及整个SSE读取；每次读取只获得剩余时间。因此有流量也会在总时限到达时结束，不能把600秒解读为600秒无数据。

两次014请求分别于18:41:09、18:49:12开始，耗时均600.001秒，记录为api_transport_unknown并切到030；快照分别有77/83事件、outputChars=0、lastEvent=response.output_item.added。outputChars只统计output_text.delta，不包含内部推理tokens；快照是每隔至少5秒、收到事件时覆盖保存，**没有历史时间序列、最后token时刻、完整事件类型分布或失败请求的最终用量**。不能推出整整600秒都在生成，也不能认定整段卡死。014另有成功请求耗时437.843秒，证明存在长请求，不足以说明那两次的内部时序。

门户截图中的首响应约17秒、总时长13分1秒，时间上可与本地18:49:12请求及本地超时之后门户19:02:13的记录对应；但缺少同一request ID的关联，因此只能视为上游可能继续生成/计费的线索。首响应也不是连续生成的证明。不会把未知用量记为零。本轮未调整600秒，也未新增无进展自动重试策略。

## 验证及覆盖边界

- 论文Node34/34、Responses20/20、并发10/10、固定安装引擎14/14，合计78/78；见 [regression.json](regression.json)。相关邮件/QQ/查询112/112。新增覆盖默认high/显式MAX、三种产物、未选路径不读取、缺失/逃逸路径拒绝、超25 MiB产物、100 MiB上限、原文件保留和30分钟配置边界。
- BabelDOC生成标志由实际安装版本的契约测试检查；HTTP/译文及投递使用fixture。真实Bubblewrap测试验证stdin传播、文件边界及超时杀整个进程组。第一次新增缺失产物测试暴露错误仍是Node通用参数码，补齐领域错误后复验通过。
- [host.json](host.json)：真实隔离OpenClaw/主模型四轮通过，默认GPT/high、重置后查询、DeepSeek/high仅生成，双语只登记一份；翻译/OneBot模拟，无真实QQ/邮件外发。不能替代实际翻译质量。
- [captured-worker.json](captured-worker.json)：当前生产捕获的runner/产物选择函数、双厂商high/显式MAX、1800秒/4并发/QPS1及固定Python导入通过；跨包service/documents捕获文件与已回归源码逐字节一致。扩展检查首次误用原生ESM跨包导入失败，原回执保留在 [captured-worker-native-import-failed.json](captured-worker-native-import-failed.json)；OpenClaw使用捕获映射解析跨包依赖，校验改为源字节一致性及实际宿主编排，不修改捕获目录或伪造链接。
- [deployment.json](deployment.json)：检查没有queued/running/dispatching任务后，仅同步timeoutSeconds=1800及受管提示词并重载服务；四项自检通过，testIngress=false。没有启动、重放或改写旧论文任务。
- 不自动重跑本人整篇PDF；新high默认的完整实际翻译、耗时/成本、本人收件及全文质量待后续本人QQ复测。旧MAX失败回执保留，不改写其固定profile或状态。

## 已知延期

上游新码 `upstream_http2_stream_error` 的切换分类、DeepSeek/MAX单次8192输出不足，仍是既有待处理问题；改high不能作为这两项已修复的证据。失败半成品与断点重做经主人明确延期。没有变更邮件附件上限、并行KnowledgeMap、旧系统、恢复点或远端。

## 文件归属

本目录全部文件仅服务本轮修复：本页为索引；regression.json记录离线回归；host.json记录隔离主模型编排；captured-worker*.json记录捕获检查及一次测试方式修正；deployment.json记录部署自检；[production-observations.json](production-observations.json)保留经过筛选的生产元数据、600秒回执与离线大小复现。没有论文原文、聊天原文、凭据、签名URL或失败半成品进入Git。
