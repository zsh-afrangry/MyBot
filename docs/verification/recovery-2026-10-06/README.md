# 恢复工具修复验收（2026-10-06）

现在应该从哪里继续：代码与离线回归已完成，正在制作并验收新的停写恢复点；最终路径和结果将在本文件更新。

- 服务中断实际验收：`backup-interruption.json`；观察到inactive后发送SIGTERM，退出143，服务恢复active，备份保留INCOMPLETE并被恢复工具拒绝。
- 恢复工具回归：`recovery-tests.txt`，包含服务状态/信号、混合Git修改、目标目录保护、沙箱文件与网络隔离、A/B回退选择。
- 频道/任务/记忆/研究：`channel-tools-tests.txt`。
- 领域测试：`domain-0.txt`、`domain-1.txt`、`domain-2.txt`。
- 生产状态检查：`health-after-interruption.json`、`dependencies.txt`、`config-selftest.txt`。

前置故障定位使用旧FINAL快照恢复副本，修复后已在Bubblewrap运行Gateway和模拟OneBot；不以该临时迭代结果冒充最终全流程验收。最终报告需从新备份重新执行完整恢复工具生成。

范围：隔离恢复验证包括SDK恢复、依赖安装、三个TS包构建、七个插件import、Gateway health、模拟QQ频道连接、文字与图片发送及本地图片入站暂存。不使用真实模型API、不发送真实QQ消息、不执行真实提醒。

未改变两套旧原件、未清理旧备份，用户docs/example.md修改保持独立；本轮未创建远端仓库或推送。
