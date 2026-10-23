# QQ 融合助手架构与边界

类型：架构规则。状态：维护现行架构；各领域上线范围与未完成项分别见归属文档和[验收总表](16_验收与测试总表.md)。

本文说明系统职责与模块边界，不承载逐轮开发记录。阅读入口见[README](README.md)，配置意图与运行事实的分工见[配置契约](../config/README.md)。

## 架构决定

**OpenClaw 是唯一助手宿主，Kurumi 是能力项目，SnowLuma 提供 QQ 传输，DSH 不在助手主链路内。**

```mermaid
flowchart TD
  Q[已登记身份的 QQ 私聊] <--> S[SnowLuma / OneBot]
  S <--> C[Kurumi QQ 频道\n身份 / 图片 / 文件 / 分段 / 回执]
  C <--> O[OpenClaw\n会话 / 工具 / Cron]
  O --> P[共享人格 / 按身份关系]
  O --> MEM[记忆插件\n长期事实 / 连续性摘要]
  MEM --> MDB[(私有记忆 SQLite)]
  O --> CF[确认入口\n高影响操作二次确认]
  O --> B[天气插件]
  O --> PF[Profile插件]
  O --> PL[行程插件]
  O --> RM[一次性提醒插件]
  O --> RL[提醒列表插件\n待做 / 每日汇总]
  O --> K[记账桥接插件]
  B --> API[KnowledgeMap 助手API]
  RL --> API
  K --> API
  API --> DB[(网站与助手共享业务库)]
  O --> ML[邮件插件\n白名单收件人]
  O --> PA[论文插件\nPDF 翻译]
  O --> SR[web_search / web_fetch\nTavily / 宿主直取]
  O --> W[隔离代码项目]
  O --> R[研究与报告]
  PA --> D[结果投递]
  W --> D
  R --> D
  D --> C
```

不再维护第二套会话、提醒或 QQ 投递宿主。DSH 可以独立提供网页或模型服务，但启动它不应启动旧 qq-bridge，也不能成为 QQ 消费者。

## 人格、记忆与功能三模块

项目同时承担情感陪伴与 AI 助手两种角色。三模块是逻辑职责划分，不要求每个模块独占数据库、构建或进程：

| 模块 | 负责什么 | 代码与规则入口 |
| --- | --- | --- |
| 人格 | 性格、身份、表达方式及按可信身份选择的关系背景 | `roles/`、`config/persona.json`、`scripts/fusion/templates/` → `scripts/fusion/sync-persona.mjs`；规则归[25](25_人格、记忆与会话连续性.md) |
| 记忆 | 本人的长期事实、有限期近期摘要；与宿主聊天历史共同提供连续性 | `chatbot/plugins/kurumi-memory/continuity/`、`chatbot/plugins/kurumi-memory/inbound.js`；宿主管理原生会话，规则归[25](25_人格、记忆与会话连续性.md) |
| 功能 | 天气、资料/行程、提醒、日志、论文、邮件及后台项目等能力 | `chatbot/plugins/`、共享 `chatbot/packages/` 与运维 `scripts/fusion/`；代码分层归[21](21_后端职责分层与代码整理.md) |

角色设定不自动成为用户事实；聊天原文、运行日志与任务账本也不自动成为陪伴记忆。工具执行仍受可信身份、授权和领域事务约束，不能由人格关系或模型自述决定权限。

早期设计素材保留在[tp.txt](tp.txt)。其中“能力边界明确、模型负责理解、后端负责确定执行、稳定事实与动态状态分离”等原则与当前分层一致；PlanIR、DAG 和完整控制平面不据此视为已实现或当前开发任务。

## 当前资产

| 职责 | 路径或状态 |
| --- | --- |
| 新源码 | `/home/afrangry/kurumi-fusion`，MyBot `main` |
| 新运行状态 | `/home/afrangry/.openclaw-fusion`，凭据、会话、数据库和任务状态 |
| 旧系统 A | `/home/afrangry/kurumi-archive/legacy-openclaw`，只作为回退材料 |
| 旧系统 B | `/home/afrangry/kurumi-archive/qq-bridge`，配合 SnowLuma 和 DSH |
| 共享业务 | `/home/afrangry/repository` 的 KnowledgeMap MySQL；`knowledgemap-assistant.service` 提供 loopback 3086 API |
| QQ 传输 | `/home/afrangry/snowluma` 的受管服务 |
| 恢复材料 | `/home/afrangry/kurumi-backups` |

新系统不依赖 `/home/afrangry/.openclaw`。旧原路径的封存情况见[资产文档](12_目录资产与Git备份整理.md)；旧系统只能按[回退规则](15_旧系统回退.md)恢复，不能直接从归档路径启动。

## 能力边界

- QQ 身份及功能授权由 `config/access-control.json` 统一管理；只接收已登记用户私聊并回传自身，群聊关闭。成员使用独立 Agent/workspace，只允许聊天与自身论文等首期能力；个人业务仍仅主人。当前名单及真人验收状态见[文档24](24_统一身份与权限管理.md)。
- 人格素材来自 `roles/`，共享世凪性格并按可信身份选择关系，主人记忆不进入成员会话；人格与连续性唯一事实边界见[文档25](25_人格、记忆与会话连续性.md)。DeepSeek Flash 是当前主模型；模型配置见[配置契约](../config/README.md#主模型与人格切换)，图片验证边界见[文档10](10_融合助手运行维护.md#qq图片与引用)。
- 天气、Profile、行程和一次性提醒是四个独立插件，分别注册工具、确认后端和服务生命周期；默认实现共用 `packages/personal-domains`，Profile/行程仍保留历史共享SQLite。通用确认由 `confirmation-core` 提供，业务提交、grant消费、幂等、取消和投递对账在领域内完成。现行职责、共享代码、下载/阅读与生命周期统一归[文档21](21_后端职责分层与代码整理.md)；待实施检索设计见[文档26](26_基础能力插件边界整理与检索接入设计.md)。
- [提醒列表](19_提醒列表与定时汇总.md)与网站共用KnowledgeMap事项；账单和天气经同一业务API。用户规则归19，接口、版本与迁移归[23](23_KnowledgeMap业务能力桥接.md)，不在本架构入口重复动作清单。
- 代码任务在恢复项目副本和 Bubblewrap 中执行；项目检查不能访问生产目录、主机服务总线或真实网络。
- 研究材料与报告保存在私有运行目录；原始论文和页图与可写笔记分离。

## 依赖与升级

OpenClaw SDK 和 `ws` 使用已验收的固定版本。源码依赖由仓库 lockfile 管理，运行状态不进入 Git。升级必须经过依赖检查、构建、领域回归和隔离恢复验收，再更新部署服务。

## 服务职责与运行检查

- `kurumi-fusion.service`：默认助手。
- `knowledgemap-assistant.service`：常驻业务API，独立于网站开发服务器。
- `snowluma.service`、`snowluma-qq.service`：QQ 传输。
- `openclaw-gateway.service`、`qq-bridge.service`：旧消费者；日常保持屏蔽。恢复旧系统前须按[文档15](15_旧系统回退.md)只解除所选单元的屏蔽。
- `dsh-web.service`：可独立运行，但不消费 QQ。
- `testIngress=false`；验收入口关闭，日常不执行真实外发测试脚本。

上面列服务职责与预期约束，实时 active/enabled 状态由 `node scripts/fusion/health.mjs` 核对；操作见[文档10](10_融合助手运行维护.md#常用操作)。

## 维护边界

行为修改先改源码和配置来源，再同步私有运行目录；会话和长期记忆在运行目录维护；业务数据库和专用token在各自登记的私密位置备份。配置同步遵循 [`config/README.md`](../config/README.md)，资产与恢复点归属遵循[文档 12](12_目录资产与Git备份整理.md)，备份与恢复的验收标准遵循[文档 16](16_验收与测试总表.md)，旧系统切换遵循[文档 15](15_旧系统回退.md)；测试证据统一从文档 16 和 `verification/INDEX.md` 查找。
