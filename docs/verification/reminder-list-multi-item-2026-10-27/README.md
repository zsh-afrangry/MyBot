# 提醒列表一条消息多项（2026-10-27）

状态：**待复验**（领域回归、真实隔离HTTP、人格同步与运行核对已通过；真人QQ一条多项往返未做）。规则见[文档19](../../19_提醒列表与定时汇总.md)与[文档23](../../23_KnowledgeMap业务能力桥接.md)，任务见[N21](../../待办清单.md#n21)。

版本与时间：2026-10-27（Asia/Shanghai），Fusion基线`57fb6c9`及本轮补丁；KnowledgeMap源码基线`31e3ce6`，只读核对并用于临时SQLite集成，不修改该仓库。各检查时点见三个JSON结果，源文件指纹见[runtime.json](runtime.json)。

## 授权与接续范围

- 原会话中主人明确要求“按方案实施：上限 8 项，只改事项，标题按默认规则归一。先改规则文档，再改代码和测试，验证后提交。”本次按主人的接手要求继续完成该范围。
- 批准方案包含人格同步与服务加载核对。主源码已存在未提交的实现；本次审查、补测、同步主人AGENTS并本地提交，不扩大到账单、身份权限或其他业务改动。
- 当前服务此前已于01:18:34启动，晚于本轮三个生产源码文件的修改时刻；只读`tools.catalog`已确认运行工具使用8项目标说明，`plugins.list`显示active。本次没有另行重启，没有运行真人QQ/真实外发脚本、付费模型、备份恢复或远端写入。
- QQ图片修复、文档10、共享文档中的图片验收记录及`docs/kurimi.png`既有删除属于其他工作，保留在未提交状态；混合文件仅暂存本任务对应内容。

## 起因

2026-10-26 约13:00，一条消息里录入多项时，后续事项被拦（"一条消息只能改一项"）。原因：同一消息的所有事项写入共用一个幂等键，后端对"同键不同参数"返回409。

## 改动

- 共享模式事项写入按“消息+目标”取键：`tasks:` + sha256(`sessionKey:messageId:slot`)。新增的 slot 为 `add:<归一标题>`（NFKC、去首尾空白、连续空白合一，保留大小写与标点）；维护已有项为 `item:<km ID>`。归一只用于目标键，保存字段仍取本次原文；归一标题相同但原始字段不同仍返回409。
- 不带 slot 时键与原公式相同，账单不变；播报时间/暂停/恢复仍一条消息一项；SQLite 旧模式描述仍为一条消息一项。
- 单消息最多8个不同 slot，第9个在发请求前拒绝；同一 slot 重试复用原键，不占额度。写入不是原子的，逐项报告，已成功项不回滚。
- 后端 `assistant_requests`（请求键+参数摘要）无需改动。`backend/app/assistant/router.py`将整个`TaskCommand.model_dump(mode="json")`传给`write_once`；`service.py`对操作域与该payload做规范JSON摘要，覆盖action、id、expected_version及fields，同键异参返回`idempotency_conflict`/409。

## 验证

原始结果摘要：[tests.json](tests.json)、[checks.json](checks.json)、[runtime.json](runtime.json)。只保存统计、源码指纹与规则核对，不复制生产聊天、凭据或业务数据。

| 层次 | 命令 / 依据 | 结果与边界 |
| --- | --- | --- |
| 领域回归 | `node --test chatbot/tests/knowledgemap/*.test.mjs chatbot/tests/reminder-list/*.test.mjs`（实际显式列出的8个文件及TAP选项见tests.json） | **84/84通过**；不包含acceptance脚本。涵盖不同新增/已有目标、标题归一、第9个目标不POST、重试不计数、并行工具工厂共享上限、后续消息重置及旧工具失效；原账单/本地列表/播报回归通过 |
| 真实隔离HTTP | 上述`http.test.mjs`→KnowledgeMap `backend/tests/assistant_server.py` | 真实FastAPI与一次性SQLite：两项都可见、同参重放不增记录、同目标换字段/动作/版本均409、已成功项保留、8槽位上限及下一消息继续；后端提交后丢失响应再同键核对仅一条。未写生产MySQL或外发 |
| 文档归属回归 | `node --test scripts/fusion/test/documentation-map.test.mjs` | **9/9通过**，只使用临时仓库 |
| 人格投影 | `node scripts/fusion/sync-persona.mjs --diff`→`--apply` | 预览只发现`workspace/AGENTS.md`，实际仅同步此1份；其后12份受管文件一致，未复制记忆/历史/凭据 |
| 实际运行声明 | `tools.catalog({agentId:"main",includePlugins:true})`、`plugins.list` | 插件active；8项上限、同参重试、播报控制一条消息一项均可见；同步后主人提示词也有8项及账单一笔规则。未调用业务写工具 |
| 四项自检 | `health.mjs`、`verify-dependencies.mjs`、`sync-config.mjs`、`sync-persona.mjs` | **全通过**：Gateway/QQ正常、testIngress关闭、数据库快检正常、共享业务契约可用、配置/依赖/人格对齐；不代表真人QQ多项往返通过 |
| 证据检查 | `evidence-coverage.mjs`、`evidence-index.mjs --check-markdown` | 均通过；生成脚本表仍匹配198条 |

补测过程保留：新加工具工厂用例最初两次均为83/84，通过项包含真实HTTP；失败分别因测试夹具遗漏临时`OPENCLAW_STATE_DIR`与固定runner的`backendRoot`。补齐夹具后单例通过，整组84/84；无需改动生产实现。两次失败摘要保留在tests.json，不计为业务验收失败或额外通过样本。

事项插件与HTTP客户端均为直接加载的ESM，本轮无TypeScript或构建产物变更，无需运行无关领域构建。没有真实模型/QQ多项样本，不标记“已验收”。本地提交仅收录本任务代码、规则、测试和证据；未推送远端，具体提交SHA由Git记录核对。

## 未覆盖

- 真人QQ一条多项往返：模型是否逐项调用、是否逐项说明结果，未验证。
- 不验证并发两条消息同时写同一事项的体验；版本冲突仍由后端 expected_version 决定。
