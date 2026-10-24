# 验证证据索引

本目录只存放测试输出、验收回执和复核报告，不定义运行规则。规则从[文档入口](../README.md)进入，判定见[文档16](../16_验收与测试总表.md)。本页按主题导航，文件/目录归属的唯一数据源为[documentation-map.json](../../scripts/fusion/documentation-map.json)。新增证据组同时登记两处；已登记目录中的文件继承归属。**脚本的归属、副作用与授权要求见[SCRIPTS.md](SCRIPTS.md)**。

## 当前有效证据

| 路径 | 用途 |
| --- | --- |
| [`SCRIPTS.md`](SCRIPTS.md) | 脚本与证据索引：每个脚本的用途、副作用、是否需授权、会写哪份证据，以及旧 harness 与当前融合验收的边界 |
| [`memory-research-2026-10-24/README.md`](memory-research-2026-10-24/README.md) 及同目录全部文件 | 记忆架构调研工作稿的资料/代码核对、文档检查和范围记录；不代表候选引擎接入或业务重新验收 |
| [`documentation-reorder-2026-10-23/README.md`](documentation-reorder-2026-10-23/README.md) 及同目录全部文件 | 按批准的14项方案重排；逐文件变更、相对既有整理稿的差异、链接/锚点/保留核对与只读自检，不改变业务验收 |
| [`documentation-2026-10-23/README.md`](documentation-2026-10-23/README.md) 及同目录全部文件 | 逐份文档分类、结构整理、过程归档、待办格式和链接/归属核对；不代表业务重新验收 |
| [`documentation-2026-10-21/README.md`](documentation-2026-10-21/README.md) 及同目录全部文件 | 文档归并、入口/锚点与脚本/证据归属核验；检查器9项隔离回归，不代表业务重新验收 |
| [`capability-decoupling-2026-10-20/README.md`](capability-decoupling-2026-10-20/README.md) 及同目录全部文件 | 文档21现行结构：受控加载、共享代码/论文下载边界、四个个人领域插件；533项回归、5组真实隔离Gateway、配置延期9项初始结果及allow成员检查补正后的10项结果、生产RPC与四项自检；文档26新检索API仅设计 |
| [`plugin-lifecycle-2026-10-19/README.md`](plugin-lifecycle-2026-10-19/README.md) 及同目录全部文件 | 文档21论文/邮件显式停止、共享确认注销归属的先失败后修复回归、真实宿主服务管理器隔离验证；原阶段不含生产重载，后续加载见结构整理专项 |
| [`persona-memory-2026-10-19/README.md`](persona-memory-2026-10-19/README.md) 及同目录全部文件 | 文档25 P1人格/关系分离及P2记忆连续性证据；[p2/](persona-memory-2026-10-19/p2/README.md)记录生命周期调查、连续性宿主、生产迁移/15库备份/19项材料恢复，以及工具契约补正的修前失败、离线/隔离/真实模型复验、定向热重载、收尾检查与22:41修复版真人QQ显式闭环（含一次自动修参）；各轮与未覆盖范围分别说明，持续情绪未实施 |
| [`access-control-2026-10-19/README.md`](access-control-2026-10-19/README.md) 及同目录全部文件 | 文档24统一身份/功能授权、两身份数据/后台撤权、真实隔离宿主、本地主人兼容、授权成员登记及配置部署自检；[提交审查补验](access-control-2026-10-19/commit-review-2026-10-20.json)区分原发现版本、修复提交和定向结果；用户真人验收反馈单列，不与模拟混同 |
| [`recovery-2026-10-10-final/README.md`](recovery-2026-10-10-final/README.md) | 此前停写恢复点（`2026-10-10-12-36-17-final-closeout`，quiesced，对应 `0f2255a2`，24/24）；不包含新增共享业务，最新配对资料见文档23 |
| `recovery-2026-10-10-final/*` | 上述报告的原始证据：`verification.json`、`isolation-result.json`、`gateway-probe.log`、备份 `EXPECTED.json` 与 `meta` |
| [`recovery-2026-10-10/README.md`](recovery-2026-10-10/README.md) | 上一恢复点（`584b3a0`，含 4547 字节补丁）与 25/25 验证，保留作为历史对照 |
| `recovery-2026-10-10/*` | 上述报告的原始证据：`verification.json`、`isolation-result.json`、`gateway-probe.log`、备份 `EXPECTED.json` 与 `meta` |
| [`recovery-2026-10-06/README.md`](recovery-2026-10-06/README.md) | 上一恢复点（`466b5074`）的恢复与隔离报告，保留作为历史对照 |
| `recovery-2026-10-06/*` | 上述报告引用的逐项 JSON、日志和测试输出 |
| [`2026-10-10_projects-fusion-sync.md`](2026-10-10_projects-fusion-sync.md) | 后台开发副本同步到主仓库 `dacfac4` 的前后状态、归档、沙箱检查复验与未覆盖范围（规则见[文档 10 的后台开发副本契约](../10_融合助手运行维护.md#后台开发副本契约)） |
| [`2026-10-11_projects-fusion-sync.md`](2026-10-11_projects-fusion-sync.md) | 后台开发副本同步到主仓库 `c039e3d`、冲突处理和最终工作区复核（规则见[文档 10 的后台开发副本契约](../10_融合助手运行维护.md#后台开发副本契约)） |
| `fusion/*` | 融合系统阶段验收和最终运行回执；以 recovery 报告和 16 为当前恢复结论 |
| [`deepseek-whale/README.md`](deepseek-whale/README.md) 及同目录全部文件 | 文档11归并后的迁移、模型/图片验收与历史边界；当前规则分别归配置契约、10、21、25 |
| [`mail-2026-10-16/README.md`](mail-2026-10-16/README.md) 及同目录全部文件 | 文档20文本邮件86项回归、真实SMTP/到信/QQ往返，时间戳接缝与误判更正；从原文迁入，整理时未重跑 |
| [`reminder-list-2026-10-11/README.md`](reminder-list-2026-10-11/README.md) 及同目录全部文件 | 提醒列表初版证据及 `natural-input/` 自然多轮录入、空 DDL、实际会话重置、原功能回归与部署复验；原生本人 QQ 投递仍单独引用初版记录 |
| [`backend-refactor-2026-10-16/README.md`](backend-refactor-2026-10-16/README.md) 及同目录全部文件 | 初轮职责分层；`structured-items/` 保存指代修复，`adapters/` 保存初次策略/存储替换、373 项回归与模型/隔离宿主证据；[`adapter-contracts/`](backend-refactor-2026-10-16/adapter-contracts/README.md) 保存同步返回/注销身份补正、最新 395 项回归、构建与运行自检 |
| [`paper-api-2026-10-17/README.md`](paper-api-2026-10-17/README.md) 及同目录全部文件 | 论文翻译第三方协议探查：014 凭据的 Responses/Chat、显式 instructions 输入开销、JSON/占位符和输出预算；不代表 pdf2zh 或文件投递已验收 |
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
