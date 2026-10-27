# 提醒列表一条消息多项（2026-10-27）

> **2026-10-27提醒列表归并导航：** 原提醒列表规则已完整并入[KnowledgeMap共享业务](../../23_KnowledgeMap业务能力桥接.md#提醒列表与定时汇总)。本页保留取证时的职责、结果与未覆盖范围；旧文档编号和分工只表示当时状态。

状态：**已验收**（领域回归、真实隔离HTTP、人格同步与运行核对通过；01:46本人QQ三项新增、查询、三项作废及后端只读核对一致，主人确认符合预期）。真人样本为每消息3项，8/9项边界仍以离线/隔离HTTP为据。规则见[文档19](../../23_KnowledgeMap业务能力桥接.md#提醒列表与定时汇总)与[文档23](../../23_KnowledgeMap业务能力桥接.md)，任务见[N21](../../待办清单.md#n21)。

版本与时间：2026-10-27（Asia/Shanghai），实现提交`5109951`（基线`57fb6c9`）；真人核对时主源码为`1966beb`，本任务生产代码和主人提示词相对实现提交未变。KnowledgeMap源码基线`31e3ce6`，只读核对并用于临时SQLite集成，不修改该仓库。实现检查时点见三个原JSON，源文件指纹见[runtime.json](runtime.json)，真人核对见[qq-acceptance-0146.json](qq-acceptance-0146.json)。

## 授权与接续范围

- 原会话中主人明确要求“按方案实施：上限 8 项，只改事项，标题按默认规则归一。先改规则文档，再改代码和测试，验证后提交。”本次按主人的接手要求继续完成该范围。
- 批准方案包含人格同步与服务加载核对。主源码已存在未提交的实现；本次审查、补测、同步主人AGENTS并本地提交，不扩大到账单、身份权限或其他业务改动。
- 实现阶段核对时服务已于01:18:34启动，晚于本轮三个生产源码文件的修改时刻；只读`tools.catalog`确认运行工具使用8项目标说明，`plugins.list`显示active。本次接手与验收没有另行重启，没有运行真人QQ/真实外发脚本、付费模型、备份恢复或远端写入。
- 实现提交时QQ图片修复、文档10、共享文档中的图片验收记录及`docs/kurimi.png`既有删除属于其他工作，未收录到`5109951`；混合文件仅暂存本任务对应内容。后续图片工作已由其他会话提交为`1966beb`，本次验收文档在独立工作树基于该提交补记，不处理受保护图片的既有删除。
- 01:46真人QQ测试由主人自行完成；主人随后报告“测试结果符合预期”，并要求按该时间检查后端。本次AI只读查询日志和业务GET接口，保存脱敏结论并本地提交；不重放生产写入，不复制截图或生产聊天原文。

## 起因

2026-10-26 约13:00，一条消息里录入多项时，后续事项被拦（"一条消息只能改一项"）。原因：同一消息的所有事项写入共用一个幂等键，后端对"同键不同参数"返回409。

## 改动

- 共享模式事项写入按“消息+目标”取键：`tasks:` + sha256(`sessionKey:messageId:slot`)。新增的 slot 为 `add:<归一标题>`（NFKC、去首尾空白、连续空白合一，保留大小写与标点）；维护已有项为 `item:<km ID>`。归一只用于目标键，保存字段仍取本次原文；归一标题相同但原始字段不同仍返回409。
- 不带 slot 时键与原公式相同，账单不变；播报时间/暂停/恢复仍一条消息一项；SQLite 旧模式描述仍为一条消息一项。
- 单消息最多8个不同 slot，第9个在发请求前拒绝；同一 slot 重试复用原键，不占额度。写入不是原子的，逐项报告，已成功项不回滚。
- 后端 `assistant_requests`（请求键+参数摘要）无需改动。`backend/app/assistant/router.py`将整个`TaskCommand.model_dump(mode="json")`传给`write_once`；`service.py`对操作域与该payload做规范JSON摘要，覆盖action、id、expected_version及fields，同键异参返回`idempotency_conflict`/409。

## 验证

实现阶段结果摘要：[tests.json](tests.json)、[checks.json](checks.json)、[runtime.json](runtime.json)。真人核对摘要：[qq-acceptance-0146.json](qq-acceptance-0146.json)。只保存统计、源码指纹、关联ID和合成验收项的必要字段，不复制生产聊天、凭据或其他业务项内容。

| 层次 | 命令 / 依据 | 结果与边界 |
| --- | --- | --- |
| 领域回归 | `node --test chatbot/tests/knowledgemap/*.test.mjs chatbot/tests/reminder-list/*.test.mjs`（实际显式列出的8个文件及TAP选项见tests.json） | **84/84通过**；不包含acceptance脚本。涵盖不同新增/已有目标、标题归一、第9个目标不POST、重试不计数、并行工具工厂共享上限、后续消息重置及旧工具失效；原账单/本地列表/播报回归通过 |
| 真实隔离HTTP | 上述`http.test.mjs`→KnowledgeMap `backend/tests/assistant_server.py` | 真实FastAPI与一次性SQLite：两项都可见、同参重放不增记录、同目标换字段/动作/版本均409、已成功项保留、8槽位上限及下一消息继续；后端提交后丢失响应再同键核对仅一条。未写生产MySQL或外发 |
| 文档归属回归 | `node --test scripts/fusion/test/documentation-map.test.mjs` | **9/9通过**，只使用临时仓库 |
| 人格投影 | `node scripts/fusion/sync-persona.mjs --diff`→`--apply` | 预览只发现`workspace/AGENTS.md`，实际仅同步此1份；其后12份受管文件一致，未复制记忆/历史/凭据 |
| 实际运行声明 | `tools.catalog({agentId:"main",includePlugins:true})`、`plugins.list` | 插件active；8项上限、同参重试、播报控制一条消息一项均可见；同步后主人提示词也有8项及账单一笔规则。未调用业务写工具 |
| 四项自检 | `health.mjs`、`verify-dependencies.mjs`、`sync-config.mjs`、`sync-persona.mjs` | **全通过**：Gateway/QQ正常、testIngress关闭、数据库快检正常、共享业务契约可用、配置/依赖/人格对齐；不代表真人QQ多项往返通过 |
| 证据检查 | `evidence-coverage.mjs`、`evidence-index.mjs --check-markdown` | 均通过；生成脚本表仍匹配198条 |
| 真人QQ与后端 | 主人01:46实际对话及反馈；`log-query.mjs`只读关联；业务API只读GET | 三项新增→查询六项→三项作废，7次API均200；逐项结果、ID/version、六个幂等键与后端状态一致，详见下节 |

补测过程保留：新加工具工厂用例最初两次均为83/84，通过项包含真实HTTP；失败分别因测试夹具遗漏临时`OPENCLAW_STATE_DIR`与固定runner的`backendRoot`。补齐夹具后单例通过，整组84/84；无需改动生产实现。两次失败摘要保留在tests.json，不计为业务验收失败或额外通过样本。

事项插件与HTTP客户端均为直接加载的ESM，本轮无TypeScript或构建产物变更，无需运行无关领域构建。实现检查完成时尚无真人QQ多项样本，当时保持待复验；01:46由主人补测并经下述核对后，N21改为已验收。本地提交仅收录本任务代码、规则、测试和证据；未推送远端，具体提交SHA由Git记录核对。

## 01:46真人QQ与后端只读核对

范围为2026-10-27 01:44–01:48（Asia/Shanghai）；统一日志入口是`scripts/fusion/log-query.mjs`。可只读查看业务调用元数据：

```sh
node scripts/fusion/log-query.mjs --from '2026-10-27 01:44' --to '2026-10-27 01:48' --source knowledgemap --kind business.api
```

AI通过该入口的`collectEvents`读取QQ、宿主工具、权限和KnowledgeMap事件，在内存核对参数/结果，只将白名单字段保存到[qq-acceptance-0146.json](qq-acceptance-0146.json)。后端使用配置中的固定客户端GET`/api/assistant/tasks`，关闭本次读取的trace写入；未调用POST、模型或QQ发送。

| 北京时间 | 实际行为 | 核对结果 |
| --- | --- | --- |
| 01:46:05 | 同一入站消息触发三次`add` | 多项验收甲=`km:33`、乙=`km:32`、丙=`km:34`；均active/version 1，DDL为空；3次HTTP 200 |
| 01:46:17 | `personal_reminder_list_get` | 有效列表6项，包含新增3项及原有3项；四时段播报仍启用 |
| 01:46:27 | 同一入站消息触发三次`void` | 三项均使用查询所得真实ID和expectedVersion 1，返回void/version 2；3次HTTP 200 |
| 核对时点见JSON | 后端历史与有效列表GET | 三项各保留一条历史，archived_at非空、completed_at与日期/时间仍为空；有效列表不再包含验收项，原有3项与01:46:17快照一致 |

六次写入使用六个不同幂等键，均按实际可信会话/消息ID和目标重新计算后匹配；无同消息第二项409。三个对话回合无工具错误、权限拒绝或中断，均有QQ出站记录；显示与回复符合预期由主人反馈确认。本次以真人三项闭环关闭N21，不把其他验收项一并关闭。

01:54收尾只读自检再次通过：运行源码目录的健康、依赖、配置与人格四项一致；独立工作树的证据归属、脚本索引和`git diff --check`通过。552份证据均有唯一归属，脚本表仍匹配198项；摘要见JSON的`finalChecks`。本次只补验收文档与脱敏证据，未改代码或归属规则，不重复运行此前84项领域与9项归属回归。

## 未覆盖

- 真人每消息8项/第9项、同目标重试和冲突未重新实测；这些边界由本轮离线/真实隔离HTTP用例覆盖。
- 不验证并发两条消息同时写同一事项的体验；版本冲突仍由后端 expected_version 决定。
- E4整天四时段、长期运行和停写恢复保持原待验范围；本次不外推到所有自然表达组合。
