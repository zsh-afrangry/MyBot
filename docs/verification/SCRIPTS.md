# 脚本与证据索引

本页登记现行脚本、测试及辅助库的归属文档、用途、副作用与证据位置。原始结果从[INDEX.md](INDEX.md)进入，判定与授权规则见[文档16](../16_验收与测试总表.md)。不要按名称批量执行acceptance或test脚本：其中可能调用真实模型/API、外发、写状态或启停服务。

## 维护方式与检查边界

- 归属的唯一数据源为[documentation-map.json](../../scripts/fusion/documentation-map.json)。精确文件或更长目录前缀覆盖套件默认归属；有显式evidence时使用其路径，否则从源码提取。无证据位置的离线测试仍须有归属文档，不能把“—”理解为游离文件。
- 副作用分类在[evidence-index.mjs](../../scripts/fusion/evidence-index.mjs)的TABLE维护；每项注明boundary/header/code/offline依据。boundary做双向比对，能识别约定声明中的多标/漏标，**不等于自动审计任意自然语言声明或代码副作用**；其它依据仍需人工核对。辅助库按被调用时的行为标注，不能仅凭导入无副作用判定。
- 扫描整个仓库的MJS/CJS/SH/PY、scripts/test/tests下JS/TS、test/spec/fixture源码和带shebang的JS/TS；跳过.git/node_modules/dist/虚拟环境/缓存，不跟随符号链接。组件就地test/、src/*.test.ts和嵌套辅助库都包含。
- 显式例外：论文3份Python与领域2份运行CLI属于运行源码，两份旧搜索脚本属于退役资料；精确归属/原因在元数据中，不列为当前验收入口。向旧归档新塞脚本不会自动豁免。`docs/verification/`只放证据。

```bash
node scripts/fusion/evidence-index.mjs
node scripts/fusion/evidence-index.mjs --check-markdown
node scripts/fusion/evidence-coverage.mjs
node --test scripts/fusion/test/documentation-map.test.mjs
```

更新表格：运行 `node scripts/fusion/evidence-index.mjs --markdown`，只替换下方生成标记之间的内容，再执行 `--check-markdown`；不得手改生成表补文档/证据链接。新增脚本需登记分类和归属，新增证据组需登记元数据与INDEX；已登记证据目录中的回执继承目录归属。

<!-- BEGIN GENERATED SCRIPT INDEX -->
| 脚本 | 分组 | 归属文档 | 用途 | 副作用 | 需要授权 | 分类依据 | 证据位置 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `chatbot/packages/confirmation-core/src/confirmation.test.ts` | 离线 | [21](../21_后端职责分层与代码整理.md) | 确认核心：提案校验、TTL、幂等与 grant 消费 | 只读 | 否 | offline | — |
| `chatbot/packages/confirmation-core/src/public-id.test.ts` | 离线 | [21](../21_后端职责分层与代码整理.md) | 公开 ID 脱敏与冲突规避 | 只读 | 否 | offline | — |
| `chatbot/packages/personal-domains/src/clarification-gate.test.ts` | 离线 | [21](../21_后端职责分层与代码整理.md) | 地点歧义澄清闸门 | 只读 | 否 | offline | — |
| `chatbot/packages/personal-domains/src/config.test.ts` | 离线 | [21](../21_后端职责分层与代码整理.md) | 插件配置解析与默认值 | 只读 | 否 | offline | — |
| `chatbot/packages/personal-domains/src/confirmation-gate.test.ts` | 离线 | [21](../21_后端职责分层与代码整理.md) | 领域确认闸门 | 只读 | 否 | offline | — |
| `chatbot/packages/personal-domains/src/controlled-replies.test.ts` | 离线 | [21](../21_后端职责分层与代码整理.md) | 受控回复与原文交付 | 只读 | 否 | offline | — |
| `chatbot/packages/personal-domains/src/formatter.test.ts` | 离线 | [21](../21_后端职责分层与代码整理.md) | 天气输出格式与地点保真 | 只读 | 否 | offline | — |
| `chatbot/packages/personal-domains/src/index.test.ts` | 离线 | [21](../21_后端职责分层与代码整理.md) | 天气插件工具注册与装配 | 只读 | 否 | offline | — |
| `chatbot/packages/personal-domains/src/native-reminder-scheduler.test.ts` | 离线 | [21](../21_后端职责分层与代码整理.md) | 原生提醒调度适配 | 只读 | 否 | offline | — |
| `chatbot/packages/personal-domains/src/parsers.test.ts` | 离线 | [21](../21_后端职责分层与代码整理.md) | 自然语言时间与地点解析 | 只读 | 否 | offline | — |
| `chatbot/packages/personal-domains/src/planning.test.ts` | 离线 | [21](../21_后端职责分层与代码整理.md) | 行程提案与事务提交 | 只读 | 否 | offline | — |
| `chatbot/packages/personal-domains/src/profile.test.ts` | 离线 | [21](../21_后端职责分层与代码整理.md) | Profile 当前所在地读写 | 只读 | 否 | offline | — |
| `chatbot/packages/personal-domains/src/qweather-client.test.ts` | 离线 | [21](../21_后端职责分层与代码整理.md) | QWeather 客户端请求构造与拒绝规则 | 只读 | 否 | offline | — |
| `chatbot/packages/personal-domains/src/reminder-gateway.test.ts` | 离线 | [21](../21_后端职责分层与代码整理.md) | 提醒与 Gateway 对账 | 只读 | 否 | offline | — |
| `chatbot/packages/personal-domains/src/reminder-reconciler-service.test.ts` | 离线 | [21](../21_后端职责分层与代码整理.md) | 提醒 reconciler 服务循环 | 只读 | 否 | offline | — |
| `chatbot/packages/personal-domains/src/reminder-reconciler.test.ts` | 离线 | [21](../21_后端职责分层与代码整理.md) | 提醒 reconciler 判定与退避 | 只读 | 否 | offline | — |
| `chatbot/packages/personal-domains/src/reminders.test.ts` | 离线 | [21](../21_后端职责分层与代码整理.md) | 提醒提案、修改与取消 | 只读 | 否 | offline | — |
| `chatbot/packages/personal-domains/src/store.test.ts` | 离线 | [21](../21_后端职责分层与代码整理.md) | 领域 SQLite 存储与迁移 | 只读 | 否 | offline | — |
| `chatbot/packages/personal-domains/src/weather-location.test.ts` | 离线 | [21](../21_后端职责分层与代码整理.md) | 天气地点解析与叶子名保留 | 只读 | 否 | offline | — |
| `chatbot/packages/personal-domains/src/weather-service.test.ts` | 离线 | [21](../21_后端职责分层与代码整理.md) | 天气服务聚合与失败语义 | 只读 | 否 | offline | — |
| `chatbot/plugins/kurumi-mail/test/adapters.test.js` | 离线 | [20](../20_邮件能力与横切扩展.md) | 邮件适配器：宿主入站路由到达被选中的 store、工具消费注入实现、替换策略不能授予身份、未知 id 明确失败 | 写临时测试目录、只读 | 否 | offline | — |
| `chatbot/plugins/kurumi-mail/test/gate.test.js` | 离线 | [20](../20_邮件能力与横切扩展.md) | 邮件端到端负向核心：确认前 mock SMTP 收到 0 封；另含完整往返与失败路径 | 写临时测试目录、只读 | 否 | offline | — |
| `chatbot/plugins/kurumi-mail/test/mime.test.js` | 离线 | [20](../20_邮件能力与横切扩展.md) | 邮件 MIME：RFC 2047 主题、RFC 2231 附件名、折行、注入防护、信封发件人 | 只读 | 否 | offline | — |
| `chatbot/plugins/kurumi-mail/test/policy.test.js` | 离线 | [20](../20_邮件能力与横切扩展.md) | 邮件输入策略：单收件人字符串与 body 别名的真实失败回归、白名单、参数规整 | 只读 | 否 | offline | — |
| `chatbot/plugins/kurumi-mail/test/smtp.test.js` | 离线 | [20](../20_邮件能力与横切扩展.md) | SMTP 协议：仅连本地 mock 服务器，覆盖认证失败、收件人拒绝、超时与 dot-stuffing | 写临时测试目录、只读 | 否 | offline | — |
| `chatbot/plugins/kurumi-mail/test/store.test.js` | 离线 | [20](../20_邮件能力与横切扩展.md) | 邮件草稿与确认闸门：提案、授权、幂等、过期、跨会话与参数校验 | 写临时测试目录、只读 | 否 | offline | — |
| `chatbot/plugins/kurumi-mail/test/tool.test.js` | 离线 | [20](../20_邮件能力与横切扩展.md) | 邮件工具层：以生产失败参数驱动真实注册工具，含非主人拒绝与凭据不泄露 | 写临时测试目录、只读 | 否 | offline | — |
| `chatbot/plugins/kurumi-memory/test/memory.test.js` | 离线 | [25](../25_人格、记忆与会话连续性.md) | 长期记忆读写、版本与损坏拒绝 | 只读 | 否 | offline | — |
| `chatbot/plugins/kurumi-qq/test/channel.test.js` | 离线 | [10](../10_融合助手运行维护.md)、[24](../24_统一身份与权限管理.md) | QQ 频道分段、配额、账本与幂等 | 只读 | 否 | offline | — |
| `chatbot/plugins/kurumi-qq/test/presentation.test.js` | 离线 | [10](../10_融合助手运行维护.md)、[24](../24_统一身份与权限管理.md) | QQ 呈现与分段节奏 | 只读 | 否 | offline | — |
| `chatbot/plugins/kurumi-qq/test/stickers.test.js` | 离线 | [10](../10_融合助手运行维护.md)、[24](../24_统一身份与权限管理.md) | 表情目录与发送边界 | 只读 | 否 | offline | — |
| `chatbot/plugins/kurumi-research/test/papers.test.js` | 离线 | [10](../10_融合助手运行维护.md)、[21](../21_后端职责分层与代码整理.md) | 论文来源校验与拒绝规则 | 只读 | 否 | offline | — |
| `chatbot/plugins/kurumi-tasks/test/git.test.js` | 离线 | [10](../10_融合助手运行维护.md) | 副本内受限 Git 提交范围 | 只读 | 否 | offline | — |
| `chatbot/plugins/kurumi-tasks/test/sandbox.test.js` | 离线 | [10](../10_融合助手运行维护.md) | Bubblewrap 隔离边界与进程树终止 | 只读 | 否 | offline | — |
| `chatbot/plugins/kurumi-tasks/test/task.test.js` | 离线 | [10](../10_融合助手运行维护.md) | 后台任务工具的所有权与绑定 | 只读 | 否 | offline | — |
| `chatbot/plugins/personal-confirmation/src/inbound.test.ts` | 离线 | [21](../21_后端职责分层与代码整理.md) | 确认入站插件：身份绑定与重放拒绝 | 只读 | 否 | offline | — |
| `chatbot/plugins/personal-confirmation/src/index.test.ts` | 离线 | [21](../21_后端职责分层与代码整理.md) | 确认入站插件装配与工具暴露 | 只读 | 否 | offline | — |
| `chatbot/tests/acceptance/call-analysis.test.mjs` | 离线 | [16](../16_验收与测试总表.md) | 旧调用分析离线断言（读取两份输入样本） | 只读 | 否 | offline | `docs/verification/` |
| `chatbot/tests/access-control/isolation.test.mjs` | 离线 | [24](../24_统一身份与权限管理.md) | 两身份实际目录/路由/任务/投递/撤权、旧账本与隔离人格；本地模拟OneBot/翻译器 | 写临时测试目录 | 否 | header | — |
| `chatbot/tests/access-control/log-query.test.mjs` | 离线 | [18](../18_跨模块链路日志查询.md)、[24](../24_统一身份与权限管理.md) | 授权审计的统一查询、run关联、拒绝原因展示与私密文件模式 | 写临时测试目录 | 否 | header | — |
| `chatbot/tests/access-control/policy.test.mjs` | 离线 | [24](../24_统一身份与权限管理.md) | 权限/schema/完整工具映射、可信身份与后台委托、配置派生及默认拒绝 | 只读 | 否 | header | — |
| `chatbot/tests/backend-boundaries/capabilities.test.mjs` | 离线 | [21](../21_后端职责分层与代码整理.md) | 共享包依赖方向、四插件独立注册/实际宿主启停、历史DB确认隔离/授权与Cron兼容入口 | 写临时测试目录 | 否 | header | `docs/verification/capability-decoupling-2026-10-20/README.md` |
| `chatbot/tests/backend-boundaries/confirmation.test.mjs` | 离线 | [21](../21_后端职责分层与代码整理.md) | 确认公共接口、业务事务中消费/回滚、领域适配器生命周期和交互钩子组合 | 只读 | 否 | header | — |
| `chatbot/tests/backend-boundaries/domain.test.mjs` | 离线 | [21](../21_后端职责分层与代码整理.md) | 领域分层：实际记忆工具准入、存储独立、列表事务与审计/重放回滚 | 写临时测试目录 | 否 | header | — |
| `chatbot/tests/backend-boundaries/plugin-lifecycle.test.mjs` | 离线 | [21](../21_后端职责分层与代码整理.md) | 真实OpenClaw服务管理器验证论文异步停止/中止/不重放、邮件注销/重启/失败清理；无生产重启或外发 | 写临时测试目录 | 否 | header | `docs/verification/plugin-lifecycle-2026-10-19/README.md` |
| `chatbot/tests/domain-adapters/integration.test.mjs` | 离线 | [21](../21_后端职责分层与代码整理.md) | 真实领域工具替换策略/存储；调度与固定 runner 一致、无静默回退 | 写临时测试目录 | 否 | header | — |
| `chatbot/tests/domain-adapters/registry.test.mjs` | 离线 | [21](../21_后端职责分层与代码整理.md) | 领域适配器注册/注销、启动选择、同步契约和失败拒绝 | 只读 | 否 | header | — |
| `chatbot/tests/knowledgemap/bills.test.mjs` | 离线 | [23](../23_KnowledgeMap业务能力桥接.md) | 账单声明一致、真实钩子runId映射、当前请求隔离和消息幂等键 | 只读 | 否 | header | — |
| `chatbot/tests/knowledgemap/bridge.test.mjs` | 离线 | [23](../23_KnowledgeMap业务能力桥接.md) | 固定API客户端、可信请求、参数映射、共享播报与切换防旧写 | 写临时测试目录 | 否 | header | — |
| `chatbot/tests/knowledgemap/http.test.mjs` | 离线 | [23](../23_KnowledgeMap业务能力桥接.md) | 真实本机HTTP与临时FastAPI/SQLite双入口集成，不访问生产 | 写临时测试目录 | 否 | header | — |
| `chatbot/tests/papers/concurrency_test.py` | 离线 | [22](../22_论文PDF翻译与文件投递.md) | 网络4/6并发上限与额外请求排队、乱序回执/不可变快照、预算、终态取消、共享冷却/频率与并发原子写入；注入HTTP/临时目录 | 写临时测试目录 | 否 | header | — |
| `chatbot/tests/papers/credentials.test.mjs` | 离线 | [22](../22_论文PDF翻译与文件投递.md) | 厂商配置冲突、凭据隔离、原子导入/轮换与保留其它池；仅合成凭据 | 写临时测试目录 | 否 | header | — |
| `chatbot/tests/papers/documents.test.mjs` | 离线 | [22](../22_论文PDF翻译与文件投递.md) | PDF 受管存储、实际解析、QQ 文件身份/来源/配额和防重复边界 | 写临时测试目录 | 否 | header | — |
| `chatbot/tests/papers/engine_test.py` | 离线 | [22](../22_论文PDF翻译与文件投递.md) | 锁定排版引擎产物/公式/批次接口、重试仅缓存有效结果；独立HOME/cache | 写临时测试目录 | 否 | header | — |
| `chatbot/tests/papers/file-ingress.test.mjs` | 离线 | [22](../22_论文PDF翻译与文件投递.md) | 附件类型/下载/校验事实、纯失败零模型分流、真实发送账本/未知回执、混合媒体与身份隔离 | 写临时测试目录 | 否 | header | `docs/verification/paper-translation-2026-10-17/file-ingress-2026-10-19/README.md` |
| `chatbot/tests/papers/jobs.test.mjs` | 离线 | [22](../22_论文PDF翻译与文件投递.md) | 翻译high/显式MAX、所选产物贯通、任务幂等/取消/重启与独立投递状态 | 写临时测试目录 | 否 | header | — |
| `chatbot/tests/papers/log-query.test.mjs` | 离线 | [22](../22_论文PDF翻译与文件投递.md) | 论文事件接入只读统一查询与可信消息/任务关联 | 写临时测试目录 | 否 | header | — |
| `chatbot/tests/papers/lookup.test.mjs` | 离线 | [22](../22_论文PDF翻译与文件投递.md) | 按题名/文件名/arXiv编号查本人受管PDF：仅元数据、规范化多词匹配、全目录有界结果与fetch题名记录 | 写临时测试目录 | 否 | header | — |
| `chatbot/tests/papers/mail.test.mjs` | 离线 | [22](../22_论文PDF翻译与文件投递.md) | 受管附件快照、确认、完整性、大小限制及本地 TLS SMTP | 写临时测试目录 | 否 | header | — |
| `chatbot/tests/papers/reliability_test.py` | 离线 | [22](../22_论文PDF翻译与文件投递.md) | 批次重试0–4次、冷却恢复/单探测/预算、本机HTTP正文空闲与总期限独立、实际取消/切渠道及安全诊断；无付费API或生产状态 | 写临时测试目录 | 否 | header | — |
| `chatbot/tests/papers/responses_test.py` | 离线 | [22](../22_论文PDF翻译与文件投递.md) | 原生 Responses、流式终态、用量/占位符、三凭据降级、有限重试和未知回执 | 写临时测试目录 | 否 | header | — |
| `chatbot/tests/papers/source-boundary.test.mjs` | 离线 | [22](../22_论文PDF翻译与文件投递.md) | 下载/阅读/翻译隔离、旧缓存/哈希/路径/大小/取消与实际受管PDF检查 | 写临时测试目录 | 否 | header | `docs/verification/capability-decoupling-2026-10-20/README.md` |
| `chatbot/tests/papers/worker.test.mjs` | 离线 | [22](../22_论文PDF翻译与文件投递.md) | 实际隔离进程的产物/路径、30分钟上限、正文空闲配置贯通、重试0–4及超时终止、恢复副本付费/凭据关闭 | 写临时测试目录 | 否 | header | — |
| `chatbot/tests/persona/memory.test.mjs` | 离线 | [25](../25_人格、记忆与会话连续性.md) | 文档25 P2记忆迁移、SQLite版本/并发、来源校验、摘要TTL、遗忘屏障、成员拒绝与可插拔存储；action互斥字段、误参零提交和修正后同消息重试 | 写临时测试目录 | 否 | header | `docs/verification/persona-memory-2026-10-19/p2/README.md` |
| `chatbot/tests/persona/projection.test.mjs` | 离线 | [25](../25_人格、记忆与会话连续性.md) | 文档25人格/关系按身份投影、私密文件保留、非法配置/路径拒绝和旧配置兼容 | 写临时测试目录 | 否 | header | `docs/verification/persona-memory-2026-10-19/node-tests.txt` |
| `chatbot/tests/reminder-list/intake.test.mjs` | 离线 | [19](../19_提醒列表与定时汇总.md) | 自然录入授权、实际会话 UUID、超时/重置/换题与跨提醒领域拒绝 | 只读 | 否 | header | — |
| `chatbot/tests/reminder-list/log-query.test.mjs` | 离线 | [18](../18_跨模块链路日志查询.md)、[19](../19_提醒列表与定时汇总.md) | 提醒列表审计接入日志查询，精确消息/slot 关联 | 写临时测试目录 | 否 | header | — |
| `chatbot/tests/reminder-list/plugin.test.mjs` | 离线 | [19](../19_提醒列表与定时汇总.md) | 提醒列表 v2 工具、可信原文钩子和过期上下文拒绝 | 写临时测试目录 | 否 | header | — |
| `chatbot/tests/reminder-list/scheduler.test.mjs` | 离线 | [19](../19_提醒列表与定时汇总.md) | 提醒列表原生 Cron 固定声明、对账、并发和失败重试 | 写临时测试目录 | 否 | header | — |
| `chatbot/tests/reminder-list/store.test.mjs` | 离线 | [19](../19_提醒列表与定时汇总.md) | 提醒列表领域状态、时间、授权、幂等、防重与固定 runner | 写临时测试目录 | 否 | header | — |
| `chatbot/tests/web-deepseek/log-query.test.mjs` | 离线 | [18](../18_跨模块链路日志查询.md)、[26](../26_基础能力插件边界整理与检索接入设计.md) | DeepSeek provider调用事件接入只读统一查询，不含query/Key | 写临时测试目录 | 否 | header | — |
| `chatbot/tests/web-deepseek/providers.test.mjs` | 离线 | [26](../26_基础能力插件边界整理与检索接入设计.md) | DeepSeek Search/Fetch provider契约：注入fetch，参数/错误码/取消/并发/URL拒绝/凭据权限/包装/缓存/日志不泄露；无网络请求 | 写临时测试目录 | 否 | header | — |
| `scripts/fusion/fixtures/test_stats.py` | 离线 | [10](../10_融合助手运行维护.md)、[16](../16_验收与测试总表.md) | 固定验收 fixture：后台代码任务的 mean/moving_average 断言 | 只读 | 否 | code | — |
| `scripts/fusion/test/documentation-map.test.mjs` | 离线 | [16](../16_验收与测试总表.md) | 文档归属、缺失目标、未登记文件与生成表漂移的正负回归，仅临时仓库 | 写临时测试目录 | 否 | header | `docs/verification/documentation-2026-10-21/README.md` |
| `scripts/fusion/test/log-query.test.mjs` | 离线 | [18](../18_跨模块链路日志查询.md) | 跨 SnowLuma/OpenClaw/提醒来源的链路事件适配、关联与脱敏 | 只读 | 否 | offline | — |
| `scripts/fusion/test/recovery.test.mjs` | 离线 | [10](../10_融合助手运行维护.md)、[16](../16_验收与测试总表.md) | 备份/恢复工具单元与集成回归 | 只读 | 否 | offline | — |
| `scripts/fusion/test/register-project.test.mjs` | 离线 | [10](../10_融合助手运行维护.md)、[16](../16_验收与测试总表.md) | 项目注册表维护 CLI 与共享保护根规则回归（含归档拒绝） | 只读 | 否 | offline | — |
| `chatbot/packages/personal-domains/src/test-fixtures.ts` | 库 | [21](../21_后端职责分层与代码整理.md) | 默认领域的离线QWeather/GeoAPI数据夹具 | 只读 | 否 | code | — |
| `chatbot/plugins/kurumi-mail/test/helpers/mock-smtp.js` | 库 | [20](../20_邮件能力与横切扩展.md) | 邮件测试的本地TLS/SMTP服务器及故障夹具，无公网外发 | 只读 | 否 | header | — |
| `chatbot/plugins/kurumi-mail/test/helpers/owner-context.js` | 库 | [20](../20_邮件能力与横切扩展.md) | 邮件测试的可信主人上下文与确认scope夹具，不产生生产授权 | 只读 | 否 | header | — |
| `chatbot/tests/acceptance/call-analysis.mjs` | 库 | [16](../16_验收与测试总表.md) | 旧验收调用观察工具（只观察，不证明写入） | 只读 | 否 | header | — |
| `chatbot/tests/acceptance/domain-fixture.mjs` | 库 | [16](../16_验收与测试总表.md) | 旧验收领域夹具与工具定义 | 只读 | 否 | code | — |
| `chatbot/tests/acceptance/host-driver.mjs` | 库 | [16](../16_验收与测试总表.md) | 旧 harness Host 驱动，只开测试状态目录 | 写临时测试目录、只读 | 否 | code | — |
| `chatbot/tests/acceptance/model-driver.mjs` | 库 | [16](../16_验收与测试总表.md) | 旧 harness 模型驱动（构造模型客户端，读取遗留 AGENTS） | 真实模型 | 否 | code | — |
| `chatbot/tests/acceptance/retrieval-config.mjs` | 库 | [16](../16_验收与测试总表.md) | 旧验收检索输出预算配置 | 只读 | 否 | header | — |
| `chatbot/tests/access-control/fixtures.mjs` | 库 | [24](../24_统一身份与权限管理.md) | 构造合成QQ身份/显式权限与可信上下文，不导入生产名单 | 只读 | 否 | header | — |
| `chatbot/tests/papers/fixtures.mjs` | 库 | [22](../22_论文PDF翻译与文件投递.md) | 生成最小有效 PDF 测试字节，不读生产文件 | 只读 | 否 | header | — |
| `chatbot/tests/papers/mime-parse.py` | 库 | [22](../22_论文PDF翻译与文件投递.md) | 标准 email 解析器检查完整 SMTP MIME 的正文/附件名/解码字节哈希；只处理测试 stdin | 只读 | 否 | header | — |
| `chatbot/tests/reminder-list/dialogue-cases.mjs` | 库 | [19](../19_提醒列表与定时汇总.md) | 用户七句验收样例与字段期望（纯数据，无生产导入） | 只读 | 否 | header | — |
| `chatbot/tests/reminder-list/production-guard.mjs` | 库 | [19](../19_提醒列表与定时汇总.md) | 只读比较生产列表与一次性提案/提醒逻辑数据，不输出私有记录 | 只读 | 否 | header | — |
| `scripts/fusion/lib/backup-service.mjs` | 库 | [10](../10_融合助手运行维护.md)、[16](../16_验收与测试总表.md) | 备份期间停写并恢复服务 | 重启或停服务 | 否 | header | — |
| `scripts/fusion/lib/documentation-map.mjs` | 库 | [16](../16_验收与测试总表.md) | 只读文档归属、命名分组及维护源码发现；不执行扫描到的文件 | 只读 | 否 | header | `docs/verification/documentation-2026-10-21/README.md` |
| `scripts/fusion/lib/fresh-id.mjs` | 库 | [10](../10_融合助手运行维护.md)、[16](../16_验收与测试总表.md) | 生成不重复的 message id | 只读 | 否 | header | — |
| `scripts/fusion/lib/legacy-source.mjs` | 库 | [10](../10_融合助手运行维护.md)、[16](../16_验收与测试总表.md) | 解析旧 OpenClaw 源树路径（仅迁移脚本用） | 只读 | 否 | header | — |
| `scripts/fusion/lib/package-manifests.mjs` | 库 | [10](../10_融合助手运行维护.md)、[16](../16_验收与测试总表.md) | 只读发现仓库自有锁文件包及构建声明，供依赖检查与隔离恢复共同使用 | 只读 | 否 | header | — |
| `scripts/fusion/lib/plugins.mjs` | 库 | [10](../10_融合助手运行维护.md)、[16](../16_验收与测试总表.md) | 第三方插件声明（纯数据，导入无 I/O） | 只读 | 否 | header | — |
| `scripts/fusion/lib/recovery-isolation.mjs` | 库 | [10](../10_融合助手运行维护.md)、[16](../16_验收与测试总表.md) | 隔离恢复的路径、凭据与共享业务禁用改写，仅写恢复副本 | 写临时测试目录 | 否 | header | — |
| `scripts/fusion/lib/working-tree-backup.mjs` | 库 | [10](../10_融合助手运行维护.md)、[16](../16_验收与测试总表.md) | 已跟踪修改的 Git 补丁归档；被 backup-state 调用时写 patches/ 与 untracked.tar | 写运行状态 | 否 | code | — |
| `scripts/fusion/rpc.mjs` | 库 | [10](../10_融合助手运行维护.md)、[16](../16_验收与测试总表.md) | Gateway RPC 客户端库（被其他脚本导入） | 只读 | 否 | code | — |
| `chatbot/scripts/access-control.mjs` | 只读运维 | [24](../24_统一身份与权限管理.md) | 严格校验统一身份权限并输出JSON/TSV矩阵，不改运行名单 | 只读 | 否 | header | — |
| `scripts/fusion/evidence-coverage.mjs` | 只读运维 | [16](../16_验收与测试总表.md) | 校验证据目录分类覆盖，未分类即非零退出 | 只读 | 否 | header | — |
| `scripts/fusion/evidence-index.mjs` | 只读运维 | [16](../16_验收与测试总表.md) | 生成本脚本与证据索引 | 只读 | 否 | header | `docs/verification/SCRIPTS.md` |
| `scripts/fusion/health.mjs` | 只读运维 | [10](../10_融合助手运行维护.md)、[16](../16_验收与测试总表.md) | 服务、QQ、频道、Cron、数据库健康 | 只读 | 否 | header | — |
| `scripts/fusion/inspect-receipts.mjs` | 只读运维 | [10](../10_融合助手运行维护.md)、[16](../16_验收与测试总表.md) | 查看验收回执 | 只读 | 否 | code | `docs/verification/fusion/receipts.json` |
| `scripts/fusion/log-query.mjs` | 只读运维 | [18](../18_跨模块链路日志查询.md) | 跨 SnowLuma/OpenClaw/提醒来源的链路事件只读查询 | 只读 | 否 | header | — |
| `scripts/fusion/probe-final.mjs` | 只读运维 | [10](../10_融合助手运行维护.md)、[16](../16_验收与测试总表.md) | health.mjs 的兼容入口 | 只读 | 否 | header | — |
| `scripts/fusion/stack-summary.mjs` | 只读运维 | [10](../10_融合助手运行维护.md)、[16](../16_验收与测试总表.md) | 启停输出压缩显示 | 只读 | 否 | header | — |
| `scripts/fusion/sync-config.mjs` | 只读运维 | [10](../10_融合助手运行维护.md)、[16](../16_验收与测试总表.md) | 默认只报告配置漂移；--apply 才写 openclaw.json | 写运行状态、只读 | 否 | header | — |
| `scripts/fusion/sync-persona.mjs` | 只读运维 | [25](../25_人格、记忆与会话连续性.md) | 默认只报告人格漂移；--apply 写各已登记身份的四份受管文件，不复制记忆/历史 | 写运行状态、只读 | 否 | header | — |
| `scripts/fusion/verify-dependencies.mjs` | 只读运维 | [10](../10_融合助手运行维护.md)、[16](../16_验收与测试总表.md) | 依赖自持、无归档树逃逸、锁文件一致 | 只读 | 否 | header | — |
| `chatbot/scripts/backup-knowledgemap-code.mjs` | 领域运维 | [23](../23_KnowledgeMap业务能力桥接.md) | 只读两个主工作树，保存bundle/index/工作树包到新私密备份目录，不含数据库 | 写运行状态 | 是 | header | — |
| `chatbot/scripts/import-paper-credentials.mjs` | 领域运维 | [22](../22_论文PDF翻译与文件投递.md) | 显式导入指定 GPT/DeepSeek 凭据，原子合并到私密 0600 文件；不输出密钥 | 写运行状态 | 是 | header | — |
| `chatbot/scripts/setup-paper-translation.sh` | 领域运维 | [22](../22_论文PDF翻译与文件投递.md) | 按锁文件安装隔离 Python 翻译环境并检查实际导入；不调模型或外发 | 真实外部API、写运行状态 | 是 | header | — |
| `chatbot/scripts/build-personal-plugins.mjs` | 构建 | [21](../21_后端职责分层与代码整理.md) | 构建共享领域TypeScript与版本化兼容CLI，仅写忽略的dist目录，无API/数据库/服务操作 | 写仓库内文件 | 否 | header | `docs/verification/capability-decoupling-2026-10-20/README.md` |
| `chatbot/scripts/import-knowledgemap-list.mjs` | 迁移工具 | [23](../23_KnowledgeMap业务能力桥接.md) | 默认预览旧列表导入；--apply写共享业务，--activate冻结旧项并启用runner切换标记 | 真实外部API、写运行状态 | 是 | header | — |
| `chatbot/scripts/memory-migrate.mjs` | 迁移工具 | [25](../25_人格、记忆与会话连续性.md) | 文档25显式预览或迁移主人旧 MEMORY.md 到私密连续性 SQLite；--apply写私密备份与记忆状态，不调用模型/QQ/邮件 | 写运行状态 | 是 | header | — |
| `scripts/fusion/configure-deepseek-persona.mjs` | 迁移工具 | [10](../10_融合助手运行维护.md) | 一次性切到 DeepSeek+小鲸鱼；日常禁用作人格入口 | 真实模型、写运行状态 | 是 | header | — |
| `scripts/fusion/configure-domains.mjs` | 迁移工具 | [10](../10_融合助手运行维护.md)、[16](../16_验收与测试总表.md) | 启用主人绑定领域插件 | 写运行状态 | 是 | header | — |
| `scripts/fusion/configure-fulltext-research.mjs` | 迁移工具 | [10](../10_融合助手运行维护.md)、[16](../16_验收与测试总表.md) | 研究会话、笔记工作区与来源缓存 | 写运行状态 | 是 | header | — |
| `scripts/fusion/configure-interaction.mjs` | 迁移工具 | [10](../10_融合助手运行维护.md)、[16](../16_验收与测试总表.md) | 复制表情目录并设定迁移/每日发送预算 | 写运行状态 | 是 | header | — |
| `scripts/fusion/configure-production.mjs` | 迁移工具 | [10](../10_融合助手运行维护.md)、[16](../16_验收与测试总表.md) | 关闭仅验收能力，保留历史；需先审阅活动任务 | 写运行状态 | 是 | header | `docs/verification/migration/33-production-config.json` |
| `scripts/fusion/configure-projects.mjs` | 迁移工具 | [10](../10_融合助手运行维护.md)、[16](../16_验收与测试总表.md) | 一次性首次引导：只在 id 不存在时追加登记并写运行 openclaw.json | 写运行状态 | 是 | header | — |
| `scripts/fusion/configure-research.mjs` | 迁移工具 | [10](../10_融合助手运行维护.md)、[16](../16_验收与测试总表.md) | 配置检索 provider 与抓取路径 | 写运行状态 | 是 | header | — |
| `scripts/fusion/configure-worker.mjs` | 迁移工具 | [10](../10_融合助手运行维护.md)、[16](../16_验收与测试总表.md) | 显式配置隔离代码 worker | 写运行状态 | 是 | header | — |
| `scripts/fusion/prepare.mjs` | 迁移工具 | [10](../10_融合助手运行维护.md)、[16](../16_验收与测试总表.md) | 首次引导隔离运行目录，拒绝覆盖已写内容 | 写运行状态 | 是 | header | — |
| `chatbot/scripts/reminder-list.mjs` | 领域运行 | [19](../19_提醒列表与定时汇总.md) | 固定提醒列表 Cron 程序：按切换来源查询、slot 防重和汇总输出，OpenClaw 投递本人 | 写运行状态 | 是 | header | — |
| `chatbot/tests/acceptance/probe-profile-geo.py` | 遗留验收 | [16](../16_验收与测试总表.md) | GeoAPI provider 探测 | 真实外部API、写仓库内文件 | 是 | code | `docs/verification/profile-geo-provider-probe.json` |
| `chatbot/tests/acceptance/run-fallback-failover.mjs` | 遗留验收 | [16](../16_验收与测试总表.md) | 主模型指向必然失败地址、fallback 用真实 deepseek | 真实模型、写临时测试目录 | 是 | header | — |
| `chatbot/tests/acceptance/run-model.mjs` | 遗留验收 | [16](../16_验收与测试总表.md) | 真实主模型 + 有界工具循环；合成 QQ 身份，无 QQ 传输 | 真实模型、写临时测试目录 | 是 | boundary | — |
| `chatbot/tests/acceptance/run-profile-geo.mjs` | 遗留验收 | [16](../16_验收与测试总表.md) | 真实 GeoAPI + 隔离 Profile 库；无生产确认、无 QQ 投递 | 真实外部API、写临时测试目录 | 是 | header | `docs/verification/profile-geo-domain-acceptance.json` |
| `chatbot/tests/acceptance/run-real-cron.mjs` | 遗留验收 | [16](../16_验收与测试总表.md) | 隔离 Gateway 的真实 Cron 存储与确认钩子；确定性认知，无模型、无 QQ 网络 | 建/改任务或提醒、写临时测试目录 | 是 | boundary | — |
| `chatbot/tests/acceptance/run-reminder-expiry.mjs` | 遗留验收 | [16](../16_验收与测试总表.md) | 真实主模型有界循环 + 提醒提案工具 + 隔离库；非生产 Agent/QQ 验收 | 真实模型、建/改任务或提醒、写临时测试目录 | 是 | boundary | — |
| `chatbot/tests/acceptance/run-retrieval-host.mjs` | 遗留验收 | [16](../16_验收与测试总表.md) | 全新 Host 状态 + 原生工具 + 真实 API；无 QQ 发送、不碰生产库 | 真实模型、真实外部API、写临时测试目录 | 是 | boundary | — |
| `chatbot/tests/acceptance/run-retrieval-smoke.mjs` | 遗留验收 | [16](../16_验收与测试总表.md) | 检索注册冒烟：不启动 Gateway/频道，凭据为合成值 | 真实外部API、写临时测试目录 | 是 | header | — |
| `chatbot/tests/acceptance/run-retrieval-t2.mjs` | 遗留验收 | [16](../16_验收与测试总表.md) | 真实 Tavily API（生产凭据）；无模型、无 Host、无 QQ 投递、不写生产库 | 真实外部API | 是 | boundary | — |
| `chatbot/tests/acceptance/run-retrieval-t3.mjs` | 遗留验收 | [16](../16_验收与测试总表.md) | 真实模型 + 真实 Tavily + 真实 HTTP；无 Host、无 QQ 投递、不改生产配置 | 真实模型、真实外部API | 是 | boundary | — |
| `chatbot/tests/acceptance/run.mjs` | 遗留验收 | [16](../16_验收与测试总表.md) | 旧 harness 总入口：真实 Host 调度 + 合成 QQ 输入 + 确定性认知 + 假调度 | 写仓库内文件、写临时测试目录 | 是 | boundary | — |
| `chatbot/tests/acceptance/verify-restart.mjs` | 遗留验收 | [16](../16_验收与测试总表.md) | 在新进程里重开测试目录并验证幂等；不重启任何服务 | 写临时测试目录、只读 | 否 | header | — |
| `chatbot/tests/access-control/acceptance-host.mjs` | 验收 | [24](../24_统一身份与权限管理.md) | 真实隔离OpenClaw、本地确定性模型与模拟OneBot/翻译器：双身份、强制策略及后台交接；无真实API/QQ/邮件 | 重启或停服务、写仓库内文件、写临时测试目录 | 否 | boundary | `docs/verification/access-control-2026-10-19/host.json` |
| `chatbot/tests/backend-boundaries/acceptance-capabilities-host.mjs` | 验收 | [21](../21_后端职责分层与代码整理.md) | 真实隔离Gateway的四插件加载/逐个禁用、工具归属与确认后端RPC，无API/模型/QQ或生产写入 | 重启或停服务、写仓库内文件、写临时测试目录 | 否 | boundary | `docs/verification/capability-decoupling-2026-10-20/README.md` |
| `chatbot/tests/knowledgemap/acceptance-bills-live.mjs` | 验收 | [23](../23_KnowledgeMap业务能力桥接.md) | 第二轮真实模型/生产API/MySQL/网页增改删查、歧义及天气runId；合成入站不发QQ | 真实模型、真实外部API、重启或停服务、写运行状态、写仓库内文件 | 是 | header | — |
| `chatbot/tests/knowledgemap/acceptance-host.mjs` | 验收 | [23](../23_KnowledgeMap业务能力桥接.md) | 真实模型与隔离OpenClaw/原生调度、临时HTTP业务库、模拟OneBot | 真实模型、重启或停服务、写仓库内文件、写临时测试目录 | 是 | header | — |
| `chatbot/tests/knowledgemap/acceptance-live.mjs` | 验收 | [23](../23_KnowledgeMap业务能力桥接.md) | 真实模型/生产API/MySQL/网页与一次本人QQ播报；短暂测试入口、精确测试行清理并保留回执 | 真实模型、真实外部API、真实QQ外发、建/改任务或提醒、重启或停服务、写运行状态、写仓库内文件 | 是 | header | `docs/verification/knowledgemap-bridge-2026-10-17/live.json` |
| `chatbot/tests/knowledgemap/acceptance-model.mjs` | 验收 | [23](../23_KnowledgeMap业务能力桥接.md) | 真实模型、实际v2工具及临时HTTP/SQLite，无QQ/生产写入 | 真实模型、写仓库内文件、写临时测试目录 | 是 | header | — |
| `chatbot/tests/knowledgemap/recovery.mjs` | 验收 | [23](../23_KnowledgeMap业务能力桥接.md) | 今晚Git工作树和SQLite备份的临时目录恢复，不启动旧服务 | 写临时测试目录 | 是 | header | — |
| `chatbot/tests/papers/acceptance-api.py` | 验收 | [22](../22_论文PDF翻译与文件投递.md) | 合成短文逐个实测翻译渠道；读取私密凭据，仅向 --out 写结果，无 QQ/邮件外发 | 真实模型、真实外部API、写仓库内文件 | 是 | header | `docs/verification/paper-translation-2026-10-17/README.md` |
| `chatbot/tests/papers/acceptance-download.mjs` | 验收 | [22](../22_论文PDF翻译与文件投递.md) | 真实公开论文 HTTP 下载与隔离 PDF 校验；私密验收目录 | 真实外部API、写运行状态、写仓库内文件 | 是 | boundary | `docs/verification/paper-translation-2026-10-17/README.md`<br>`docs/verification/paper-translation-2026-10-17/download.json` |
| `chatbot/tests/papers/acceptance-file-ingress.mjs` | 验收 | [22](../22_论文PDF翻译与文件投递.md) | 真实隔离OpenClaw/聊天模型、附件入站与双身份论文编排；合成下载/翻译/OneBot，无生产写入或真实外发 | 真实模型、重启或停服务、写仓库内文件、写临时测试目录 | 是 | boundary | `docs/verification/paper-translation-2026-10-17/file-ingress-2026-10-19/README.md` |
| `chatbot/tests/papers/acceptance-host.mjs` | 验收 | [22](../22_论文PDF翻译与文件投递.md) | 真实 OpenClaw/主模型调用 PDF 工具，模拟翻译/OneBot；独立临时状态，无真实 QQ/邮件 | 真实模型、重启或停服务、写仓库内文件、写临时测试目录 | 是 | boundary | `docs/verification/paper-translation-2026-10-17/README.md`<br>`docs/verification/paper-translation-2026-10-17/host.json` |
| `chatbot/tests/papers/acceptance-worker.mjs` | 验收 | [22](../22_论文PDF翻译与文件投递.md) | 生产捕获源码、正文空闲/重试配置与可取消HTTP子进程在真实隔离Python检查，无模型/外发 | 写仓库内文件、写临时测试目录 | 否 | boundary | `docs/verification/paper-translation-2026-10-17/README.md` |
| `chatbot/tests/papers/acceptance.mjs` | 验收 | [22](../22_论文PDF翻译与文件投递.md) | 真实指定 PDF 翻译；显式 --send-qq/--send-mail 才向本人实际投递，程序化确认不等于 QQ 确认 | 真实模型、真实外部API、真实QQ外发、写运行状态、写仓库内文件 | 是 | boundary | `docs/verification/paper-translation-2026-10-17/README.md` |
| `chatbot/tests/persona/acceptance-host.mjs` | 验收 | [25](../25_人格、记忆与会话连续性.md) | 文档25真实隔离OpenClaw/模拟OneBot的实际人格注入；默认本地模型，--live使用官方DeepSeek，无真实QQ外发 | 真实模型、重启或停服务、写仓库内文件、写临时测试目录 | 是 | boundary | `docs/verification/persona-memory-2026-10-19/README.md` |
| `chatbot/tests/persona/continuity-host.mjs` | 验收 | [25](../25_人格、记忆与会话连续性.md) | 文档25 P2真实隔离OpenClaw授权钩子、/new历史清理、手动压缩与临时宿主重启；确定性模型和模拟OneBot，无真实API或QQ | 重启或停服务、写仓库内文件、写临时测试目录 | 否 | boundary | `docs/verification/persona-memory-2026-10-19/p2/README.md` |
| `chatbot/tests/persona/memory-continuity-host.mjs` | 验收 | [25](../25_人格、记忆与会话连续性.md) | 文档25 P2真实隔离OpenClaw；默认确定性模型，--live官方DeepSeek最多40请求/每次1200输出tokens；临时状态和模拟OneBot，验证自动/显式保存、更正/遗忘、/new、成员隔离和契约，无真实QQ/邮件或生产写入 | 真实模型、重启或停服务、写仓库内文件、写临时测试目录 | 是 | boundary | `docs/verification/persona-memory-2026-10-19/p2/README.md` |
| `chatbot/tests/reminder-list/acceptance-host.mjs` | 验收 | [19](../19_提醒列表与定时汇总.md) | 隔离 OpenClaw 与真实模型；--natural 同时开放两类提醒、真实会话重置；模拟 OneBot，无生产写入；--out 独立证据目录 | 真实模型、重启或停服务、写仓库内文件、写临时测试目录 | 是 | header | `docs/verification/reminder-list-2026-10-11`<br>`docs/verification/reminder-list-2026-10-11/host.json` |
| `chatbot/tests/reminder-list/acceptance-model.mjs` | 验收 | [19](../19_提醒列表与定时汇总.md) | 真实 DeepSeek 调用列表工具；--ordinal 验证序号/排序变化/澄清，--natural 七句与连续录入；--out 独立证据目录 | 真实模型、写仓库内文件、写临时测试目录 | 是 | header | `docs/verification/reminder-list-2026-10-11`<br>`docs/verification/reminder-list-2026-10-11/model.json` |
| `chatbot/tests/reminder-list/acceptance-native.mjs` | 验收 | [19](../19_提醒列表与定时汇总.md) | 真实原生 Cron 跨重启发本人一条汇总；待办在临时库、正常撤销测试任务 | 真实QQ外发、建/改任务或提醒、重启或停服务、写运行状态、写仓库内文件、写临时测试目录 | 是 | header | `docs/verification/reminder-list-2026-10-11`<br>`docs/verification/reminder-list-2026-10-11/native.json` |
| `scripts/fusion/test-background-code.mjs` | 验收 | [10](../10_融合助手运行维护.md)、[16](../16_验收与测试总表.md) | 后台代码任务登记检查与终态 | 真实模型、真实QQ外发、建/改任务或提醒、写运行状态、写仓库内文件 | 是 | header | `docs/verification/fusion/10-background-code.json` |
| `scripts/fusion/test-domain-due.mjs` | 验收 | [10](../10_融合助手运行维护.md)、[16](../16_验收与测试总表.md) | 提醒到点投递（跨重启） | 真实模型、真实QQ外发、建/改任务或提醒、写运行状态、写仓库内文件 | 是 | header | `docs/verification/migration/10-reminder-restart-delivery.json` |
| `scripts/fusion/test-domain-planning.mjs` | 验收 | [10](../10_融合助手运行维护.md)、[16](../16_验收与测试总表.md) | 行程提案与确认写入（隔离库） | 真实模型、写运行状态、写仓库内文件 | 是 | header | `docs/verification/migration/11-planning-confirmation.json` |
| `scripts/fusion/test-domain-read.mjs` | 验收 | [10](../10_融合助手运行维护.md)、[16](../16_验收与测试总表.md) | 领域只读自然语言验收：真实模型 + QWeather 工具；不发 QQ、不写偏好 | 真实模型、真实外部API、写仓库内文件 | 是 | boundary | `docs/verification/migration/06-domain-read.json` |
| `scripts/fusion/test-domain-reminder.mjs` | 验收 | [10](../10_融合助手运行维护.md)、[16](../16_验收与测试总表.md) | 提醒 CRUD 与确认口令，回复本地捕获 | 真实模型、建/改任务或提醒、写运行状态、写仓库内文件 | 是 | header | `docs/verification/migration/09-reminder-crud.json` |
| `scripts/fusion/test-fulltext-research.mjs` | 验收 | [10](../10_融合助手运行维护.md)、[16](../16_验收与测试总表.md) | 论文全文研究任务 | 真实模型、建/改任务或提醒、写运行状态、写仓库内文件 | 是 | code | `docs/verification/migration/26-fulltext-research.json` |
| `scripts/fusion/test-live-inbound.mjs` | 验收 | [10](../10_融合助手运行维护.md)、[16](../16_验收与测试总表.md) | 合成入站 → 真实模型 → 本人 QQ 外发 | 真实模型、真实QQ外发、写运行状态、写仓库内文件 | 是 | header | `docs/verification/fusion/01-native-inbound.json` |
| `scripts/fusion/test-live-media.mjs` | 验收 | [10](../10_融合助手运行维护.md)、[16](../16_验收与测试总表.md) | 合成图片入站与真实外发 | 真实模型、真实QQ外发、写运行状态、写仓库内文件 | 是 | header | `docs/verification/fusion/03-native-media.json` |
| `scripts/fusion/test-mail-delivery.mjs` | 验收 | [20](../20_邮件能力与横切扩展.md) | 邮件真实投递：真实授权码与真实 SMTP；确认由脚本按宿主路由同一调用记录，不含 QQ 入站与到信确认 | 真实外部API、写运行状态 | 是 | boundary | — |
| `scripts/fusion/test-memory.mjs` | 验收 | [25](../25_人格、记忆与会话连续性.md) | 真实模型记忆 CRUD（合成事实） | 真实模型、写运行状态、写仓库内文件 | 是 | header | `docs/verification/migration/13-memory-model.json` |
| `scripts/fusion/test-native-concurrency.mjs` | 验收 | [10](../10_融合助手运行维护.md)、[16](../16_验收与测试总表.md) | 两个原生会话并发；不发 QQ | 真实模型、写运行状态、写仓库内文件 | 是 | header | `docs/verification/fusion/05-native-concurrency.json` |
| `scripts/fusion/test-native-cron.mjs` | 验收 | [10](../10_融合助手运行维护.md)、[16](../16_验收与测试总表.md) | 原生 Cron CRUD 与频道投递 | 真实QQ外发、建/改任务或提醒、重启或停服务、写仓库内文件 | 是 | header | `docs/verification/fusion/04-native-cron.json` |
| `scripts/fusion/test-profile-confirmation.mjs` | 验收 | [10](../10_融合助手运行维护.md)、[16](../16_验收与测试总表.md) | Profile 变更确认后恢复原值 | 真实模型、写运行状态、写仓库内文件 | 是 | header | `docs/verification/migration/08-profile-confirmation.json` |
| `scripts/fusion/test-project-maintenance.mjs` | 验收 | [10](../10_融合助手运行维护.md)、[16](../16_验收与测试总表.md) | 真实 QQ → 项目 worker → 隔离检查 → 本地提交 | 真实模型、真实QQ外发、建/改任务或提醒、写运行状态、写仓库内文件 | 是 | header | `docs/verification/migration/22-project-maintenance.json` |
| `scripts/fusion/test-project-scoped-commit.mjs` | 验收 | [10](../10_融合助手运行维护.md)、[16](../16_验收与测试总表.md) | 提交范围只含指定文件 | 真实模型、真实QQ外发、建/改任务或提醒、写运行状态、写仓库内文件 | 是 | header | `docs/verification/migration/23-project-scoped-commit.json` |
| `scripts/fusion/test-qq-interaction.mjs` | 验收 | [10](../10_融合助手运行维护.md)、[16](../16_验收与测试总表.md) | 合成主人 → 真实模型 → 仅本人 QQ 的分段与表情外发 | 真实模型、真实QQ外发、写运行状态、写仓库内文件 | 是 | boundary | `docs/verification/migration/15-qq-natural-sticker.json` |
| `scripts/fusion/test-recurring-weather.mjs` | 验收 | [10](../10_融合助手运行维护.md)、[16](../16_验收与测试总表.md) | 周期天气 automations | 真实模型、真实QQ外发、建/改任务或提醒、写运行状态、写仓库内文件 | 是 | code | `docs/verification/migration/27-recurring-weather.json` |
| `scripts/fusion/test-reminder-delivery.mjs` | 验收 | [10](../10_融合助手运行维护.md)、[16](../16_验收与测试总表.md) | 自然语言 → automations → 到点外发 | 真实模型、真实QQ外发、建/改任务或提醒、写运行状态、写仓库内文件 | 是 | header | `docs/verification/fusion/13-natural-reminder-delivery.json` |
| `scripts/fusion/test-reminder-tool.mjs` | 验收 | [10](../10_融合助手运行维护.md)、[16](../16_验收与测试总表.md) | 提醒工具 CRUD（须先取消未来任务） | 真实模型、建/改任务或提醒、写运行状态、写仓库内文件 | 是 | header | `docs/verification/fusion/09-native-agent-reminder.json` |
| `scripts/fusion/test-research-cancel.mjs` | 验收 | [10](../10_融合助手运行维护.md)、[16](../16_验收与测试总表.md) | 研究任务查询与取消 | 真实模型、建/改任务或提醒、写运行状态、写仓库内文件 | 是 | header | `docs/verification/migration/28-research-cancel.json` |
| `scripts/fusion/test-research.mjs` | 验收 | [10](../10_融合助手运行维护.md)、[16](../16_验收与测试总表.md) | 公开论文检索：真实模型 + web_search/web_fetch；无 QQ 输出、无记忆写入 | 真实模型、真实外部API、写运行状态、写仓库内文件 | 是 | boundary | `docs/verification/fusion/15-research.json` |
| `scripts/fusion/test-service-recovery.mjs` | 验收 | [10](../10_融合助手运行维护.md)、[16](../16_验收与测试总表.md) | 服务故障注入与恢复；不发 QQ、不调模型 | 重启或停服务、写运行状态、写仓库内文件 | 是 | header | `docs/verification/migration/35-service-recovery.json` |
| `scripts/fusion/test-task-control.mjs` | 验收 | [10](../10_融合助手运行维护.md)、[16](../16_验收与测试总表.md) | 任务查询与取消 | 真实模型、建/改任务或提醒、写运行状态、写仓库内文件 | 是 | header | `docs/verification/fusion/12-task-control.json` |
| `scripts/fusion/backup-state.mjs` | 运维写状态 | [10](../10_融合助手运行维护.md)、[16](../16_验收与测试总表.md) | 制作备份；--quiesce 会短暂停写并恢复服务 | 重启或停服务、写运行状态 | 是 | header | — |
| `scripts/fusion/close-acceptance.mjs` | 运维写状态 | [10](../10_融合助手运行维护.md)、[16](../16_验收与测试总表.md) | 验收结束后关闭 testIngress，不重置发送账本 | 写运行状态 | 是 | header | `docs/verification/fusion/16-closeout.json` |
| `scripts/fusion/copy-domain-state.py` | 运维写状态 | [10](../10_融合助手运行维护.md)、[16](../16_验收与测试总表.md) | 迁移领域状态库（迁移工具，不是日常命令） | 写运行状态 | 是 | code | `docs/verification/migration/04-domain-copy.json` |
| `scripts/fusion/install-plugins.mjs` | 运维写状态 | [10](../10_融合助手运行维护.md)、[16](../16_验收与测试总表.md) | 按锁文件安装受控第三方插件 | 写运行状态 | 是 | header | — |
| `scripts/fusion/install-service.mjs` | 运维写状态 | [10](../10_融合助手运行维护.md)、[16](../16_验收与测试总表.md) | 首次切换 systemd 单元到融合服务 | 重启或停服务 | 是 | header | — |
| `scripts/fusion/link-dependencies.mjs` | 运维写状态 | [10](../10_融合助手运行维护.md)、[16](../16_验收与测试总表.md) | 固定并链接本地 SDK 只读依赖 | 写运行状态 | 是 | header | — |
| `scripts/fusion/recovery-probe.mjs` | 运维写状态 | [10](../10_融合助手运行维护.md)、[16](../16_验收与测试总表.md) | 仅供 restore-verify 在沙箱内启动 Gateway | 写临时测试目录 | 是 | header | — |
| `scripts/fusion/register-project.mjs` | 运维写状态 | [10](../10_融合助手运行维护.md)、[16](../16_验收与测试总表.md) | 维护 projects.json 登记（默认只预览，--apply 才写） | 写运行状态 | 是 | header | — |
| `scripts/fusion/restore-legacy.sh` | 运维写状态 | [15](../15_旧系统回退.md) | 按 A/B 方案把旧系统复制回原路径（不自动启动） | 重启或停服务 | 是 | header | — |
| `scripts/fusion/restore-verify.mjs` | 运维写状态 | [10](../10_融合助手运行维护.md)、[16](../16_验收与测试总表.md) | 隔离恢复演练（只写新建 /tmp 目标） | 写临时测试目录 | 是 | header | — |
| `scripts/fusion/run-gateway.mjs` | 运维写状态 | [10](../10_融合助手运行维护.md)、[16](../16_验收与测试总表.md) | 前台生产入口；日常只由 systemd 启动 | 真实模型、重启或停服务、写运行状态 | 是 | header | — |
| `scripts/fusion/stop-gateway.mjs` | 运维写状态 | [10](../10_融合助手运行维护.md)、[16](../16_验收与测试总表.md) | 按环境证明停止隔离 Gateway | 重启或停服务 | 是 | header | — |
| `scripts/fusion/launchers/Start-DSH.sh` | 启停脚本 | [10](../10_融合助手运行维护.md) | 启动 DSH Web 与融合助手；QQ 传输只检查不启停，旧消费者由 Conflicts 停掉 | 重启或停服务 | 是 | header | — |
| `scripts/fusion/launchers/Stop-DSH.sh` | 启停脚本 | [10](../10_融合助手运行维护.md) | 停止融合助手与 DSH Web；不停止 QQ 传输 | 重启或停服务 | 是 | header | — |
<!-- END GENERATED SCRIPT INDEX -->
