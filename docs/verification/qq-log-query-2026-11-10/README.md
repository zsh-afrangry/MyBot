# QQ主人只读日志工具（2026-11-10）

状态：独立技术与部署范围已验收，真实QQ待主人提问。开发分支`codex/qq-log-query`基于c2a9b7c，位于已有8bc3工作树；已在保留主目录未提交N3现场的前提下本地合入main，未push。

## 实现

新增主人专用`kurumi_logs`，复用固定`log-query.mjs`子进程。无shell、模型指定路径/命令、raw/expand或业务写入。默认2小时、最多7天；50/100条及固定窗口续页，10秒/512KiB子进程上限，最终24KiB封装。白名单脱敏迁至共享observability，旧运维导出保留兼容。生成失败归入错误，HTTP304排除。

`logs.read`仅owner；可信主人私聊及当前有效调用执行前后复核。成员、伪造标志、未知身份、天气Cron及自主行动会话拒绝；参数不授予修复或执行权限。结果为不可信诊断资料，仅技术字段，不含聊天/论文正文、参数、自由错误文本、凭据或本机路径。无记录不证明健康，正文验收仍需独立证据。

## 验证

- 首轮回归45项通过、日志工具文件因误用SDK导出路径未加载；改为11.1实际公开的tool-plugin导出后，58项相关测试全过，追加实际处理器到CLI的联测后最终59项通过。没有把失败的首次加载当通过。
- `node --test --test-reporter=tap chatbot/tests/log-query/query.test.mjs chatbot/tests/access-control/policy.test.mjs scripts/fusion/test/log-query{,-views,-minimal,-diagnostics}.test.mjs`：59/59，含14项新工具测试及45项身份/查询回归。合成临时日志的真实CLI读取后SHA-256保持；真实取消/超时/输出上限等待子进程结束；成员/撤权/不可信上下文、分页与脱敏均覆盖。
- [真实隔离Gateway回执](host.json)：2/2，插件启用/禁用、工具目录可发现/移除、正常停止，加载未创建查询源目录。未使用真实模型、QQ或生产数据；不把目录验证当成真实QQ往返。

## 已批准并应用的生产差异

身份策略revision6→7，唯一owner新增logs.read；main新增kurumi_logs白名单，插件allow/load/entry增加kurumi-logs并绑定现有两个根；主人模板说明优先调用及边界。成员、后台、自主行动、通用文件读取和其他能力不因本提案扩大。主人明确批准后已按config/README同步配置/人格并仅重启Fusion；实际工具目录发现通过，主人QQ实际调用仍待验收。

主目录已有进行中的N3变更，本分支未混入或提交其代码；通过逐文件三方合并保留，权限词汇和配置文档两处手工兼容。重启会加载主目录已有源码，故先检查QQ组件在未配置enabled=true时立即返回、无状态/服务/工具副作用，并通过24项适配与引擎回归；N3生产配置/权限没有启用，未创建生产N3库。未用“未提交”冒称“重启不加载”。

- 文档归属237项脚本/201份证据与生成索引检查通过；文档归属回归10/10。首次索引未重生成导致检查失败，重生成后通过。身份策略提案revision7校验通过。
- 新插件无新增第三方依赖，复用根目录固定11.1 SDK；现有诊断适配器和存储继续是唯一后端。临时测试目录与隔离Gateway子进程均已退出和清退。

## 生产复核

主人明确批准“合入并启用，QQ由我提问验收”。功能提交ff4206d及审阅/授权记录8edfa92、993195e已进入main；未push。实际部署回执见[deployment.json](deployment.json)：

- 合入后日志/身份/查询回归59/59；插件构建、revision7校验通过。生产工具目录中kurumi-logs为active，提供kurumi_logs。固定CLI读取过去2天Cron/列表错误，返回5/10项技术事件，未发送QQ消息或调用模型。
- 配置只有main工具、插件allow/path/entry、策略revision/主人logs.read六处受管差异；人格只有主人AGENTS一份。同步后health、verify-dependencies、sync-config、sync-persona均退出0；health仍将3项Cron error与ok=true同时报告，不据此判播报正常。
- Fusion已重启（InvocationID见回执）；6条Cron声明/5条启用保持，SnowLuma、QQ、DSH和KnowledgeMap服务InvocationID保持。N3未启用、无新N3库；成员与通用原生禁用项不变。同步预像按统一备份契约临时保护，验证后清退。
- 全量main文档归属检查首次因并行N3的3个新测试尚未分类失败：合并运行69项中66通过、3失败（文档父用例和两项子用例）。日志独立分支的文档检查10/10通过；本次不替其他开发现场声明全量通过，该缺口留给N3阶段收尾。日志回归单独重跑59/59通过。
- 真实QQ仍待主人提问，不将工具目录/固定CLI/隔离处理器当成真人往返。既有列表生成失败、误记成功及健康误报没有在本功能中修复；日志资料不授权助手自修、部署或重启。
