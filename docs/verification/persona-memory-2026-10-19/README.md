# 文档25 · P1人格与关系分离验收

需求、架构、决定与未完成项见[文档25](../../25_人格、记忆与会话连续性.md)。P1已于2026-10-19部署，20日完成记录收尾；自动化验收通过，真人QQ体感待复验。P2生产记忆迁移与恢复证据单列在[p2/README.md](p2/README.md)。

P2的宿主调查与后续证据单独放在 [p2/README.md](p2/README.md)，不能并入P1通过计数。

| 文件 | 范围与当前状态 |
| --- | --- |
| [node-tests.txt](node-tests.txt) | 人格投影、权限、资源隔离及日志查询离线回归 **42/42** |
| [host-fixture.json](host-fixture.json) | 首次夹具在模型调用前退出：临时配置缺少SDK要求的ownership/systemAgent。0模型请求，不是生产故障；失败回执保留 |
| [host-fixture-fixed.json](host-fixture-fixed.json) | 修正夹具后，真实隔离OpenClaw、确定性模型、模拟OneBot **8/8**。真正发往模型的共享全文、关系、本人私密记忆隔离、`/new`及同一会话SOUL刷新通过；无真实API或QQ外发 |
| [host-live.json](host-live.json) | 同一隔离入口、真实官方DeepSeek、模拟OneBot **8/8**。8请求，上游报告53121输入/326输出tokens；无真实QQ/邮件、业务写入或生产状态写入 |
| [deployment.json](deployment.json) | 无在途论文/投递时同步3身份12份文件，本次改6份SOUL/USER；58份私密文件和6份保护文件哈希未变、服务PID未变。记录精确局部回退材料及中间投影来源 |
| [selfchecks.json](selfchecks.json) | 配置/人格/依赖/服务健康四项通过，QQ在线、testIngress=false；最终脚本/证据覆盖与本地文档检查结果 |

脚本为 `chatbot/tests/persona/projection.test.mjs` 和 `chatbot/tests/persona/acceptance-host.mjs`，均由文档25拥有。宿主脚本必须指定新的绝对 `--out`；默认本地确定性模型，显式 `--live` 才调用当前官方DeepSeek，限24次请求、每次最多1200输出tokens。仅合成对话可以进入本目录，凭据、日常会话及MEMORY正文留在私密运行目录。

生产仅通过 `sync-persona.mjs --apply` 写受管人格文件，没有重启。局部回退材料在 `/home/afrangry/.openclaw-fusion/migration/before-yonagi-p1-2026-10-19T15-57-58-046Z/`；精确同步前副本可能已是并行任务同步的中间世凪版本，原小鲸鱼配置/素材另存。恢复方法以文档25为准，这不是全系统恢复演练。

本目录主体不重复覆盖P2实现细节、真人QQ情感体验、持久情绪或现有业务端到端回归；P2自动记忆和`/new`证据见[p2/](p2/)。真实模型样本只验证所列规则，不保证长对话风格完全稳定；其中一条回复有中英混词，原样留存。旧会话没有重置；固定提醒正文中的“主人”仍是既有独立待办。无Git暂存、提交或推送，保留并行工作区。
