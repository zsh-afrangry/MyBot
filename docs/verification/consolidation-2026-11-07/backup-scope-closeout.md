# 统一备份范围与恢复开发条件核验

2026-11-07主人授权自行设计和管理`kurumi-backups`，整理完成后判断是否可恢复未完成需求开发。KnowledgeMap与DeepSeek Harness均为独立项目；本次只改变Fusion备份机制、备份材料和相关文档，不修改业务行为或独立项目，不真实外发、不push。

## 备份契约

- 新v3恢复点显式标记`scope: fusion-only`；捕获唯一源码的全部Git引用/工作文件、私有运行状态、一致SQLite、Fusion接口凭据、人格与唯一手册，以及Fusion拥有的编码试点Git/profile/状态。
- 共享工件只采集OpenClaw与论文Python环境。DSH安装、全局认证与dsh-web单元不再采集；KnowledgeMap源码/MySQL始终排除。无scope的旧v3点按原契约兼容，不拆改旧点。
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

离线工具回归17项、文档归属回归10项联合27/27通过：覆盖新/旧范围、深层数据库发现、工件重用与破损拒绝、最近两点、未完成引用保护、缺失/越界引用拒绝、停写恢复/信号、源码补丁与隔离边界。218项脚本索引与156份证据归属通过，源码diff空白检查通过。实际新点恢复结果在执行完成后更新于本页；未实际验证的点不列为完成。

恢复验证使用独立/tmp及Bubblewrap，禁主机生产路径、服务总线、真实QQ/API和调度。仅模拟QQ文本/图片、检查全部插件/Gateway、Python与Fusion编码边界；不运行DSH，不证明独立项目、真实QQ登录或真人功能验收。

## 恢复开发的判断

必须先有覆盖cf32a1c四项修复与当前备份工具的有效恢复点、干净单线源码、部署四检和可解释的材料保留结果。达到这些条件后可结束整理期间的统一冻结，按单一任务恢复需求；不等于把冻结标签4033b484整批部署，也不自动关闭N4/N6/FAQ真人复验、N7历史遮罩、成员与长期体验等未完成范围。具体队列和最终当前状态只在《整理记录.md》维护。
