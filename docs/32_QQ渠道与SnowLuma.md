状态：开发中（私聊防抖已真人验收；QQ 频道/空间/群聊等接入未开展）

# QQ 渠道与 SnowLuma

本文按接入方式记录 QQ 的消息行为、配置和验证，范围包括 SnowLuma、QQ 开放平台和 QQ 开发者平台。当前功能只涉及 SnowLuma 的 OneBot 私聊。服务和启停见[文档 9](9_QQ融合助手架构与开发计划.md#服务)，链路查询见[文档 18](18_跨模块链路日志查询.md)。

## 功能

### SnowLuma 私聊入站防抖

同一私聊的普通文本按到达顺序收集。每来一条就重新计静默时间；静默 3 秒或从批次首条起满 10 秒时提交。批次内各条之间用换行分隔，交给宿主处理一轮。

命令、带码确认和含引用或媒体的消息单独处理。收到这类消息时，先提交同一会话内已收集的文本，再提交该消息。

### 主人私聊文件落地工作区

当 `kurumi-files` 启用且主人具备 `files.manage` 时，主人 QQ 私聊发送的非 PDF 常见办公/文本文件（`xlsx`、`csv`、`tsv`、`docx`、`txt`、`md`、`json`，单文件 ≤ 16 MiB）由 `qq-delivery.stageAttachment` 清洗文件名（中和红线文件名）后保存至默认工作区 `qq-inbox/<YYYY-MM-DD>/`，并将 `staged_to_workspace` 真实路径交由当前回合的 `kurumi_files` 或后续导入工具处理。PDF 仍按[文档22](22_论文PDF翻译与文件投递.md)进入文档库；成员入口严格维持仅限 PDF。

## 接口

在 [`config/runtime.config.json`](../config/runtime.config.json) 的 `channels.kurumi-qq` 调整参数，按[配置同步契约](../config/README.md#应用与生效)生效。

| 配置键 | 仓库值 | 作用 |
| --- | ---: | --- |
| `inboundDebounceMs` | 5000 | 静默时间，范围 0–10000 ms；省略或设为 0 时即时处理 |
| `inboundDebounceMaxWaitMs` | 15000 | 从首条起的最长收集时间，范围 1–60000 ms；缺省 10000 ms，须不小于静默时间 |

## 原理

`kurumi-qq` 在身份、会话路由校验和入站去重后，按会话使用 [OpenClaw 入站防抖 SDK](https://docs.openclaw.ai/plugins/sdk-channel-inbound#debouncing)。重连的重复事件不延长窗口。每条消息独立保留账本记录，主人活动在接收时上报。

一批最多收集 16 条、正文合计 16,000 个 UTF-16 单元，超过上限分成下一批。模型收到合并的正文，宿主同时收到原消息 ID 列表，并继续管理回合排队。命令和依赖原消息的可信请求取批次最后一条的原文和消息标识；[二次确认](6_二次确认.md)和显式记忆请求宜单独发送，待该轮处理后再发下一条。

## 限制与已知问题

- 单独一条普通文本也会等静默窗口。一轮对话仍可能因工具调用发出多次模型请求。
- 缓冲只驻留进程内存。账号正常关闭时，仍在缓冲中的消息标记为失败；进程重启不重放缓冲。

## 如何验证

按[文档 9](9_QQ融合助手架构与开发计划.md#开发与验证)准备本地 SDK 并构建确认核心后运行：

```bash
npm --prefix chatbot/plugins/kurumi-qq test
node chatbot/scripts/log-query.mjs --since 20m --last-turns 8 --format table --no-text
```

OpenClaw 2026.11.1 的本地 OneBot WebSocket 与模拟模型派发验证通过；本人 QQ 真人验收通过：连续 3–4 条、间隔 3–4 秒的消息在静默窗口内合并成一轮，超过窗口的间隔分别处理。

## 进行中：私聊入站防抖

- 2026-11-21 本人 QQ 真人验收通过：静默窗口 5 秒、最长收集 15 秒；连续 3–4 条、间隔 3–4 秒的消息合并成一轮，超过窗口的间隔分别处理。
- 后续 QQ 频道、QQ 空间、群聊等接入尚未展开；本文当前只覆盖 SnowLuma OneBot 私聊。
