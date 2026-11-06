# 统一备份范围与恢复开发条件核验

2026-11-07主人授权自行设计和管理`kurumi-backups`，整理完成后判断是否可恢复未完成需求开发。KnowledgeMap与DeepSeek Harness均为独立项目；本次只改变Fusion备份机制、备份材料和相关文档，不修改业务行为或独立项目，不真实外发、不push。

## 备份契约

- 新v3恢复点显式标记`scope: fusion-only`；捕获唯一源码的全部Git引用/工作文件、私有运行状态、一致SQLite、Fusion接口凭据、人格与唯一手册，以及Fusion拥有的编码试点Git/profile/状态。
- 共享工件采集OpenClaw、论文Python环境及Fusion执行边界实际使用的原生辅助包（约79KiB，含BSD许可证）；后者当前来自DSH安装里的`@deepseek-ai/node-addon-system-linux-x64@0.1.2`，独立还原到恢复副本的Fusion tools目录。DSH整体安装、全局认证与dsh-web单元不再采集；KnowledgeMap源码/MySQL始终排除。无scope的旧v3点按原契约兼容，不拆改旧点。
- 保留最近两个已隔离恢复成功且VERIFIED绑定匹配哈希的点；其余已验证点可淘汰。工件回收保护所有剩余点（包括失败/未完成点）的声明引用，校验托管元数据与SHA256后只删除无引用工件；未知文件不删除，采集与清理共用锁。
- 五份既存KnowledgeMap独立备份保持原路径/内容；SnowLuma下四份旧备份内容标记均属于DSH，按独立项目边界保留。它们不计入Fusion保留点数。

## 验证入口与边界

```bash
node --test scripts/fusion/test/backup-layout.test.mjs scripts/fusion/test/backup-retention.test.mjs scripts/fusion/test/recovery.test.mjs
node scripts/fusion/backup-state.mjs --label <用途> --quiesce
node scripts/fusion/restore-verify.mjs --backup <恢复点> --target /tmp/<全新目录>
node scripts/fusion/backup-retention.mjs --record /tmp/<全新目录>/verification.json
node scripts/fusion/backup-retention.mjs --apply
```

首轮离线工具/文档回归27/27通过。补充原生辅助包及新/旧恢复路径后，18项工具回归与10项文档归属回归联合28/28通过，218项脚本索引与156份证据归属通过。实际隔离探针另外执行真实辅助程序，要求试点目录内写入成功、目录外写入失败。

首个`2026-11-06-23-01-58-R3-fusion-only`（源码13f74a7）隔离恢复24/25：13库/18项资产及Gateway加载已到达探针，失败于原生执行写入边界launcher缺失；没有登记VERIFIED。原因是现行Fusion从DSH安装借用Linux辅助包，而非需要整套DSH或其认证。修正为单独归档真实辅助包、优先改写恢复副本的launcher路径，旧v3仍映射原DSH工件；不削弱写入边界、不改主机权限。失败材料只在新点验证覆盖后退役，本段保留失败事实。

第二次`2026-11-06-23-07-25-R3-current`（源码3259a55）为25/26：原生辅助包已完整恢复，旧探针仍在projectPolicy的独立DSH可执行文件检查处失败；未据此登记通过。后续探针显式传入范围，先断言真实DSH缺失时拒绝执行，再用不执行的`/usr/bin/false`检查其余Fusion结构策略，并实际测试Linux写入边界；不是伪装DSH后端可用。回执增加verifierHead，标明验证器与备份源码可以处于不同修订。旧点内容不改，必须在全新隔离目录重新验证。

修正探针在第二次隔离副本上的定向复跑通过：Gateway、17插件、2次模拟文本/图片投递、真实Linux目录内允许/目录外拒绝、DSH缺失拒绝与5条启用声明均通过。它只证明探针修正，不把旧失败回执覆盖成全量成功；正式保留点另行重新采集并在新/tmp目录完整恢复。

正式R3-ready：`2026-11-06-23-12-47-R3-ready`，源码与验证器均为256ce5a，停写采集13库/18项必需资产，26/26完整隔离恢复通过并登记VERIFIED。清单137文件全匹配，17插件/Gateway、Python3.12.15真实导入、2次模拟文本/图片投递、0试点任务、5启用调度声明、主机生产路径/总线/网络隔离与真实写入边界均通过；实际DSH未运行、真实外发0。

本轮离线回归28/28、218项脚本与156份证据归属通过。源码历史bundle验证成功，20项历史未提交源码归档可读，冻结确认标签仍指向4033b484。最终收口点、保留清理结果和实时判断在唯一《整理记录.md》维护，已验证点的原始回执留在统一备份根，不复制私密长日志进入源码。

恢复验证使用独立/tmp及Bubblewrap，禁主机生产路径、服务总线、真实QQ/API和调度。仅模拟QQ文本/图片、检查全部插件/Gateway、Python与Fusion编码边界；不运行DSH，不证明独立项目、真实QQ登录或真人功能验收。

## 恢复开发的判断

必须先有覆盖cf32a1c四项修复与当前备份工具的有效恢复点、干净单线源码、部署四检和可解释的材料保留结果。达到这些条件后可结束整理期间的统一冻结，按单一任务恢复需求；不等于把冻结标签4033b484整批部署，也不自动关闭N4/N6/FAQ真人复验、N7历史遮罩、成员与长期体验等未完成范围。具体队列和最终当前状态只在《整理记录.md》维护。
