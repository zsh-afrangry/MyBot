# 融合方案结构示意（用户整理）

> **用途与状态（2026-10-10 补注，正文未改动）**
> 本文件是主人自己整理的方案对照与结构示意：三套系统的目录职责、旧 A/旧 B 与融合方案的数据流草图。
> 作为整体理解入口使用，**不是运行规则**；规则在 [`README.md`](README.md) 的 9–17。
> 下表有两处已随迁移变化、以正文之外的事实为准：
>
> - 旧 Kurumi/OpenClaw 与旧 QQ bridge 的**原路径已不存在**，现在归档在
>   `/home/afrangry/kurumi-archive/{legacy-openclaw,qq-bridge}`；回退时按[文档 15](15_旧系统回退.md)复制还原。
> - “小鲸鱼角色卡（临时）”的临时性质仍在，当前角色声明见 [`config/persona.json`](../config/persona.json)。
>
> 正文由主人维护，改动前先确认意图；其余章节的行文与图示保持原样。

| 系统 | 目录 | 作用 |
|---|---|---|
| 新系统源码 | [`/home/afrangry/kurumi-fusion`](/home/afrangry/kurumi-fusion) | 频道、工具、业务代码、角色卡、开发文档及 Git |
| 新系统运行数据 | [`/home/afrangry/.openclaw-fusion`](/home/afrangry/.openclaw-fusion) | 配置、凭证、会话、记忆、数据库、提醒及任务状态 |
| 旧 Kurumi / OpenClaw | `/home/afrangry/.openclaw` | 原个人助手方案，保留用于回退 |
| 旧 QQ bridge | `/home/afrangry/桌面/qq-bridge` | 原小鲸鱼的桥接与交互代码，保留原件 |
| DSH | `/opt/deepseek-harness` | 旧小鲸鱼方案的 AI 执行宿主 |
| SnowLuma | `/home/afrangry/snowluma` | QQ 连接与消息传输，新系统仍在使用 |
旧方案 A：
QQ ↔ 原 QQ 适配器 ↔ OpenClaw + Kurumi
                         └─ 原工具、提醒、文件能力

旧方案 B：
QQ ↔ SnowLuma ↔ qq-bridge ↔ DSH
                   └─ 小鲸鱼角色与聊天交互

当前融合方案：
QQ ↔ SnowLuma ↔ 新 kurumi-qq 频道 ↔ OpenClaw
                                      ├─ 官方 DeepSeek
                                      ├─ 小鲸鱼角色卡（临时）
                                      ├─ 提醒、记忆、天气
                                      └─ 代码与论文研究任务

flowchart TD
    U["你 · QQ"] <--> S["SnowLuma / OneBot<br/>QQ 接入与媒体传输"]
    S <--> Q["Kurumi QQ 频道插件<br/>身份映射 · 引用 · 分段 · 图片 · 表情"]
    Q <--> O["OpenClaw 助手宿主<br/>会话 · 工具执行 · 任务协调"]

    O <--> P["Kurumi 人格与记忆<br/>语气 · 用户偏好 · 关系事实"]
    O --> C["代码任务会话<br/>读写项目 · 测试 · Git"]
    O --> R["研究任务会话<br/>检索 · 阅读论文 · 核实来源"]
    O --> B["领域能力<br/>天气 · 提醒管理 · 行程"]

    O --> T["统一调度与任务状态<br/>定时 · 取消 · 执行记录"]
    T --> B
    T --> R

    C --> D["统一结果投递<br/>目标会话 · 顺序 · 回执 · 去重"]
    R --> D
    B --> D
    D --> Q

QQ 客户端 ↔ SnowLuma
               ├─ 3082：管理与日志
               ├─ 3084：消息事件 → kurumi-qq
               └─ 3083：发送等接口 ← kurumi-qq
                                      ↕
                             OpenClaw（18890）
                                      ↕
                               官方 DeepSeek
DSH（3080）：独立，仅同步启停

| 端口 | 组件 | 用途 |
|---|---|---|
| **3080** | DSH | DSH 网页界面，与新助手独立 |
| **3082** | SnowLuma WebUI | 管理界面、QQ 日志，你看的 `/logs` 在这里 |
| **3083** | SnowLuma OneBot HTTP | 新频道调用它发送消息、查询 QQ 状态等 |
| **3084** | SnowLuma OneBot WebSocket | 新频道连接它，接收 QQ 消息事件 |
| **18890** | 融合版 OpenClaw Gateway | 网关、管理界面与 RPC |
| **无独立端口** | `kurumi-qq` | 在 OpenClaw 内运行，连接 3083、3084 |
| **3081（已停）** | 旧 `qq-bridge` | 旧桥接控制台，目前没有监听 |