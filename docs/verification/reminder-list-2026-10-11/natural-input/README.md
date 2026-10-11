# 自然录入补正验收（2026-10-11）

需求、当前规则、开发调整与未覆盖范围只在 [文档 19](../../../19_提醒列表与定时汇总.md) 展开；本页索引证据。源码起点 `b2c182c`，本次本地提交以 Git 历史为准。

| 文件 | 证明范围 |
| --- | --- |
| [offline.json](offline.json) | 最终 Node 92/92，含本领域 43；命令、退出码、输出。天气/确认三包另有同一 shell 的通过摘要，未分别捕获退出码 |
| [model.json](model.json) | 真实 DeepSeek，自然对话 11/11；实际列表工具、独立 SQLite；一次性提案是非写入路由夹具，调用数 0；生产列表/旧提案/提醒逻辑数据不变 |
| [host.json](host.json) | 独立 OpenClaw 与真实模型、模拟 OneBot，13/13；实际加载两类提醒工具，七句、隐式追加、结束及实际 sessions.reset；提案数 0，进程停止、生产两领域不变 |
| [regression/model.json](regression/model.json) | 原功能真实模型 12/12；追加/修改/完成/作废/时刻/暂停恢复/日期型 DDL/缺期限/歧义；生产两领域不变 |
| [regression/host.json](regression/host.json) | 原功能隔离 Host 6/6；调度收敛、持久 runner 路径和实际执行；进程停止、生产两领域不变 |
| [deployment.json](deployment.json) | 模板同步、Fusion 重启、metadata 与四项自检、源码 SHA256、默认四个 Cron 保持、生产两领域数据哈希一致 |
| [closeout.json](closeout.json) | 文档本地链接、证据分类、脚本表一致、差异检查和最终文件/版本收录边界 |

本轮授权来自用户“有计划可以直接开始”和提醒列表开发/测试权限；没有真人 QQ 测试外发、生产示例导入或远端写入。所有传输接模拟 OneBot，SDK、主模型真实。原生实际 QQ 投递单独引用父目录 [native.json](../native.json)，不以本轮替代。

复现命令（真实模型/宿主脚本按 [SCRIPTS](../../SCRIPTS.md) 单独执行）：

```bash
node --test chatbot/tests/reminder-list/*.test.mjs
node chatbot/tests/reminder-list/acceptance-model.mjs --natural --out <新的证据目录>
node chatbot/tests/reminder-list/acceptance-host.mjs --natural --out <新的证据目录>
node chatbot/tests/reminder-list/acceptance-model.mjs --out <原功能回归证据目录>
node chatbot/tests/reminder-list/acceptance-host.mjs --out <原功能回归证据目录>
```

七句原样见 [dialogue-cases.mjs](../../../../chatbot/tests/reminder-list/dialogue-cases.mjs)。本次在 2026-10-11、Asia/Shanghai 验证 10 月 12/13/16 日；以后原样重跑遇到过去 DDL，应按真实时间拒绝，不能偷偷改例子或滚到次年。

SQL NULL 意味着没有截止时间，无 DDL 不过期。“越快越好”“选举后”“会议结束后”作为原文资料保留并进入固定时段汇总；目前没有自动识别活动完成或事件触发功能。“发压缩包到钉钉”保留作业要求，未执行外发。

未覆盖：修复后的真人 QQ 入站往返、整天四时段持续运行、长期压力、完整备份恢复。模型路由夹具不能证明一次性工具真实存储；该竞争条件由 Host 实际领域加载与提案库另行核实。强制跨域拒绝在离线实际钩子回归中验证，模型本次没有主动走该错误分支。
