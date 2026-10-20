# 附件接收事实与纯失败分流修复（2026-10-19）

收尾归档：频道附件失败分流的实现提交为 `5fe6f8a`；本报告及隔离模型验收脚本随后按论文工作线本地归档，未推送。下方“没有提交/推送混合工作树”保留为2026-10-19的实施边界，不代表当前状态。性能冷启动/冷却优化仍是文档22的未完成项。

归属：[文档22](../../../22_论文PDF翻译与文件投递.md)；证据总索引：[INDEX](../../INDEX.md)；脚本边界：[SCRIPTS](../../SCRIPTS.md)。状态：**附件修复已部署；全套人格对齐由并行文档25负责**。主人已同意按说明方案实施；开发起点 `9c88003`，工作树存在文档24等并行修改，保留既有修改，不整仓提交/推送。

实现：`kurumi-qq/src/attachments.js`统一提供安全文件标签、接收状态与真实PDF登记ID；`files.js`返回明确类型/下载/校验失败码；`inbound.js`对只有失败附件且无文字/引用/有效媒体的消息，使用原发送账本直接反馈，不启动模型业务回合。其余消息保留真实文字与每项附件结果交给模型。主人/成员模板要求本次文件与历史产物分清、用途未知先问、待续翻译使用新登记ID、明确重发仍可执行。没有新增意图关键词解析、数据库/SQL、通用文件/命令权限或常驻服务。

测试脚本：

- [`file-ingress.test.mjs`](../../../../chatbot/tests/papers/file-ingress.test.mjs)：离线、本机HTTP和临时状态，验证纯失败零模型/零文件重发、混合/引用/媒体、受管ID/隔离、错误分类、取消、防重复及未知回执。
- [`acceptance-file-ingress.mjs`](../../../../chatbot/tests/papers/acceptance-file-ingress.mjs)：真实隔离OpenClaw/已配置聊天模型；真实入口、PDF解析/工具/任务服务，合成下载、翻译器与OneBot。只写临时测试目录及显式新`--out`，不改生产testIngress，不真实翻译或发QQ/邮件。

验收结果及精确回执：

| 文件 | 结果与边界 |
| --- | --- |
| [`node-tests.txt`](node-tests.txt) | 论文/QQ/统一权限/邮件/统一查询191/191通过，含附件专项26项；真实传输账本仅连本机HTTP。覆盖纯失败零模型、各类错误、混合/引用/媒体、真实ID、取消、原账本防重/未知回执和统一日志查询 |
| [`host.json`](host.json) | 首轮13场景通过，4个合成任务成功、零翻译API。该轮合成译文相同，内容去重后沿用历史文件名，不能证明投递内容互不相同；保留原回执 |
| [`host-recheck.json`](host-recheck.json) | 改为每任务独立合成产物，并加入来源inputId/实际投递hash/收件人断言，13/13再次通过。MD-only零模型、重复无发送；失败PDF直接反馈；MD+读文件不启动翻译；明确重发只发旧稿；当前PDF/待续PDF各建新任务并投递对应新稿；成员只收自身文件。5次模拟上传=历史首发+明确重发+当前新稿+待续新稿+成员新稿；4任务均dual成功，零翻译API，隔离进程已退出 |
| [`runtime-before.json`](runtime-before.json) | 部署前0活动翻译/投递、11任务、配置hash、服务状态；当时仅3份AGENTS有差异 |
| [`persona-apply.txt`](persona-apply.txt) | 整套同步实际写入10份文件。检查到并行“人格和记忆”任务已修改人格配置后，未再重复整套同步；见下方偏差记录 |
| [`deployment.json`](deployment.json) | 23:48无活动任务时只重载Fusion；当前启动生成的QQ捕获中inbound/files/attachments三文件与源码逐字相同。3个工作区AGENTS附件规则对齐；生产配置hash和11任务不变，无真实翻译/QQ/邮件测试调用 |
| [`health.json`](health.json) | 健康检查通过、QQ在线、testIngress=false；不证明真人收到附件 |
| [`dependencies.txt`](dependencies.txt)、[`config-check.txt`](config-check.txt) | 依赖与运行配置检查通过，无配置apply |
| [`persona-check-initial.txt`](persona-check-initial.txt) | 初次全套人格检查非零，6份SOUL/USER与并行开发的新投影不一致；未把它改写成通过 |
| [`persona-check-final.txt`](persona-check-final.txt) | 本轮结束前只读复查仍为相同6份差异，附件AGENTS无差异；未再次apply，交由并行人格任务完成 |
| [`closeout.json`](closeout.json) | 脚本/证据分类、链接/围栏、Git空白和已知私密值检查；同时记录并行范围及未提交/推送状态 |
| [`evidence-coverage-final.txt`](evidence-coverage-final.txt) | 全局覆盖末次检查非零：另一项开发新建`plugin-lifecycle-2026-10-19/README.md`尚未登记；本轮附件目录全部已分类，脚本索引179项/46个boundary无冲突。不替其他开发豁免或补写结论 |

部署偏差：审阅差异后到实际`sync-persona --apply`之间，另一个经用户授权的“人格和记忆”任务更改了`config/persona.json`等文件。全量同步因此读入了中间状态，将世凪人格写入运行区，随后该任务继续新增关系层，产生6份差异。本轮已停止再次全量同步，不回退其源码或工作区；只核实本次3份AGENTS附件规则与当前投影一致。全套人格对齐/验证归[文档25](../../../25_人格、记忆与会话连续性.md)，本轮不宣称四项自检全过。后续共享工作树部署应在写入前再次核对预期变更集合；发现集合扩大时只同步本任务文件，或等待另项开发完成。

测试回执包含合成对话，不含用户真实聊天或凭据；未向生产写测试身份、文档或任务。没有提交/推送混合工作树，也未修改SnowLuma/DSH、归档或性能参数。

当前确定性保证只覆盖结构上纯失败附件的分流；带自然语言请求的业务意图仍由模型判断，其可靠性通过隔离模型场景验收，不承诺永不误判。原有后台翻译自动投递不受该入站分支控制。性能优化仍另列文档22待办，不混入本次修复。
