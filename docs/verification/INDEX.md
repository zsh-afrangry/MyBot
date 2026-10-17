# 验证证据索引

本目录只存放测试输出、验收回执和复核报告，不定义运行规则。运行规则见 [`../README.md`](../README.md) 和 [`../16_验收与测试总表.md`](../16_验收与测试总表.md)。每个文件都归入下面一个目录或文件组；新增证据必须同时更新本索引。**脚本清单、副作用与授权要求见 [SCRIPTS.md](SCRIPTS.md)**，那里的覆盖检查是可执行的。

## 当前有效证据

| 路径 | 用途 |
| --- | --- |
| [`SCRIPTS.md`](SCRIPTS.md) | 脚本与证据索引：每个脚本的用途、副作用、是否需授权、会写哪份证据，以及旧 harness 与当前融合验收的边界 |
| [`recovery-2026-10-10-final/README.md`](recovery-2026-10-10-final/README.md) | 此前停写恢复点（`2026-10-10-12-36-17-final-closeout`，quiesced，对应 `0f2255a2`，24/24）；不包含新增共享业务，最新配对资料见文档23 |
| `recovery-2026-10-10-final/*` | 上述报告的原始证据：`verification.json`、`isolation-result.json`、`gateway-probe.log`、备份 `EXPECTED.json` 与 `meta` |
| [`recovery-2026-10-10/README.md`](recovery-2026-10-10/README.md) | 上一恢复点（`584b3a0`，含 4547 字节补丁）与 25/25 验证，保留作为历史对照 |
| `recovery-2026-10-10/*` | 上述报告的原始证据：`verification.json`、`isolation-result.json`、`gateway-probe.log`、备份 `EXPECTED.json` 与 `meta` |
| [`recovery-2026-10-06/README.md`](recovery-2026-10-06/README.md) | 上一恢复点（`466b5074`）的恢复与隔离报告，保留作为历史对照 |
| `recovery-2026-10-06/*` | 上述报告引用的逐项 JSON、日志和测试输出 |
| [`2026-10-10_projects-fusion-sync.md`](2026-10-10_projects-fusion-sync.md) | 后台开发副本同步到主仓库 `dacfac4` 的前后状态、归档、沙箱检查复验与未覆盖范围（规则见[文档 10 的后台开发副本契约](../10_融合助手运行维护.md#后台开发副本契约)） |
| [`2026-10-11_projects-fusion-sync.md`](2026-10-11_projects-fusion-sync.md) | 后台开发副本同步到主仓库 `c039e3d`、冲突处理和最终工作区复核（规则见[文档 10 的后台开发副本契约](../10_融合助手运行维护.md#后台开发副本契约)） |
| `fusion/*` | 融合系统阶段验收和最终运行回执；以 recovery 报告和 16 为当前恢复结论 |
| `deepseek-whale/*` | DeepSeek、角色卡和图片链路验收 |
| [`reminder-list-2026-10-11/README.md`](reminder-list-2026-10-11/README.md) 及同目录全部文件 | 提醒列表初版证据及 `natural-input/` 自然多轮录入、空 DDL、实际会话重置、原功能回归与部署复验；原生本人 QQ 投递仍单独引用初版记录 |
| [`backend-refactor-2026-10-16/README.md`](backend-refactor-2026-10-16/README.md) 及同目录全部文件 | 初轮职责分层；`structured-items/` 保存指代修复，`adapters/` 保存初次策略/存储替换、373 项回归与模型/隔离宿主证据；[`adapter-contracts/`](backend-refactor-2026-10-16/adapter-contracts/README.md) 保存同步返回/注销身份补正、最新 395 项回归、构建与运行自检 |
| [`paper-api-2026-10-17/README.md`](paper-api-2026-10-17/README.md) 及同目录全部文件 | 论文翻译第三方协议探查：014 凭据的 Responses/Chat、显式 instructions 输入开销、JSON/占位符和输出预算；不代表 pdf2zh 或文件投递已验收 |
| [`paper-translation-2026-10-17/README.md`](paper-translation-2026-10-17/README.md) 及同目录全部文件 | 文档22的实现、回归、下载/编排与翻译/投递；[channel-upgrade](paper-translation-2026-10-17/channel-upgrade/README.md)收录三渠道/DeepSeek整篇、最终部署与质量抽查；各回执注明边界与失败项 |
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

本清单按用途覆盖顶层文件与各子目录；实际文件数量以覆盖脚本输出为准。带有 `*` 的条目表示该目录下的全部文件，不能据此推断任何文件未归类。**本页的分类已由可执行检查取代人工声明**：

```bash
cd /home/afrangry/kurumi-fusion
node scripts/fusion/evidence-coverage.mjs   # 每个文件必须命中恰好一个分类，未分类即非零退出
node scripts/fusion/evidence-index.mjs      # 每个脚本必须有分类行，缺行即非零退出
```

新增或移动任意文件都必须同步更新本索引与分类规则，否则上面两条命令会失败。文件名中的
`initial`、`attempt`、`fixed` 表示历史过程，不代表当前缺陷仍存在；过程文件保留是为了审计，不应再复制到当前规则文档。
