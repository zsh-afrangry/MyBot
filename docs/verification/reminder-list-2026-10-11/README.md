# 提醒列表验收（2026-10-11）

需求、方案、决策和开发闭环见[文档 19](../../19_提醒列表与定时汇总.md)。本目录仅保存证据，统一索引见[INDEX](../INDEX.md)。最新自然录入补正、可空 DDL、多轮与会话重置见 [natural-input 验收](natural-input/README.md)；下表是初版证据，不替代该补正。

| 文件 | 证明范围 |
| --- | --- |
| [offline.json](offline.json) | 新领域 28 项（含持久 runner 路径）；合计 Node 77 项、确认核心 17、确认插件 15、天气 162 的命令/退出码/输出；无真实外发 |
| [model.json](model.json) | 真实 DeepSeek，实际 v2 插件工具和合成可信入站钩子；独立 SQLite，12 个场景，生产列表不变 |
| [host.json](host.json) | 真 OpenClaw 独立进程、真实模型、模拟 OneBot；6 个入站/工具/调度场景及宿主生成脚本的路径与实际执行检查，隔离进程正常停止、生产列表不变 |
| [native.json](native.json) | 原生 Cron 的固定程序跨生产 Fusion 重启发送本人 1 条汇总；真实 OneBot 消息回执、终态过滤、重复静默、测试任务撤销、生产列表不变 |
| [deployment.json](deployment.json) | 最终配置/人格/依赖/健康自检、生产默认设置/受管 Cron 摘要、运行源码哈希与元数据验证；错误捕获路径的校验与修复记录 |

离线复现：

```bash
node --test chatbot/tests/reminder-list/*.test.mjs
```

三份 `chatbot/tests/reminder-list/acceptance-{model,host,native}.mjs` 需按[脚本索引](../SCRIPTS.md)单独审阅和授权。native 会真实重启 Fusion 并发本人 QQ；model/host 真实调用模型；host 的 QQ 仅接本地模拟端。全部待办写入 `/tmp/`，测试未删除生产账本；model/host 支持 `--out` 指定独立目录；未指定时仍覆盖固定路径。native 的固定证据重跑前保留旧版本。

未覆盖：真人 QQ 入站维护、完整一天四时段持续运行、长期数据量压力和本功能的全量备份恢复演练。原生任务真实送达和 Host 模拟入站分别证明，不能合称为真人全链路往返。需求样例没有自动创建。
