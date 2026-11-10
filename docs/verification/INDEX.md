# 验证证据索引

- [N3固定周期完整接线与隔离验收](proactive-runtime-2026-11-10/README.md)：191项相关回归（N3 62项）、17项恢复保护、35项领域测试；实际组合入口补测14场景/30次本地请求，其中18次后台请求核对五份bootstrap内容；基础SDK12场景/20请求。生产未启用，具体参数/用途及真实模型/QQ/长期体验待审核。

- [N3前台生命周期接线](proactive-lifecycle-2026-11-09/README.md)：真实入站处理器的元数据/去重/抢占、reset/end及迟到投递回执；38项机制与隔离Gateway12场景/20次本地请求通过。尚无生产N3消费者、主动外发或新权限。

- [N3可信运行基础](proactive-foundation-2026-11-07/README.md)：24项机制测试及真实隔离Gateway10场景/18次本地确定性请求通过；尚未接入生产QQ/领域授权、调度或上下文，不代表主动陪伴完成。

- [自主诊断与分层复验2026-11-07](autonomous-verification-2026-11-07/README.md)：日志P1/P2、只读快照、真实隔离E7/成员宿主及公开FAQ+当前主模型；[第二批2C](autonomous-verification-2026-11-07/e7-2c/README.md)的玩法/估值、公开接口与模型技术验证；真人客户端与长期体验单列。

- [统一表达与通知2026-11-07](unified-expression-2026-11-07/README.md)：共享说明/确认事实/QQ进度、真实隔离Gateway和固定Cron、工具执行负向探针；模型与平台为模拟。

- [记忆系统v3独立验收](memory-system-2026-11-07/README.md)：记录/迁移/遮罩/游标、真实隔离宿主及模型观察；生产尚未切换。

- [编码委托独立验收与恢复补齐](coding-autonomous-2026-11-07/README.md)：真实DSH五轮、Git及无Git目录、中文文件改名/后缀、续接/取消/结果与受控合入、重启核对及Fusion自有执行隔离依赖；[第二期普通文件管理](coding-autonomous-2026-11-07/ordinary-files.md)记录多目录原生exec、主人范围投影及隔离恢复撤除资料根的回归/Gateway证据，主人具体批准的下载/文档两目录已启用，实际配置只读核对、成员/未登记目录拒绝与四检通过。

本目录只存放测试输出、验收回执和复核报告，不定义运行规则。规则从[文档入口](../README.md)进入，判定见[文档16](../16_验收与测试总表.md)。本页按主题导航，文件/目录归属的唯一数据源为[documentation-map.json](../../scripts/fusion/documentation-map.json)。新增证据组同时登记两处；已登记目录中的文件继承归属。**脚本的归属、副作用与授权要求见[SCRIPTS.md](SCRIPTS.md)**。

## 当前有效证据

| 路径 | 用途 |
| --- | --- |
| [four-fixes-2026-11-07/README.md](four-fixes-2026-11-07/README.md)及同目录 | 整理后的日志最小补齐、自然确认择取修复、当前遗忘请求边界与FAQ漏检修复；区分离线、隔离宿主、公开接口和真人待复验 |
| [`consolidation-2026-11-07/README.md`](consolidation-2026-11-07/README.md)、[统一备份收口](consolidation-2026-11-07/backup-scope-closeout.md) | 本次源码收敛、授权开发数据清理、目录/运行保留机制、内核升级，以及Fusion独立备份范围与恢复开发条件 |
| [`chatbot-agents-archive-2026-10-28/README.md`](chatbot-agents-archive-2026-10-28/README.md) 及同目录全部文件 | 融合前提示词归档、两处旧验收读取路径与首次副本引导修正、正文保留和文档/脚本索引检查；不调用真实模型/API或改变生产行为 |
| [`coding-delegation-plan-2026-10-28/README.md`](coding-delegation-plan-2026-10-28/README.md) 及同目录全部文件 | 编码委托需求、工作树与审批决定、文档合并的本地合入；[接口局部测试](coding-delegation-plan-2026-10-28/local-pilot-2026-10-29/README.md)、[实现前准备](coding-delegation-plan-2026-10-28/full-flow-readiness-2026-10-29.md)、[专用插件产品试点](coding-delegation-plan-2026-10-28/product-pilot-2026-10-29/README.md)；真实DSH处理链及隔离宿主通过；[单目录QQ部署](coding-delegation-plan-2026-10-28/qq-pilot-2026-10-30/README.md)与权限请求记录；[14:25真人回溯](coding-delegation-plan-2026-10-28/qq-review-2026-10-30/README.md)核实编码执行/完成通知及自动查询、结果回传缺口；[结果与检查修复](coding-delegation-plan-2026-10-28/results-fix-2026-10-30/README.md)记录结果持久化、事件回传与独立Python检查；[旧任务兼容](coding-delegation-plan-2026-10-28/policy-compatibility-2026-10-30/README.md)记录取消整体指纹、当前合入复验、17:07成因与真实旧任务只读核对；[主人原生exec](coding-delegation-plan-2026-10-28/owner-exec-2026-10-30/README.md)记录18:16目录查询分析、授权、写入边界、原生宿主调用与部署；[21:24反馈与标题兼容修复](coding-delegation-plan-2026-10-28/qq-2124-title-fix-2026-10-30/README.md)记录三次参数误拒、修复及带title的隔离宿主复验 |
| [`shared-business-merge-2026-10-27/README.md`](shared-business-merge-2026-10-27/README.md) 及同目录全部文件 | 提醒列表规则与定时播报并入KnowledgeMap共享业务；原列表文档归档、引用与脚本/证据归属同步、链接与正文保留检查；不重新验收业务 |
| [`assets-rollback-merge-2026-10-27/README.md`](assets-rollback-merge-2026-10-27/README.md) 及同目录全部文件 | 资产、备份与旧系统回退合并；原回退归档、导航/归属与链接/保留核对，不包含真实恢复或服务切换 |
| [`documentation-merge-2026-10-27/README.md`](documentation-merge-2026-10-27/README.md) 及同目录全部文件 | 架构与运行维护合并、原运行维护归档、现行引用和历史导航调整、章节/链接/归属与只读自检；不改变业务验收 |
| [`SCRIPTS.md`](SCRIPTS.md) | 脚本与证据索引：每个脚本的用途、副作用、是否需授权、会写哪份证据，以及旧 harness 与当前融合验收的边界 |
| [`capability-review-2026-10-28/README.md`](capability-review-2026-10-28/README.md) 及同目录全部文件 | 当前插件/依赖方向、Policy/Store与权限分级复核；377项离线、7组隔离宿主、生产目录与四项自检；首批E7用户反馈登记及第二批开发准备边界 |

| [`proactive-design-2026-10-29/README.md`](proactive-design-2026-10-29/README.md)、[R03](proactive-design-2026-10-29/r03-sources-and-preferences.md)、[R04](proactive-design-2026-10-29/r04-self-interests.md)、[R05](proactive-design-2026-10-29/r05-record-maintenance.md)、[R06](proactive-design-2026-10-29/r06-night-contact-2026-10-31.md)、[R07](proactive-design-2026-10-29/r07-autonomous-speech-2026-10-31.md)及同目录全部文件 | N3工作稿建档与逐轮边界讨论、文档与只读检查；不证明功能实现、模型判断或真实外发 |
| [`natural-confirmation-2026-10-27/README.md`](natural-confirmation-2026-10-27/README.md) 及同目录全部文件 | N4自然语言二次确认：用户批准范围、核心/领域/权限/回执回归、真实隔离宿主和运行对齐；真人QQ与真实模型语义未验收 |
| [`e7-interface-2026-10-27/README.md`](e7-interface-2026-10-27/README.md)、[角色补充](e7-interface-2026-10-27/character-sample/README.md)、[查询契约](e7-interface-2026-10-27/query-contract/README.md)、[首批实现](e7-interface-2026-10-27/phase1/README.md)、[第二批2A/2B](e7-interface-2026-10-27/phase2/README.md)、[10-30 QQ核对](e7-interface-2026-10-27/phase2/qq-review-2026-10-30/README.md)及同目录全部文件 | E7·WIKI公开读取、角色/图片取样与分类设计；文本查询的实现、离线/实际取数/隔离宿主/模型、生产加载及分轮QQ证据。10-30核对保留FAQ漏检、完整消息/回执匹配与日志接口缺口；状态统一见文档16 |
| [`reminder-list-multi-item-2026-10-27/README.md`](reminder-list-multi-item-2026-10-27/README.md)、[闭合记录](reminder-list-multi-item-2026-10-27/closeout.md)及同目录全部文件 | 2026-10-27 提醒列表单消息多项的离线/隔离HTTP、人格与运行核对、01:46真人QQ及后端只读证据；文档收尾与分层证明范围 |
| [`qq-image-2026-10-27/retest-0119.md`](qq-image-2026-10-27/retest-0119.md) 及同目录全部文件 | 2026-10-27 QQ图片初测失败与Fake-IP定向修复后复测：本人JPG入站、PNG表情外发、只读账本核对和前端确认；保留首次失败，图片子项已验收 |
| [`git-consolidation-2026-10-24/README.md`](git-consolidation-2026-10-24/README.md) 及同目录全部文件 | 文档整理与主线补验的冲突合并、记忆调研保留、主线收拢与分支清理；保留各业务原证明范围 |
| [`memory-research-2026-10-24/README.md`](memory-research-2026-10-24/README.md) 及同目录全部文件 | 记忆架构调研工作稿的资料/代码核对、文档检查和范围记录；不代表候选引擎接入或业务重新验收 |
| [`documentation-reorder-2026-10-23/README.md`](documentation-reorder-2026-10-23/README.md) 及同目录全部文件 | 按批准的14项方案重排；逐文件变更、相对既有整理稿的差异、链接/锚点/保留核对与只读自检，不改变业务验收 |
| [`documentation-2026-10-23/README.md`](documentation-2026-10-23/README.md) 及同目录全部文件 | 逐份文档分类、结构整理、过程归档、待办格式和链接/归属核对；不代表业务重新验收 |
| [`documentation-2026-10-21/README.md`](documentation-2026-10-21/README.md) 及同目录全部文件 | 文档归并、入口/锚点与脚本/证据归属核验；检查器10项隔离回归（含2026-11-07嵌套Git边界），不代表业务重新验收 |
| [`capability-decoupling-2026-10-20/README.md`](capability-decoupling-2026-10-20/README.md) 及同目录全部文件 | 文档21现行结构：受控加载、共享代码/论文下载边界、四个个人领域插件；533项回归、5组真实隔离Gateway、配置延期9项初始结果及allow成员检查补正后的10项结果、生产RPC与四项自检；文档26新检索API仅设计 |
| [`plugin-lifecycle-2026-10-19/README.md`](plugin-lifecycle-2026-10-19/README.md) 及同目录全部文件 | 文档21论文/邮件显式停止、共享确认注销归属的先失败后修复回归、真实宿主服务管理器隔离验证；原阶段不含生产重载，后续加载见结构整理专项 |
| [`persona-memory-2026-10-19/README.md`](persona-memory-2026-10-19/README.md) 及同目录全部文件 | 文档25 P1人格/关系分离及P2记忆连续性证据；[p2/](persona-memory-2026-10-19/p2/README.md)记录生命周期调查、连续性宿主、生产迁移/15库备份/19项材料恢复，以及工具契约补正的修前失败、离线/隔离/真实模型复验、定向热重载、收尾检查与22:41修复版真人QQ显式闭环（含一次自动修参）；各轮与未覆盖范围分别说明，持续情绪未实施 |
| [`access-control-2026-10-19/README.md`](access-control-2026-10-19/README.md) 及同目录全部文件 | 文档24统一身份/功能授权、两身份数据/后台撤权、真实隔离宿主、本地主人兼容、授权成员登记及配置部署自检；[提交审查补验（历史材料）](access-control-2026-10-19/README.md#historical-material)区分原发现版本、修复提交和定向结果；用户真人验收反馈单列，不与模拟混同 |
| [`recovery-2026-10-10-final/README.md`](recovery-2026-10-10-final/README.md) | 此前停写恢复点（`2026-10-10-12-36-17-final-closeout`，quiesced，对应 `0f2255a2`，24/24）；不包含新增共享业务，最新配对资料见文档23 |
| `recovery-2026-10-10-final/*` | 上述报告的原始证据：`verification.json`、`isolation-result.json`、`gateway-probe.log`、备份 `EXPECTED.json` 与 `meta` |
| [`recovery-2026-10-10/README.md`](recovery-2026-10-10/README.md) | 上一恢复点（`584b3a0`，含 4547 字节补丁）与 25/25 验证，保留作为历史对照 |
| `recovery-2026-10-10/*` | 上述报告的原始证据：`verification.json`、`isolation-result.json`、`gateway-probe.log`、备份 `EXPECTED.json` 与 `meta` |
| [`recovery-2026-10-06/README.md`](recovery-2026-10-06/README.md) | 上一恢复点（`466b5074`）的恢复与隔离报告，保留作为历史对照 |
| `recovery-2026-10-06/*` | 上述报告引用的逐项 JSON、日志和测试输出 |
| [`2026-10-10_projects-fusion-sync.md`](2026-10-10_projects-fusion-sync.md) | 后台开发副本同步到主仓库 `dacfac4` 的前后状态、归档、沙箱检查复验与未覆盖范围（规则见[后台开发副本契约](../9_QQ融合助手架构与开发计划.md#后台开发副本契约)） |
| [`2026-10-11_projects-fusion-sync.md`](2026-10-11_projects-fusion-sync.md) | 后台开发副本同步到主仓库 `c039e3d`、冲突处理和最终工作区复核（规则见[后台开发副本契约](../9_QQ融合助手架构与开发计划.md#后台开发副本契约)） |
| `fusion/*` | 融合系统阶段验收和最终运行回执；以 recovery 报告和 16 为当前恢复结论 |
| [`deepseek-whale/README.md`](deepseek-whale/README.md) 及同目录全部文件 | 文档11归并后的迁移、模型/图片验收与历史边界；当前规则分别见配置契约、[架构与运行维护手册](../9_QQ融合助手架构与开发计划.md)、后端分层与人格记忆规则 |
| [`mail-2026-10-16/README.md`](mail-2026-10-16/README.md) 及同目录全部文件 | 文档20文本邮件86项回归、真实SMTP/到信/QQ往返，时间戳接缝与误判更正；从原文迁入，整理时未重跑 |
| [`reminder-list-2026-10-11/README.md`](reminder-list-2026-10-11/README.md) 及同目录全部文件 | 提醒列表初版证据及 `natural-input/` 自然多轮录入、空 DDL、实际会话重置、原功能回归与部署复验；原生本人 QQ 投递仍单独引用初版记录 |
| [`backend-refactor-2026-10-16/README.md`](backend-refactor-2026-10-16/README.md) 及同目录全部文件 | 初轮职责分层；`structured-items/` 保存指代修复，`adapters/` 保存初次策略/存储替换、373 项回归与模型/隔离宿主证据；[`adapter-contracts/`](backend-refactor-2026-10-16/adapter-contracts/README.md) 保存同步返回/注销身份补正、最新 395 项回归、构建与运行自检 |
| [`paper-api-2026-10-17/README.md`](paper-api-2026-10-17/README.md) 及同目录全部文件 | 论文翻译第三方协议探查：014 凭据的 Responses/Chat、显式 instructions 输入开销、JSON/占位符和输出预算；不代表 pdf2zh 或文件投递已验收 |
| [00:23生产翻译失败调查](paper-translation-2026-10-17/runtime-failure-2026-10-27/README.md) | 2026-10-27只读任务/回执核对：300963已报告token触发300000预算，030的9笔大输入占205549；5项离线预算/流测试通过。用量来源与修复待处理，未付费重试或修改配置 |
| [论文默认DeepSeek与失败说明](paper-translation-2026-10-17/default-deepseek-notification-2026-10-27/README.md) | 2026-10-27默认官方Flash/high、结构化诊断与原会话无工具说明；125项Node、74项Python回归和真实隔离宿主/固定模型通过。部署状态见回执；本轮无真实模型/API/QQ，真人效果待复验 |
| [17:03论文查询与DeepSeek重译实测调查](paper-translation-2026-10-17/qq-retest-2026-10-27-1703/README.md) | 2026-10-27只读核对本人既有QQ实测：旧状态结果截断；明确要求的DeepSeek新任务95028报告token、单次8192后未完成；后台说明作用域关闭，中文兜底sent且上下文入队。N22待处理，本次未重试/调预算/修代码 |
| [论文输出限制与延迟通知修复](paper-translation-2026-10-17/output-limit-2026-10-27/README.md) 及同目录文件 | 用户要求移除8192，DeepSeek按官方393216请求；未完成原因/安全状态摘要、后台生命周期修复。128项Node、76项Python、真实隔离宿主延迟通知正负对照通过；无付费重译或QQ测试外发，部署与真人边界见报告 |
| [18:35后论文成功实测与N22闭合](paper-translation-2026-10-17/qq-success-2026-10-27-1835/README.md) 及同目录文件 | 2026-10-27只读核对主人既有实测：18:36–18:42默认官方Flash/high，179次完成、283340报告token、393216输出上限、30页双语PDF完整及一次QQ投递；主人确认正常，N22闭合。失败主动说明保持隔离验证边界，本次未新增模型/外发/部署 |
| [`paper-translation-2026-10-17/README.md`](paper-translation-2026-10-17/README.md) 及同目录全部文件 | 文档22的实现、回归、下载/编排与翻译/投递；[日常运行调查](paper-translation-2026-10-17/runtime-investigation-2026-10-19/README.md)收录日常成功、30页冷启动/冷却瓶颈和MD上传后旧译稿误重发的原时点证据；[file-ingress](paper-translation-2026-10-17/file-ingress-2026-10-19/README.md)收录附件事实/纯失败零模型分流修复、191项回归、13场景真实隔离模型/独立产物复验及部署（全套人格对齐归并行文档25）；[output-idle](paper-translation-2026-10-17/output-idle-2026-10-19/README.md)收录有效正文空闲100秒、独立总期限、取消/有界切换及部署检查（原开发时点）；[concurrency-six](paper-translation-2026-10-17/concurrency-six/README.md)收录单篇六并发对比（生产配置仍四并发）；[batch-recovery](paper-translation-2026-10-17/batch-recovery/README.md)收录批次有界重试、冷却恢复、连接诊断/及时取消与真实整篇复验；[high-dual-fix](paper-translation-2026-10-17/high-dual-fix/README.md)收录high默认、30分钟、双语生成/登记与600秒调查；[channel-upgrade](paper-translation-2026-10-17/channel-upgrade/README.md)为三渠道/DeepSeek串行基线；[concurrency-four](paper-translation-2026-10-17/concurrency-four/README.md)为单篇4并发、全文缓存复验与逐篇投递时序；[deepseek-max-default](paper-translation-2026-10-17/deepseek-max-default/README.md)为旧MAX默认。各回执注明缓存/失败/质量边界 |
| [knowledgemap-bridge-2026-10-17/README.md](knowledgemap-bridge-2026-10-17/README.md) 及目录全部文件 | 文档23天气/待做/账单桥接；隔离API、MySQL恢复、网页、模型/宿主与切换证据 |
| [knowledgemap-bills-round2-2026-10-17/README.md](knowledgemap-bills-round2-2026-10-17/README.md) 及目录全部文件 | 文档23第二轮账单完整维护、共享版本/幂等、真实宿主runId关联与部署验收 |

## 历史领域验收

| 文件组 | 内容 |
| --- | --- |
| 顶层 `*-acceptance.json`、`*-deployment.json`、`*-tests.txt` | 确认、提醒、天气、搜索和规划的历史领域验收 |
| `migration/*`（含 29–37） | 迁移阶段的领域测试、阶段回归与中间结果。其中 `29-fusion-regression`、`33-production-config`、`34-service-health`、`35-service-recovery`、`36-project-synchronized`、`37-backup-restore` 是 2026-10-05 在副本提交 `b955abe` 上产生的结算证据；作为**证据**已被 `recovery-2026-10-06/`、`recovery-2026-10-10/` 取代，但其中两条结论仍然有效并在文档 16 重申：`testIngress=false`、每日发送上限 500 且保留历史 |
| `2026-09-*`、`2026-10-01_*`、`2026-10-04_*`、`step6-2026-10-05/*` | 阶段复核、实验、升级和第六步记录 |

这些文件用于追溯，不覆盖当前运行事实；冲突时以代码、当前规则文档和最新恢复报告为准。

## 归档证据

`../archive/verification/`、`../archive/personal-search-tests/` 和 `../archive/2026-*` 保存已退役实现、失败实验和原始阶段记录。它们不属于当前验收集合；如需重新使用，先在新的日期目录产生独立证据。

## 索引完整性

本页按主题分组，不把全部原始回执逐文件展开。实际数量以覆盖脚本为准；命名目录整组归属，互相重叠或没有规则均失败，目标文档必须存在。检查登记与一致性不等于检查测试覆盖率：

```bash
cd /home/afrangry/kurumi-fusion
node scripts/fusion/evidence-coverage.mjs   # 每份证据恰好一个命名组，且归属文档存在
node scripts/fusion/evidence-index.mjs      # 脚本分类、文档归属与boundary双向校验
node scripts/fusion/evidence-index.mjs --check-markdown  # 生成表不能手改或过期
```

新增证据目录或顶层文件必须登记；已有目录新增回执继承归属，不声称每次都会触发检查失败。新增脚本即使位于已有套件目录，仍须登记用途/副作用分类。文件名中的initial/attempt/fixed表示历史过程，不代表当前缺陷仍存在；原始失败保留，不再复制成长篇现行规则。

- [受管PDF名称维护](paper-rename-2026-11-07/README.md)：37项离线与3项真实宿主/模型通过；主人批准后revision6仅给主人启用，20项权限回归及部署自验通过，真人收件单列。

- [QQ主人只读日志工具](qq-log-query-2026-11-10/README.md)：本轮[诊断/查询修复](qq-log-query-2026-11-10/diagnostic-fixes.md)经142相关回归、完整日志宿主12类及原生Cron表达8场景通过；原六个真实主模型定向场景37次请求均通过，历史只读、无真实QQ；ef2496a已于2026-11-11部署，[生产复核](qq-log-query-2026-11-10/diagnostic-deployment.json)10类查询及捕获代码核对通过，配置/权限/调度/独立服务和历史行保持。异常链/业务code/Cron原生诊断/账本矛盾与完整事件分页/稳定引用已覆盖，身份及只读范围保持；原因题仍12次请求，长期体验及自然开场稳定性未关闭。
  [六类真实主模型场景](qq-log-query-2026-11-10/live-scenarios.md)：隔离OpenClaw实际插件/QQ策略读取生产历史，55次真实模型请求；4项定向事实判定通过，开放式原因/投递判断各在14次预算内未完成。保留首次宿主未就绪与错误输出预算的验证环境失败；仅技术元数据，无生产写入或真实QQ外发。
