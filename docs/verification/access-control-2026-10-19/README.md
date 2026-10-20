# 统一身份与权限验收

对应[文档24](../../24_统一身份与权限管理.md)。日期：2026-10-19；源码基线 `9c88003` 加本任务工作区修改，尚未提交。本目录保存合成身份测试、用户授权成员的登记信息与脱敏运维结果，不保存私聊正文或凭据。

收尾归档：上句“尚未提交”记录的是2026-10-19验收时的状态。权限实现与专用测试随后分别本地提交为 `db5afec`、`427a4e9`，均未推送；本目录作为成员部署与隔离验收证据一并归档。`2752966052` 的真人往返仍待用户验收。

## 范围

- 离线：共享授权/配置、两身份数据归属、私聊路由、入站文件、任务撤权和目标绑定、授权日志统一查询，以及受影响领域的主人兼容回归。
- 隔离宿主：真实 OpenClaw、本地确定性模型与模拟 OneBot、注入翻译器；不调用外部模型/翻译 API，不向真实 QQ/群/邮箱外发，不写生产名单/数据库。
- 生产同步：首次部署仅保留既有主人；随后按用户授权增加 `3311723223`、`2752966052`，均仅聊天与自身论文。最后一次部署最初等待在途论文，用户追加要求停止现有任务后停服务、同步并启动；原任务不自动重跑，账本/原始PDF保留。未启用testIngress。
- 真人反馈：用户确认 `3311723223`“验收成功”，不扩大为跨身份攻击/负载/恢复验收；`2752966052` 真人往返仍待用户测试。个人业务多用户隔离、群聊和可视化权限编辑不在首期范围。

## 记录

| 证据 | 结果与边界 |
| --- | --- |
| [commit-review-2026-10-20.json](commit-review-2026-10-20.json) | 原提交审查基线 `542b6f9` 的权限漏检/测试夹具发现，以及固定 `2ba0308` 的定向补验：权限/桥接/账单37/37、后端边界23/23、账单撤权后零客户端请求；保留副本准备不足的失败，不代表全部新增提交已审查或生产端到端通过；规则说明见文档24第8节 |
| [node-tests.txt](node-tests.txt) | Node217/217；权限域17项，含严格配置/权限映射、可信身份/委托、双身份路由/目录/元数据、串行队列、越权与排队/执行中/投递前撤权、旧主人任务/幂等键兼容、授权日志，以及受影响QQ/邮件/记忆/共享业务/领域工具回归 |
| [weather-tests.txt](weather-tests.txt) | 天气/Profile/行程/提醒162/162；仅离线回归，不发实际提醒 |
| [confirmation-tests.txt](confirmation-tests.txt) | 确认入口15/15；不放宽owner scope，不创建实际业务提案 |
| [weather-build.txt](weather-build.txt) | personal-weather TypeScript构建通过，新共享权限导入有效 |
| [host.json](host.json) | 真实隔离OpenClaw宿主10/10，本地确定性模型及模拟OneBot/翻译器；实际内层强制授权、主人兼容、独立提示词/文件/任务、动态工具越权拒绝、成员/new及主人后台研究交接通过 |
| [host-initial.json](host-initial.json) | 增加后台回归后的首次失败；8项完成后研究worker未执行。Gateway保留可信channel/account/owner但省略senderId，修正固定委托判定后10/10；不是生产故障 |
| [matrix-check.txt](matrix-check.txt)、[sync-selftest.txt](sync-selftest.txt) | 单一权限来源校验通过，只有原主人；同步自检5/5 |
| [deploy-precheck.json](deploy-precheck.json) | 同步前无活动论文/未决投递，owner不变，testIngress=false；不复制私人业务内容 |
| [config-before.txt](config-before.txt)、[config-apply.txt](config-apply.txt)、[config-after.txt](config-after.txt) | 部署前仅缺channels.kurumi-qq.accessControl；2026-10-19 21:36 +08:00应用1项、删除0项，生成0600原配置备份；随后0漂移 |
| [persona.txt](persona.txt)、[dependencies.txt](dependencies.txt)、[health.json](health.json) | 人格4份一致、依赖自持、Fusion启用/健康、QQ在线、testIngress关闭、业务数据库完整；初次刚重启时Gateway尚未就绪，待启动完成后本报告所附检查通过 |
| [checks.json](checks.json) | 精确测试命令、最终计数、源码/配置状态与静态索引检查汇总；补充上面原始输出，不替代它们 |

首期离线总计394/394，宿主另外10/10。首次生产部署只同步已有主人的统一策略并重启Fusion；真实成员登记的增量结果如下，不覆盖此前部署回执。登记操作未主动向QQ、群或邮箱进行测试投递，也未启动真实翻译API任务；用户自行发起的真人测试与在途任务单列，不假装未发生。现有SnowLuma/DSH不改动。工作区包含并行开发修改，本轮不暂存、不提交、不推送。

## 成员登记增量

用户明确授权 `3311723223`，仅一般聊天与论文。revision=2，独立member，不共享主人会话/工作区/文档/任务；具体权限以唯一JSON来源及文档24为准。下列部署回执生成时尚未真人验收；用户随后在本轮直接反馈“验收成功”。原部署回执保留当时边界，不倒填为独立复盘过的测试结果。

| 证据 | 结果与边界 |
| --- | --- |
| [member-deployment.json](member-deployment.json) | 授权范围、部署前无活动任务、实际Agent/路由/独立工作区、27项owner-only权限拒绝与主人权限/Agent/人格哈希不变；含实际时间及收尾检查结果 |
| [member-node-tests.txt](member-node-tests.txt) | 本次重跑权限域17/17；本地回归，不是真人对话 |
| [member-persona-apply.txt](member-persona-apply.txt)、[member-config-apply.txt](member-config-apply.txt) | 先新增成员4份受管文件，再应用4项配置差异、删除0项；随后重启Fusion |
| [member-config-after.txt](member-config-after.txt)、[member-persona-after.txt](member-persona-after.txt) | 配置13个受管键0漂移，两个工作区共8份受管人格文件一致 |
| [member-dependencies.txt](member-dependencies.txt)、[member-health.json](member-health.json) | 依赖自持、Gateway健康、QQ频道连接、服务active/enabled、testIngress=false |

新增成员 `2752966052` 由用户授权相同权限，使用独立Agent/会话/工作区。配置登记时发现真实论文仍在运行，先校验并准备人格文件；随后用户明确要求停止现有任务、优先新增账号，于22:17 +08:00停止Fusion终止worker，再同步配置并启动，revision=3。原任务实际落账failed/pdf_worker_failed，作为人为停止结果记录，不推断为新的上游故障，不自动重放。原始PDF、任务及用量证据保留；本次未检查失败半成品的完整性。

| 证据 | 结果与边界 |
| --- | --- |
| [member-2752966052-deployment.json](member-2752966052-deployment.json) | 用户授权、`3311723223`验收反馈、等待及用户要求停任务的决定、既有两身份哈希不变、新成员独立路由/目录、27项主人专属权限拒绝及四项/静态检查结果 |
| [member-2752966052-node-tests.txt](member-2752966052-node-tests.txt) | 本次重跑权限域17/17，不含主动QQ/邮箱外发或付费翻译 |
| [member-2752966052-config-apply.txt](member-2752966052-config-apply.txt)、[member-2752966052-config-after.txt](member-2752966052-config-after.txt) | 新增成员应用4项配置差异、删除0项，随后13个受管键0漂移 |
| [member-2752966052-selfchecks.txt](member-2752966052-selfchecks.txt) | 人格12份一致、依赖自持检查原始输出 |
| [member-2752966052-health.json](member-2752966052-health.json) | 服务启动后的实际健康、Gateway及QQ频道连接、testIngress关闭；不代替真人新账号收件验收 |

## 当前未完成

1. **待验收：新增成员 `2752966052` 真人聊天与论文往返。** 已完成配置同步重载；`3311723223`已有用户验收成功反馈。模拟号码只存在测试和证据，不能加入生产。
2. **范围外：成员个人业务、邮件确认主体/草稿隔离、群聊、账户合并共享、GUI与QQ内权限编辑。** 首期配置校验器拒绝授予这些能力，不假装已支持。
3. **未验收：本次版本全量停写备份/恢复演练、真人并发/大规模负载及多机器人账户。** 已将权限来源纳入backup-state；未重打状态快照，旧恢复点只证明各自旧版本。
4. **撤权边界：** 操作流程为更新策略revision、同步并重启，不承诺现有进程即刻热更新；已经发生的上游计费/在途发送不可保证撤回。收回创建/管理权限不自动取消既有Cron，应按领域工具取消。

首次部署的静态收尾：390份证据文件均归类，175份脚本全索引、44份boundary声明一致；当时12份文档230个本地链接0断链，`git diff --check`通过，暂存区为空。两次成员登记后的检查分别见member-deployment.json与member-2752966052-deployment.json，不把旧时点计数当作本次结果。
