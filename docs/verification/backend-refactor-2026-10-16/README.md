# 后端职责分层验收

2026-10-16（Asia/Shanghai）。方案、文件职责与后续待办见[文档 21](../../21_后端职责分层与代码整理.md)。本目录只保存本轮证据。

本页对应 `463bb95` 的初轮保持行为重构；后续调用链修复见 [structured-items](structured-items/README.md)，当前可插拔及自然对话结论见 [adapters](adapters/README.md)。以下初轮“未修复”描述仅属于该历史提交。

| 证据 | 结论 |
| --- | --- |
| [report.json（历史材料）](README.md#historical-material) | 基线、336/336 回归、3 个包构建、四项自检和加载结果；仅保存运维摘要，不复制业务库或聊天 |
| [node-tests.txt（历史材料）](README.md#historical-material) | 142/142；QQ、记忆、代码任务、论文、邮件、提醒列表及新增 13 项跨层回归 |
| [confirmation-core-tests.txt（历史材料）](README.md#historical-material) | 17/17；共享确认协议与跨领域 registry |
| [confirmation-inbound-tests.txt（历史材料）](README.md#historical-material) | 15/15；确认入口可信上下文 |
| [weather-tests.txt（历史材料）](README.md#historical-material) | 162/162；天气/Profile/Planning/一次性提醒及原交互 hook |

实际命令（仓库根目录）：

```bash
npm --prefix chatbot/packages/confirmation-core run build
npm --prefix chatbot/plugins/personal-confirmation run build
npm --prefix chatbot/plugins/personal-weather run build
npm --prefix chatbot/packages/confirmation-core test
npm --prefix chatbot/plugins/personal-confirmation test
npm --prefix chatbot/plugins/personal-weather test
node --test --test-reporter=tap chatbot/plugins/kurumi-qq/test/*.test.js chatbot/plugins/kurumi-memory/test/*.test.js chatbot/plugins/kurumi-tasks/test/*.test.js chatbot/plugins/kurumi-research/test/*.test.js chatbot/plugins/kurumi-mail/test/*.test.js chatbot/tests/reminder-list/*.test.mjs chatbot/tests/backend-boundaries/*.test.mjs
node scripts/fusion/verify-dependencies.mjs
node scripts/fusion/sync-config.mjs
node scripts/fusion/sync-persona.mjs
node scripts/fusion/health.mjs
```

本轮范围包含源码重构后的服务加载，已直接重启 `kurumi-fusion.service`；没有运行 DSH 启停脚本，没有执行配置写入或重建生产业务库。重启后 9 个插件加载，QQ 连接恢复，3 个确认后端完成注册，`testIngress=false`。启动中仍出现重构前已有的远端模型目录刷新警告；四项自检通过，本轮不修改该外围问题。

新增分层用例验证真实工具入口仍经过原策略、存储可接受结构化数据、拒绝不留业务写入、审计/重放与业务变更一起回滚、grant 消费随业务事务回滚、领域适配器注册失败清理、交互钩子不跨工具/轮次扩大范围。

未执行真实模型、真人 QQ 往返或真实邮件发送；未重新制作快照或进行全量恢复。本轮没有取消原文词表规则，“第六条”问题仍是后续策略调整事项。不能把离线重构验收解释为该对话体验已修复。现有恢复点与后台开发副本不因此自动更新。

<a id="historical-material"></a>

## 历史原始材料的保留位置

本目录生成的原始回执、日志和图片已退出活动树；既有结论及失败状态不因此改变，也不代表新版已验收。已入Git的内容可用 `git show c849e63:<原仓库相对路径>` 读取；表中的blob标识可核对原始字节。未入Git的临时输出按本次清理授权丢弃。当前执行状态只在全局《整理记录.md》维护。

| 原文件 | 原报告顶层字段（仅摘录） | Git blob |
| --- | --- | --- |
| `confirmation-core-tests.txt` | 未提取；以原材料及现有结论为准 | `5f2a780d3fbc71cde3ab1fa21de4abd3d5f00524` |
| `confirmation-inbound-tests.txt` | 未提取；以原材料及现有结论为准 | `02e53151c97fcc278d7f60133408db285e77d46d` |
| `node-tests.txt` | 未提取；以原材料及现有结论为准 | `f311d2ec317111a0494445abf6bc4e50baff219b` |
| `report.json` | at=2026-10-16T01:23:34.489601+08:00 | `3e315759671a2ee70a4504cf210a0672b8101dae` |
| `weather-tests.txt` | 未提取；以原材料及现有结论为准 | `c86d9dab763271dbfde5a0a93e38f9b1590c9b93` |
