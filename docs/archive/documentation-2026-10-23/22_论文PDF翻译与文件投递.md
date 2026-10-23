# 22_论文PDF翻译与文件投递：迁出的阶段记录

**历史记录，不作为当前操作与待办。** 原文来源：`c3f395330eeff40afdd060823ee6b02abd1de44d:docs/22_论文PDF翻译与文件投递.md`。2026-10-23 按文档职责迁出，仅调整相对链接；原有日期、结果与当时授权范围保留。

当前规则见[原归属文档](../../22_论文PDF翻译与文件投递.md)，本轮整理见[专项记录](../../verification/documentation-2026-10-23/README.md)。

---

## 原状态（2026-10-21）

状态：**非PDF附件入口修复与100秒空闲切换已部署；按论文名查找已离线实现、待复验（未重启生效）；新成员冷启动与渠道冷却优化待开发。** 现行默认与限制见下文，验收结论见[文档16](../../16_验收与测试总表.md#分领域验收摘要)。更新于 2026-10-21（Asia/Shanghai）。唯一阅读入口：[README.md](../../README.md)。

## 已完成迭代

| 已完成迭代 | 结果与证据边界 |
| --- | --- |
| 原始工具与样稿 | 受管PDF、固定CLI、QQ/邮件附件；本人确认QQ样稿及修复邮件正文/附件可读，见[原报告](../../verification/paper-translation-2026-10-17/README.md)及[observations](../../verification/paper-translation-2026-10-17/observations.json) |
| GPT三渠道与DeepSeek | 014/030/040短句、同厂商有界切换与官方Responses接入；DeepSeek low串行整篇通过（请求数、tokens和耗时见报告），修复结束回调后零新请求缓存生成。GPT串行失败保留，见[渠道报告](../../verification/paper-translation-2026-10-17/channel-upgrade/README.md)；协议初探单列[paper-api](../../verification/paper-api-2026-10-17/README.md) |
| 单篇四并发 | GPT/MAX复用旧缓存完整16页；DeepSeek首轮标记失败、一次显式缓存复验生成16页。无本轮外发，不是严格冷缓存A/B，见[四并发](../../verification/paper-translation-2026-10-17/concurrency-four/README.md) |
| 默认及双语契约 | 历史MAX两次生产失败与预算上调回执保留；现默认high、30分钟，dual选择贯通登记/发送。旧600秒是单请求总期限，不证明持续生成/无思考，见[MAX历史](../../verification/paper-translation-2026-10-17/deepseek-max-default/README.md)与[high/dual修复](../../verification/paper-translation-2026-10-17/high-dual-fix/README.md) |
| 批次恢复与整篇 | GPT/high冷译文缓存23页第4轮成功，19页首轮成功；耗时、请求数和tokens见报告。内部有界恢复、完整dual、抽样页图及本人QQ收件/“没有错位、翻译较准确”反馈通过，原三轮失败不改写，见[可靠性报告](../../verification/paper-translation-2026-10-17/batch-recovery/README.md) |
| 六并发对比 | 只做单篇隔离对比，不改变日常4并发/QPS1；有缓存/渠道波动与尾请求等待边界，见[六并发](../../verification/paper-translation-2026-10-17/concurrency-six/README.md) |
| 100秒有效正文空闲 | 独立于600秒请求总期限；只有非空白正文重置、先取消再有界切换；阶段回归及部署通过，真人QQ全流程待复验，见[空闲期限](../../verification/paper-translation-2026-10-17/output-idle-2026-10-19/README.md) |
| 附件入口 | 准确类型/状态与纯失败确定性分流，Node回归及真实隔离模型场景通过，23:48部署；翻译/OneBot模拟。原MD事件是旧稿误重发、无新翻译，见[调查](../../verification/paper-translation-2026-10-17/runtime-investigation-2026-10-19/README.md)与[修复](../../verification/paper-translation-2026-10-17/file-ingress-2026-10-19/README.md)。并行人格同步的初次非零回执保留，后续对齐归文档25 |
| 按论文名查找（待复验） | `kurumi_document` 的 `find` 只查本人受管 PDF 的文件名、记录题名和来源 URL，规范化多词匹配，全目录扫描、最多50条；`fetch` 可记录 `title`。同轮修正 `kurumi_document_send` 在 QQ 对外入口改造后漏改的调用。离线测试通过，未重启 Gateway、未做真人QQ复验 |
| 生命周期/下载 | 显式stop等待清理、不重放；下载/阅读分离、生产受控加载见[生命周期](../../verification/plugin-lifecycle-2026-10-19/README.md)及[结构整理](../../verification/capability-decoupling-2026-10-20/README.md) |

完整任务ID、产物hash、缓存来源、故障/修复与逐次回执由上述报告维护；各组有重叠，不累计成总通过数。样稿/抽样可读不代表全文逐字、逐公式校对或长期成功率保证。

## 逐轮离线结果

按名查找轮（2026-10-21，待复验）：新增 `lookup.test.mjs` 4项与隔离用例1项，Node 全量离线回归通过；未调用真实下载、模型或QQ。

附件修复轮Node相关回归（含附件专项）全部通过，数量见[本轮证据](../../verification/paper-translation-2026-10-17/file-ingress-2026-10-19/README.md)。涵盖论文、QQ、统一权限、邮件和统一查询；未改Python翻译器，未因附件修复重跑付费翻译。实现提交`5fe6f8a`在插件拆分后的基线`8937cae`上另做了独立离线复验，见[拆分后复验](../../verification/paper-translation-2026-10-17/file-ingress-2026-10-20/README.md)。前一轮Node、Responses、并发、安装引擎、可靠性各组的时点回执保留于[正文空闲超时](../../verification/paper-translation-2026-10-17/output-idle-2026-10-19/README.md)，不重复累计或冒称本轮重跑。离线通过不替代实际论文质量、真人入站或邮箱到信。

## 未覆盖、阻塞与收尾

- **B1 已验收（全文产物生成，2026-10-17）**：GPT/MAX完整16页由缓存续验生成；当前GPT/high另有独立冷译文缓存完整23页、19页各一次提交成功证据，耗时/用量见顶部。MAX冷缓存全文、长时间稳定性及全文人工语言/公式校对仍未覆盖；此前串行超时与未知用量回执保留。
- **B2 已验收（2026-10-17）**：本人确认修复邮件正文正常、PDF 以附件收到且可打开，第一页原文/译文排版正常；与此前QQ样稿收件相互独立，不扩大为全文质量验收。反馈摘要见[observations.json](../../verification/paper-translation-2026-10-17/observations.json)。
- 014/030/040 均通过一次真实短句请求；原整篇验收自然故障实测 014 → 030，本次生产任务也实际使用040并取得成功响应，见顶部记录。全部顺序/共享冷却/全失败由故障注入覆盖，未专门制造单批次030 → 040故障或耗尽/吊销 Key，不能把一次成功当长期可用保证。
- DeepSeek 官方 Flash/low 整篇已生成且抽查；当前high默认未做实际全文验收，旧MAX生产失败也保留，不能把默认调整视为输出8192不足已修复。V4 Pro 仅短句、none 未通过整篇标记校验。Grok 经主人决定不接入；不会在 GPT/DeepSeek 之间自动切换。
- naiccc 的显式 text.format JSON 模式曾 502，GPT 保留原数组提示词加本地校验；DeepSeek 官方结构化批次已做独立实测。上游输出硬预算和实际金额仍不可验证。
- 主人真实QQ上传原文件→模型→翻译→本人收到的完整新增链路、多人并发/群聊/登录受限论文、扫描OCR与GPU、长期高并发压力（本轮单次6已验证）、完整新增功能灾难恢复未覆盖。
- 恢复范围以[文档16](../../16_验收与测试总表.md#恢复点与证明范围)的分时配对/材料恢复记录为准；它们不等于新功能完整停写灾难恢复。新快照须独立安排，后台副本不自动随源码更新。回退联动源码/配置/私有状态，不能只退旧邮件代码继续发送新草稿。
