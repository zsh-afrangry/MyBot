# Kurumi 融合原型

这是从旧 OpenClaw 独立克隆的试验分支，旧 SnowLuma/qq-bridge 原件未改造。

当前架构、验收、未完成项、启动与回退，以 [文档9](docs/9_QQ融合助手架构与开发计划.md) 为准。源码根是 `/home/afrangry/kurumi-fusion`，私有运行状态是 `/home/afrangry/.openclaw-fusion`；不要在原 `.openclaw` 目录直接继续本分支开发。

离线回归：

```bash
node scripts/fusion/link-dependencies.mjs
node --test chatbot/plugins/kurumi-qq/test/channel.test.js chatbot/plugins/kurumi-tasks/test/task.test.js
```

`scripts/fusion/test-*.mjs` 是授权验收脚本，部分会真实发送QQ或创建定时任务，不是可以随意重复运行的离线测试。当前验收入口已关闭。
