# 编码任务当前条件检查与旧任务兼容

日期：2026-10-30。源码起点：`9c9cf9f00c6fabcaf9e0c991dc9f29863aa1053a`。本记录仅证明列明的修复与验证范围；当前规则见[文档28](../../../28_本机编码工具委托与实验任务.md#当前条件检查与旧任务兼容)，整体状态见[文档16](../../../16_验收与测试总表.md)。

## 现象与决定

主人17:07左右的真实QQ查询能够列出旧任务，但查询差异和状态遇到`project_policy_changed`。只读核对确认：新增Python宿主检查改变了整体配置摘要，统一任务入口将只读查询也一起拒绝；工作树与产物仍在。身份链路允许该查询，未启动新的DSH任务。

对应私有证据在`/home/afrangry/.local/share/kurumi-coding-pilot-20261029/reviews/qq-20261030-1707-20261030T0910Z/`，以`analysis.json`、`manifest.json`关联原始回执；聊天原文和凭据不进入本仓库。

主人批准移除统一策略指纹，改为实际身份、目录、项目与工作树条件检查；合入时按当前检查复验，保留具体候选确认。本次不增加文件列表工具、不创建或继续生产任务、不扩大单目录权限、不外发QQ消息或push。既有结果修复证据不重写。

## 实现

- 删除指纹生成和比较，兼容保留旧任务字段。状态、结果和差异仍核对当前权限、原请求者/会话、允许目录及Git仓库归属。
- 续接按当前登记检查执行；新轮次不继承上轮当前检查或合入检查，历史结果仍可按轮次读取。
- 预览与合入分别运行当时登记的检查。合入复验独立记录为`mergeChecks`，不改写历史执行结果或已确认预览。
- 合入期间再次核对权限、任务状态、候选与目标，以及本次检查集合是否仍一致；失败在消费确认前返回。目标或候选变化仍须重新预览和确认。

## 验证与部署

| 层次 | 实际结果与证据 |
| --- | --- |
| 离线处理器与共享边界 | 工作树及整合后的源码目录最终均100项通过；[offline-final.log](offline-final.log)、[canonical-final-offline.log](canonical-final-offline.log)。覆盖旧字段兼容、读取/续接、额外检查、目录/仓库迁移、撤权、复验失败重试、目标分支改登与并发变化；真实Git/SQLite，ACP和投递为注入夹具 |
| 隔离宿主 | 真实独立Gateway的启用/禁用两阶段通过，服务锁正常释放、加载不建任务；[host-final.json](host-final.json)。不调用真实DSH或QQ |
| 单目录部署 | 仅更新源码并重启Fusion，编码插件active且有`kurumi_code`，配置/人格未放宽；四项运行自检通过。[最终部署](deployment-final.json)记录文件哈希与私有回执位置，其他并行需求文件已核对保留 |
| 真实旧任务只读核对 | `3bb84f40-beb1-4f2a-b33a-ccdc050781ed`仍为`ready`，原状态和差异可读，变更为`quicksort_first_pivot.py`。当前登记三项检查，历史执行检查仍是原两项；旧输出返回`result_not_recorded`。[最终只读回执](old-task-final-readonly.json)由直接服务调用与只读SQLite取得，任务事实与源Git状态均未改变 |
| 文档验证 | 文档归属覆盖、生成索引一致性、归属规则隔离测试与修改文档链接检查通过；[documentation.json](documentation.json) |

离线命令：`node --test chatbot/tests/coding/*.test.mjs chatbot/tests/access-control/*.test.mjs chatbot/tests/backend-boundaries/*.test.mjs`。隔离宿主命令：`node chatbot/tests/coding/acceptance-host.mjs --out <新的绝对路径>`。本轮没有付费模型请求、模拟生产入站或真实QQ外发，没有继续、取消、回档或合入生产任务。

首轮99项回归、宿主与部署回执保留为[offline.log](offline.log)、[canonical-offline.log](canonical-offline.log)、[host.json](host.json)、[deployment.json](deployment.json)与[old-task-readonly.json](old-task-readonly.json)。收尾审阅补充登记目标分支变化的显式检查与独立回归后，重新运行全套检查并部署；上述原回执不覆盖。

真人QQ端的修复后查询、收件及完整闭环仍须主人实际操作验收，不能由直接调用服务或测试夹具代替。本次不恢复缺失的历史stdout，也不新增任意文件读取或目录列表能力。
