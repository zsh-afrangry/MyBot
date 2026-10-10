# 小鲸鱼与DeepSeek切换及确认策略研究

当前状态：角色、模型和图片入口修复已生效。确认策略、私聊引用与会话管理仍未实施，日常体验复验由后续变更单独记录。

> 本文的“角色、模型与回退”一节区分两件事：**一次性迁移的历史记录**（`configure-deepseek-persona.mjs`，已完成，不再作为日常入口）与**当前人格切换契约**（`config/persona.json` + `sync-persona.mjs`）。
> 日常改人格不要运行迁移脚本；契约见 [`config/README.md`](../config/README.md)，运行命令见[文档 10](10_融合助手运行维护.md)。

## 当前状态与范围

- [x] 原样复制旧 bridge 的 3 份角色目录 Markdown，当前启用小鲸鱼角色卡。
- [x] 默认及main模型切为官方DeepSeek，运行配置移除NAICCC，无NAICCC回退。
- [x] 修复真实QQ图片CDN入口；真实下载及独立模型看图验证通过，频道19项回归通过。
- [x] 查明Start-DSH.sh拉起旧bridge造成服务接管，恢复融合服务。
- [x] 调查确认与引用；只记录建议，没有修改策略。
- [ ] 用户日常 QQ 体验复验；当前证据集没有重发原消息或向 QQ 发送验收消息。

## 角色、模型与回退

`/home/afrangry/桌面/qq-bridge/roles/`下的README.md、小鲸鱼.md、傲娇助手.md原样复制到`/home/afrangry/kurumi-fusion/roles/`（该桌面路径现已不存在，原件归档在`/home/afrangry/kurumi-archive/qq-bridge/roles/`）。README是原bridge说明，里面的旧命令、控制台操作和“保存即生效”都不代表融合项目启动或切换方式；自2026-10-10起该README顶部增加了来源说明块，因此只有两份角色卡仍与归档原件逐字一致。小鲸鱼卡SHA256为`237dce15331b4839fb0d9edb2b362017bffe6b99a732925bcb5d40a47c0c3386`，与运行时SOUL.md一致。

**日常人格切换不使用 `configure-deepseek-persona.mjs`。** 该脚本是一次性迁移工具（2026-10-05 把旧 bridge 切换到 DeepSeek+小鲸鱼时执行），除了角色卡还会重写 `models.providers`、默认模型、`runtime-env.json`（并删除 `OPENAI_API_KEY`）和四份工作区文件；它的历史作用与备份位置记录如下，脚本开头也已加警告。当前入口是 `config/persona.json` + `sync-persona.mjs`，配置契约见 [`config/README.md`](../config/README.md)。

一次性迁移的历史记录：运行时文件位于`/home/afrangry/.openclaw-fusion/`，旧配置和四份人格文件保存在`migration/before-deepseek-whale-2026-10-05/`，只对私有备份读写，密钥不进Git。脚本复用旧OpenClaw的DeepSeek凭证，原件不修改。需要回退时先停融合服务，再从此备份恢复对应文件并启动；不要删除整个运行状态目录。旧聊天、记忆和业务数据库没有清空。

当前主模型为 `deepseek/deepseek-flash`，直连 `https://api.deepseek.com`，使用 OpenAI 兼容 Chat Completions，声明 text/image 输入。实际 `/models` 返回该模型支持图片；实际 agent 终态回执的 requested/effective/responseModel 均为 DeepSeek Flash，无 reroute。它不经过 DSH 或 NAICCC。默认设置也被未单独指定模型的后台 agent 继承；全部后台任务未单独重复验收。

SOUL使用完整角色卡，IDENTITY为小鲸鱼；AGENTS明确 Kurumi 是项目名，角色的群友语气用于本人私聊，业务结果必须准确。沿用仅本人私聊限制，角色卡不授予群聊权限。日常旧会话未重置，旧历史可能继续影响语气；会话管理属于后续独立工作。

## 图片故障与验证边界

真实消息1878941053的图片来自`multimedia.nt.qq.com.cn`。旧白名单只有`multimedia.nt.qq.com`，在频道stageImage阶段拒绝；原15:29模型只拿到未加载提示。因此首要故障不是模型凭空拒绝看图。

修复位于`chatbot/plugins/kurumi-qq/src/media.js`：补充确切主机，抽取URL校验供回归测试。保留HTTPS、无用户凭证、无非默认端口、禁止重定向、8MiB及图片类型检查。未开放任意URL。

同一真实消息的图片已通过实际 stageImage 下载，JPEG 为 1,012,270 字节；随后送入 OpenClaw main 的独立测试会话，`deliver=false`。模型识别了顶部问题、白车、加油站和红色弧形箭头，说明图片成功进入视觉输入。它对车道方向有误读，并额外给出未经验证的驾驶判断；该验收不代表交通建议正确。没有重新走一次用户 QQ 发送至 QQ 回包的完整回路，后续真实新图片体验仍由用户复验。

证据：`docs/verification/deepseek-whale/model-image.json`与`channel-tests.txt`。模型测试session为`agent:main:acceptance-whale-image-20261005`，与日常主会话分开。证据不含签名图片URL、凭证或模型思考正文。

## 启停脚本与旧 bridge 的关系

**当前规则**：`/opt/deepseek-harness/Start-DSH.sh` 与 `Stop-DSH.sh` 只启停 `dsh-web.service` 与
`kurumi-fusion.service`，**不启动也不停止** `snowluma`/`snowluma-qq`（QQ 传输独立管理，只检查状态）；
旧 `qq-bridge`/`openclaw-gateway` 由 `kurumi-fusion` 的 `Conflicts=` 自动停掉，脚本不显式操作。
完整契约与理由见[文档 10](10_融合助手运行维护.md)的「DSH与融合栈统一启停」。

**历史教训（保留）**：早期版本的 `Start-DSH.sh` 会依次拉起 `snowluma`、`snowluma-qq`、`qq-bridge`，
而 `qq-bridge` 与融合单元互斥，因此一次启动就让旧 bridge 接管了 QQ，融合服务被停。
这说明**启停脚本的行为本身就是安全边界**：改动它必须同时核对互斥关系与 QQ 消费者归属，
不能只看脚本是否“启动成功”。账号层面无法区分宿主（两套方案复用同一 QQ 登录），
所以只能靠“同一时刻只有一个消费者”来保证。

脚本源文件在 `scripts/fusion/launchers/`，部署位置 `/opt/deepseek-harness/`，
旧入口备份在 `/opt/deepseek-harness/launcher-backup-before-fusion/`；
两者当前逐字节一致，修改后必须同步部署。旧 bridge 源码与配置未改。

## 确认机制研究：尚未实施

实际确认失败发生在`chatbot/packages/confirmation-core/src/gate.ts`：只解析“确认 <12位码>”或旧完整ID/hash格式。15:31的模型理解了用户“确认”并尝试提交，但后端拒绝。提案24小时有效期也与几分钟后的提醒时间是两回事，展示时容易让用户误会。

官方资料的共同点是区分“理解任务”与“授予权限”：

- [Codex Auto-review](https://learn.chatgpt.com/docs/sandboxing/auto-review)：在符合条件的越界请求上，用独立审核agent结合具体操作和上下文决定是否批准；仍受沙箱、网络和文件权限约束，并非主模型一句“安全”就放行所有工具。
- [Claude Code permissions](https://code.claude.com/docs/en/permissions)：allow/ask/deny及权限模式由执行框架落实，提示词不能授予权限。[自动权限模式](https://code.claude.com/docs/en/permission-modes)可以借助分类器审查动作是否符合任务，不能由此推断普通应用天然拥有这套能力。
- [OpenAI Guardrails与审批](https://developers.openai.com/api/docs/guides/agents/guardrails-approvals)：自动校验与人工审批是不同机制，执行副作用前应有相邻的校验点。

建议下一阶段采用“模型解释意图 + 工具层判定可执行性”：

| 场景 | 建议体验 | 工具层要求 |
| --- | --- | --- |
| 本人明确说3分钟后提醒喝水 | 直接创建后报告绝对时间 | 可信本人、允许收件人、时间锚点、幂等、防重复 |
| “周五提醒我”但缺少几点 | 追问缺失时间 | 模型不能自行猜测用户真正想要的时间 |
| 一句话多件事 | 按用户偏好先汇总一次确认 | 每项分别解析；多项不必然有歧义，不拼成不可审计的操作 |
| 危险、不可逆、稀缺资源消耗 | 展示具体影响，获得有效授权 | 不能让主模型自行声明已获同意 |
| 唯一待确认提案后说“确认” | 允许自然确认 | 绑定本人、会话、有效期、具体参数快照；多提案时追问是哪项 |

模型可以判断存在歧义、利用上下文消歧、向用户澄清，但不能“替用户确认”。不要用某个模型自报置信度百分比作为唯一安全阈值；安全阈值应落实为具体动作类别、参数边界和授权范围。

重置卡是稀缺且消耗后不可撤销的资源。本会话工具要求每次使用有明确用户确认并现场检查额度；用户授权又限定剩余严格低于5%、仍有必要工作及总数量。应把这些作为确定条件检查，不让模型凭“我觉得需要”决定。Codex通用权限模式也不能覆盖具体工具自身契约。

## 私聊引用与会话：尚未实施

现有OpenClaw未指定频道replyToMode时默认all；`transport.js`只在分段的第一条添加reply段，所以表现为每次第一条必引用。建议后续关闭隐式默认引用，保留模型/频道在回应较早消息、跨话题消歧时显式引用的能力。本次未改频道或SDK引用策略。

既有验收历史留在原日常会话；当前不清理、不重置，也不实现会话管理。

模型能力资料：[DeepSeek视觉输入](https://api-docs.deepseek.com/guides/vision/)、[模型元数据](https://api-docs.deepseek.com/api/list-models/)。以上为2026-10-05查阅及本机实测状态。
