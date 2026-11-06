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
| [commit-review-2026-10-20.json（历史材料）](README.md#historical-material) | 原提交审查基线 `542b6f9` 的权限漏检/测试夹具发现，以及固定 `2ba0308` 的定向补验：权限/桥接/账单37/37、后端边界23/23、账单撤权后零客户端请求；保留副本准备不足的失败，不代表全部新增提交已审查或生产端到端通过；规则说明见文档24第8节 |
| [node-tests.txt（历史材料）](README.md#historical-material) | Node217/217；权限域17项，含严格配置/权限映射、可信身份/委托、双身份路由/目录/元数据、串行队列、越权与排队/执行中/投递前撤权、旧主人任务/幂等键兼容、授权日志，以及受影响QQ/邮件/记忆/共享业务/领域工具回归 |
| [weather-tests.txt（历史材料）](README.md#historical-material) | 天气/Profile/行程/提醒162/162；仅离线回归，不发实际提醒 |
| [confirmation-tests.txt（历史材料）](README.md#historical-material) | 确认入口15/15；不放宽owner scope，不创建实际业务提案 |
| [weather-build.txt（历史材料）](README.md#historical-material) | personal-weather TypeScript构建通过，新共享权限导入有效 |
| [host.json（历史材料）](README.md#historical-material) | 真实隔离OpenClaw宿主10/10，本地确定性模型及模拟OneBot/翻译器；实际内层强制授权、主人兼容、独立提示词/文件/任务、动态工具越权拒绝、成员/new及主人后台研究交接通过 |
| [host-initial.json（历史材料）](README.md#historical-material) | 增加后台回归后的首次失败；8项完成后研究worker未执行。Gateway保留可信channel/account/owner但省略senderId，修正固定委托判定后10/10；不是生产故障 |
| [matrix-check.txt（历史材料）](README.md#historical-material)、[sync-selftest.txt（历史材料）](README.md#historical-material) | 单一权限来源校验通过，只有原主人；同步自检5/5 |
| [deploy-precheck.json（历史材料）](README.md#historical-material) | 同步前无活动论文/未决投递，owner不变，testIngress=false；不复制私人业务内容 |
| [config-before.txt（历史材料）](README.md#historical-material)、[config-apply.txt（历史材料）](README.md#historical-material)、[config-after.txt（历史材料）](README.md#historical-material) | 部署前仅缺channels.kurumi-qq.accessControl；2026-10-19 21:36 +08:00应用1项、删除0项，生成0600原配置备份；随后0漂移 |
| [persona.txt（历史材料）](README.md#historical-material)、[dependencies.txt（历史材料）](README.md#historical-material)、[health.json（历史材料）](README.md#historical-material) | 人格4份一致、依赖自持、Fusion启用/健康、QQ在线、testIngress关闭、业务数据库完整；初次刚重启时Gateway尚未就绪，待启动完成后本报告所附检查通过 |
| [checks.json（历史材料）](README.md#historical-material) | 精确测试命令、最终计数、源码/配置状态与静态索引检查汇总；补充上面原始输出，不替代它们 |

首期离线总计394/394，宿主另外10/10。首次生产部署只同步已有主人的统一策略并重启Fusion；真实成员登记的增量结果如下，不覆盖此前部署回执。登记操作未主动向QQ、群或邮箱进行测试投递，也未启动真实翻译API任务；用户自行发起的真人测试与在途任务单列，不假装未发生。现有SnowLuma/DSH不改动。工作区包含并行开发修改，本轮不暂存、不提交、不推送。

## 成员登记增量

用户明确授权 `3311723223`，仅一般聊天与论文。revision=2，独立member，不共享主人会话/工作区/文档/任务；具体权限以唯一JSON来源及文档24为准。下列部署回执生成时尚未真人验收；用户随后在本轮直接反馈“验收成功”。原部署回执保留当时边界，不倒填为独立复盘过的测试结果。

| 证据 | 结果与边界 |
| --- | --- |
| [member-deployment.json（历史材料）](README.md#historical-material) | 授权范围、部署前无活动任务、实际Agent/路由/独立工作区、27项owner-only权限拒绝与主人权限/Agent/人格哈希不变；含实际时间及收尾检查结果 |
| [member-node-tests.txt（历史材料）](README.md#historical-material) | 本次重跑权限域17/17；本地回归，不是真人对话 |
| [member-persona-apply.txt（历史材料）](README.md#historical-material)、[member-config-apply.txt（历史材料）](README.md#historical-material) | 先新增成员4份受管文件，再应用4项配置差异、删除0项；随后重启Fusion |
| [member-config-after.txt（历史材料）](README.md#historical-material)、[member-persona-after.txt（历史材料）](README.md#historical-material) | 配置13个受管键0漂移，两个工作区共8份受管人格文件一致 |
| [member-dependencies.txt（历史材料）](README.md#historical-material)、[member-health.json（历史材料）](README.md#historical-material) | 依赖自持、Gateway健康、QQ频道连接、服务active/enabled、testIngress=false |

新增成员 `2752966052` 由用户授权相同权限，使用独立Agent/会话/工作区。配置登记时发现真实论文仍在运行，先校验并准备人格文件；随后用户明确要求停止现有任务、优先新增账号，于22:17 +08:00停止Fusion终止worker，再同步配置并启动，revision=3。原任务实际落账failed/pdf_worker_failed，作为人为停止结果记录，不推断为新的上游故障，不自动重放。原始PDF、任务及用量证据保留；本次未检查失败半成品的完整性。

| 证据 | 结果与边界 |
| --- | --- |
| [member-2752966052-deployment.json（历史材料）](README.md#historical-material) | 用户授权、`3311723223`验收反馈、等待及用户要求停任务的决定、既有两身份哈希不变、新成员独立路由/目录、27项主人专属权限拒绝及四项/静态检查结果 |
| [member-2752966052-node-tests.txt（历史材料）](README.md#historical-material) | 本次重跑权限域17/17，不含主动QQ/邮箱外发或付费翻译 |
| [member-2752966052-config-apply.txt（历史材料）](README.md#historical-material)、[member-2752966052-config-after.txt（历史材料）](README.md#historical-material) | 新增成员应用4项配置差异、删除0项，随后13个受管键0漂移 |
| [member-2752966052-selfchecks.txt（历史材料）](README.md#historical-material) | 人格12份一致、依赖自持检查原始输出 |
| [member-2752966052-health.json（历史材料）](README.md#historical-material) | 服务启动后的实际健康、Gateway及QQ频道连接、testIngress关闭；不代替真人新账号收件验收 |

## 当前未完成

1. **待验收：新增成员 `2752966052` 真人聊天与论文往返。** 已完成配置同步重载；`3311723223`已有用户验收成功反馈。模拟号码只存在测试和证据，不能加入生产。
2. **范围外：成员个人业务、邮件确认主体/草稿隔离、群聊、账户合并共享、GUI与QQ内权限编辑。** 首期配置校验器拒绝授予这些能力，不假装已支持。
3. **未验收：本次版本全量停写备份/恢复演练、真人并发/大规模负载及多机器人账户。** 已将权限来源纳入backup-state；未重打状态快照，旧恢复点只证明各自旧版本。
4. **撤权边界：** 操作流程为更新策略revision、同步并重启，不承诺现有进程即刻热更新；已经发生的上游计费/在途发送不可保证撤回。收回创建/管理权限不自动取消既有Cron，应按领域工具取消。

首次部署的静态收尾：390份证据文件均归类，175份脚本全索引、44份boundary声明一致；当时12份文档230个本地链接0断链，`git diff --check`通过，暂存区为空。两次成员登记后的检查分别见member-deployment.json与member-2752966052-deployment.json，不把旧时点计数当作本次结果。

<a id="historical-material"></a>

## 历史原始材料的保留位置

本目录生成的原始回执、日志和图片已退出活动树；既有结论及失败状态不因此改变，也不代表新版已验收。已入Git的内容可用 `git show c849e63:<原仓库相对路径>` 读取；表中的blob标识可核对原始字节。未入Git的临时输出按本次清理授权丢弃。当前执行状态只在全局《整理记录.md》维护。

| 原文件 | 原报告顶层字段（仅摘录） | Git blob |
| --- | --- | --- |
| `checks.json` | at=2026-10-19T13:40:18.655239+00:00 | `ff38852a5c57682e5cbb06c8a22a186f63d13103` |
| `commit-review-2026-10-20.json` | 未提取；以原材料及现有结论为准 | `d1913b2ac448604822802a28ecc7113a20821370` |
| `config-after.txt` | 未提取；以原材料及现有结论为准 | `eada40e092dd018889c932dd1f59879d51a09754` |
| `config-apply.txt` | 未提取；以原材料及现有结论为准 | `6908e3896272620cc53a785f843d42a707d2c7b7` |
| `config-before.txt` | 未提取；以原材料及现有结论为准 | `6de42606b9496459ec1d32f2cac9f64dbe025f22` |
| `confirmation-tests.txt` | 未提取；以原材料及现有结论为准 | `bf33fdaf04c28b80052e5ead634362b656ba0870` |
| `dependencies.txt` | 未提取；以原材料及现有结论为准 | `b39597afebc94c642d0b90a449359c7df6c20054` |
| `deploy-precheck.json` | at=2026-10-19T13:36:11.004200+00:00 | `470b2ea7db40dc381fc504a2bed3df4174bba02d` |
| `health.json` | ok=True；at=2026-10-19T13:36:55.416Z | `298a483948733a30abc350083658403272de8295` |
| `host-initial.json` | passed=False；at=2026-10-19T13:27:19.883Z | `38f323c5a640aeb8f0b915010bd9359c05b0530e` |
| `host.json` | passed=True；at=2026-10-19T13:29:51.199Z | `5b034a538e59254e9a320e6bdcd20c3824a8e400` |
| `matrix-check.txt` | 未提取；以原材料及现有结论为准 | `1929bf0fc701261b6c5f8100491d17aa91a10a1d` |
| `member-2752966052-config-after.txt` | 未提取；以原材料及现有结论为准 | `f213f317a97141af0a82ec853632b0f9b6ca0d7f` |
| `member-2752966052-config-apply.txt` | 未提取；以原材料及现有结论为准 | `31b84a05209061e7fd7da7f7d562bf78f29ad97a` |
| `member-2752966052-deployment.json` | status=deployed_pending_user_end_to_end_acceptance | `b4cd38966c34cc9d66173256b8c0c7420ca1d63d` |
| `member-2752966052-health.json` | ok=True；at=2026-10-19T14:17:59.952Z | `40d5c6d2e2fc24999eb386bfe8e9df670b5f3da9` |
| `member-2752966052-node-tests.txt` | 未提取；以原材料及现有结论为准 | `a22377b565f7bf7158ba6e04676ef79ae5ce13f2` |
| `member-2752966052-selfchecks.txt` | 未提取；以原材料及现有结论为准 | `786b5e9f0985102ea5de7e83902e8adb4d319742` |
| `member-config-after.txt` | 未提取；以原材料及现有结论为准 | `f213f317a97141af0a82ec853632b0f9b6ca0d7f` |
| `member-config-apply.txt` | 未提取；以原材料及现有结论为准 | `9ebbd060f29ac3ee8d375e939385f3b54eac03fa` |
| `member-dependencies.txt` | 未提取；以原材料及现有结论为准 | `b39597afebc94c642d0b90a449359c7df6c20054` |
| `member-deployment.json` | 未提取；以原材料及现有结论为准 | `9cb01db268215db49af2b011c6e5012ea88026ca` |
| `member-health.json` | ok=True；at=2026-10-19T13:54:11.605Z | `a41289ee8a63832d3b4ac464c61d5cb2ccfb67c2` |
| `member-node-tests.txt` | 未提取；以原材料及现有结论为准 | `e5147014c4e38ef3714cf2595d7ec9c887335bcc` |
| `member-persona-after.txt` | 未提取；以原材料及现有结论为准 | `17723627ff3dc4a5e19a21d4a23bb4a7dcb2f2fc` |
| `member-persona-apply.txt` | 未提取；以原材料及现有结论为准 | `1ea7661b5c72c4d048ce2e8d3de3da9ba30b6c7a` |
| `node-tests.txt` | 未提取；以原材料及现有结论为准 | `dcfcd6d7b86867682f1084c192a582282e45083d` |
| `persona.txt` | 未提取；以原材料及现有结论为准 | `60f644b6d0c52317a22a3d538d21f5277e1b1a06` |
| `sync-selftest.txt` | 未提取；以原材料及现有结论为准 | `9eeaefef6e2a2cd0a231946ee180fee84fd3569c` |
| `weather-build.txt` | 未提取；以原材料及现有结论为准 | `303d41177cb4a73f6a8431d92b76c879a7437f7f` |
| `weather-tests.txt` | 未提取；以原材料及现有结论为准 | `f606e8fceb0431b6dc2fc6f1d35fc88b7f742c6d` |
