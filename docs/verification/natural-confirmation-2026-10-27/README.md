# N4 自然语言二次确认

日期：2026-10-27。状态：待复验。规则归[文档21](../../21_后端职责分层与代码整理.md#确认契约与已知待办)，任务归[N4](../../待办清单.md#n4)，结论归[文档16](../../16_验收与测试总表.md)。

## 授权与范围

主人在本会话先要求仅分析无须抄码的可行性，随后明确批准列举的场景：“你列出的几个场景都是符合我预期的，可以，就这么做”。此次实施覆盖一次性提醒、Profile/行程与邮件的自然语言二次确认；原有提案/哈希、身份权限、有效期及一次性事务消费保留。提醒列表与账单原有明确唯一请求直接执行，不加入二次确认。

新增`personal_confirmation`窄工具及确认插件的`hooks.allowConversationAccess=true`，用于本人当前消息、实际宿主工具调用和会话结束钩子；不开放通用文件、命令、消息工具或成员业务权限。实现、普通配置同步与运行加载属于本次变更；没有真实QQ/SMTP外发、生产测试提案、业务账本清理、停写恢复或远端写入。

## 实现

工作树分支`codex/natural-confirmation-20261027`；基线`326eb95`，核心首次提交`d8b7366`、领域/宿主接线`e0e2d4e`，收紧`49973e7`、合并`f60f632`、部署`fa0eeba`；精确范围由本目录文件哈希和Git历史定位。与并行论文任务的改动在主线合并时保留，不覆盖其模型与失败提示。

- 核心新增持久预览与自然grant标记，所有后端查询成功后按真实ID/hash/domain唯一选择；历史Profile/行程共库按domain收窄。
- 只有可信QQ发送全载荷成功回执才标记展示；模型改写由最终回复钩子替换为冻结预览。分段中途失败、仅捕获回复、同消息新建/重展示均不能授权。
- 提案预览只接受实际领域工具结果；通用`tool_call`包装必须对应可信before-tool记录的工具名，不接受网页/任意工具文本伪造嵌套提案。
- 原文来自可信入站，实际run/session/toolCall来自宿主钩子。模型选择目标，窄工具签发grant，领域事务消费。新消息、回合结束、重置、重启撤销未消费自然授权；最多5分钟且不越过提案截止。
- 多项可并存；裸确认绑定最新唯一预览或可信引用目标。明确指代可选择其中一项；同一条消息不能授权第二项。语义理解仍由模型负责。
- 邮件预览含收件人、抄送、主题、完整正文及附件摘要；取消草稿同步取消提案，消费和提案提交在同一事务，先消费再SMTP。投递失败不复用授权。
- 旧带码入口兼容；新预览不要求抄码。旧提案没有展示关联时不能直接自然确认，需重新提案/展示。增加两张表，不删除或重建旧数据。

## 验证

各命令有重叠，不相加为全项目测试总数。全部为临时状态或只读源码验证；构建生成忽略的dist产物。

| 命令 | 结果 | 范围 |
| --- | --- | --- |
| `npm --prefix chatbot/packages/confirmation-core run build` / `test` | 构建通过，46项通过 | 提案/授权、回执、裸确认/引用/歧义、失效、重复/跨域、旧协议 |
| `npm --prefix chatbot/plugins/personal-confirmation run build` / `test` | 构建通过，24项通过 | 当前原文/实际宿主调用绑定、生命周期、嵌套结果、冻结回复和旧入口 |
| `node chatbot/scripts/build-personal-plugins.mjs`；`npm --prefix chatbot/packages/personal-domains test` | 构建通过，162项通过 | 四领域及原确认/Cron回归 |
| `node --test chatbot/plugins/kurumi-mail/test/*.test.js chatbot/plugins/kurumi-qq/test/*.test.js chatbot/tests/access-control/*.test.mjs` | 原组合125项通过；新增回执文件另3项通过 | 领域事务、模拟SMTP、身份/动作权限与频道传输 |
| `node --test chatbot/plugins/kurumi-qq/test/confirmation-receipts.test.js` | 3项通过 | 真实loopback HTTP全量回执、部分失败、捕获无回执；不生成grant |
| `node --test chatbot/tests/backend-boundaries/*.test.mjs chatbot/tests/domain-adapters/*.test.mjs chatbot/tests/persona/*.test.mjs` | 107项通过 | 真实领域Store自然确认/提交5项，边界/生命周期/适配器/人格回归 |
| `node chatbot/tests/backend-boundaries/acceptance-natural-confirmation-host.mjs --out <新的绝对路径>` | 真实隔离宿主7场景通过，31次本地模型请求 | [host.json](host.json)：真实Gateway、typed hooks、deferred tools、SQLite、Cron与模拟QQ HTTP发送回执 |

真实宿主的首次检查发现`allowConversationAccess`未声明，以及授权提示钩子只保留`prependContext/appendContext`，已补正配置及返回字段后复验。夹具的runner路径、结果解包也已修正；这些修前失败未写成业务成功。核心/插件回归曾因旧确认措辞和表名单断言失败，按新契约更新后重跑通过。

## 证明边界与下一步

隔离宿主使用确定性模拟模型，证明真实钩子、工具、存储与回执接通，不能证明真实聊天模型始终正确理解指代。本人QQ、真实模型自然意图、实际提醒到点投递和本次邮件到信均尚未验收。后端的来源、哈希和展示检查不能证明任意自然语言语义永远正确。

真人建议先用未来的一次性提醒：单项后裸“确认”；同时两项后裸“确认”应追问，明确“确认其中某一项”只提交该项；“先别执行”和“确认，不过改成另一时间”不提交旧提案。AI按时间只读关联实际工具、grant、提交与QQ回执。邮件需另行明确外发范围。

`fa0eeba`已于03:04:38同步并重启Fusion；配置2处、主人AGENTS 1份更新，12份受管人格文件对齐。四项自检、6个相关生产插件active及确认工具目录通过，testIngress保持关闭、成员工具和通用禁用项未放宽。精确结果在[deployment.json](deployment.json)。合并后人格回归47项、文档归属9项通过；证据全归属，脚本索引205项一致。待主人QQ复验后沿用N4更新，不提前勾选。
