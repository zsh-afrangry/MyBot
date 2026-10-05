# 小鲸鱼与DeepSeek切换及确认策略研究

现在应该从哪里继续：本次授权的角色、模型、图片入口修复已生效；等待用户日常体验反馈。确认策略、私聊引用与会话管理暂不实施。

## 当前状态与范围

- [x] 原样复制旧bridge的3份角色目录Markdown，临时启用小鲸鱼。
- [x] 默认及main模型切为官方DeepSeek，运行配置移除NAICCC，无NAICCC回退。
- [x] 修复真实QQ图片CDN入口；真实下载及独立模型看图验证通过，频道19项回归通过。
- [x] 查明Start-DSH.sh拉起旧bridge造成服务接管，恢复融合服务。
- [x] 调查确认与引用；只记录建议，没有修改策略。
- [ ] 用户日常QQ体验复验；本轮没有重发原消息或向QQ发送验收消息。

## 角色、模型与回退

`/home/afrangry/桌面/qq-bridge/roles/`下的README.md、小鲸鱼.md、傲娇助手.md原样复制到`/home/afrangry/kurumi-fusion/roles/`。README是原bridge说明，里面的旧命令不代表融合项目启动方式。三份文件与原件SHA256均一致。小鲸鱼卡SHA256为`237dce15331b4839fb0d9edb2b362017bffe6b99a732925bcb5d40a47c0c3386`，与运行时SOUL.md一致。

配置脚本：`scripts/fusion/configure-deepseek-persona.mjs`。运行时文件位于`/home/afrangry/.openclaw-fusion/`，旧配置和四份人格文件保存在`migration/before-deepseek-whale-2026-10-05/`，只对私有备份读写，密钥不进Git。脚本复用旧OpenClaw的DeepSeek凭证，原件不修改。需要回退时先停融合服务，再从此备份恢复对应文件并启动；不要删除整个运行状态目录。旧聊天、记忆和业务数据库没有清空。

当前主模型为`deepseek/deepseek-flash`，直连`https://api.deepseek.com`，使用OpenAI兼容Chat Completions，声明text/image输入。实际/models返回该模型支持图片；实际agent终态回执的requested/effective/responseModel均为DeepSeek Flash，无reroute。它不经过DSH或NAICCC。默认设置也被未单独指定模型的后台agent继承，但本轮没有重做全部后台任务验收。

SOUL使用完整旧角色卡，IDENTITY切为小鲸鱼；AGENTS明确Kurumi是项目名，角色的群友语气用于本人私聊，业务结果必须准确。沿用仅本人私聊限制，角色卡不授予群聊权限。日常旧会话未重置，旧历史可能继续影响语气；本轮不解决会话管理。

## 图片故障与验证边界

真实消息1878941053的图片来自`multimedia.nt.qq.com.cn`。旧白名单只有`multimedia.nt.qq.com`，在频道stageImage阶段拒绝；原15:29模型只拿到未加载提示。因此首要故障不是模型凭空拒绝看图。

修复位于`chatbot/plugins/kurumi-qq/src/media.js`：补充确切主机，抽取URL校验供回归测试。保留HTTPS、无用户凭证、无非默认端口、禁止重定向、8MiB及图片类型检查。未开放任意URL。

同一真实消息的图片已通过实际stageImage下载，JPEG为1,012,270字节；随后送入OpenClaw main的独立测试会话，deliver=false。模型识别了顶部问题、白车、加油站和红色弧形箭头，说明图片成功进入视觉输入。它对车道方向有误读，并额外给出未经验证的驾驶判断；不能把此验收解释成交通建议正确。没有重新走一次用户QQ发送至QQ回包的完整回路，后续真实新图片体验仍由用户复验。

证据：`docs/verification/deepseek-whale/model-image.json`与`channel-tests.txt`。模型测试session为`agent:main:acceptance-whale-image-20261005`，与日常主会话分开。证据不含签名图片URL、凭证或模型思考正文。

## 双链路调查

`/opt/deepseek-harness/Start-DSH.sh`第109行开始依次启动snowluma、snowluma-qq、qq-bridge，不是仅启动DSH Web。调查时旧qq-bridge active，融合服务inactive。融合systemd单元与qq-bridge/openclaw-gateway互斥，所以这次是旧bridge接管，不是这两个受管服务同时回复。OneBot登录QQ确认为1794511189，两套方案复用同一QQ传输账号，账号本身不能区分后台宿主。

用户后续明确要求统一启停，新版`/opt/deepseek-harness/Start-DSH.sh`已改为启动DSH Web、kurumi-fusion、snowluma与snowluma-qq，并停止旧bridge/旧OpenClaw。Stop按消费者优先的顺序停止整套服务，保留状态和开机启动设置。没有额外的新qq-bridge进程或新SnowLuma目录：新方案的桥接在融合插件内，QQ传输复用原SnowLuma服务。

脚本受版本控制的源文件位于`/home/afrangry/kurumi-fusion/scripts/fusion/launchers/`，部署位置仍为`/opt/deepseek-harness/`。旧脚本备份于`/opt/deepseek-harness/launcher-backup-before-fusion/`，旧bridge源码和配置未改。Start使用融合health检查实际Gateway、QQ状态及连接，不再读取旧bridge控制台；health已允许独立DSH Web与融合服务并存，仍禁止旧QQ消费者运行。DSH只是同步启停，模型请求仍直连DeepSeek。

启停回归状态见文档10末尾。停机期间助手及提醒投递不可用；Stop不删除任务或会话，也不取消enabled开机启动设置。

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

既有验收历史留在原日常会话，按用户要求本轮不清理、不重置、不实现会话管理。

模型能力资料：[DeepSeek视觉输入](https://api-docs.deepseek.com/guides/vision/)、[模型元数据](https://api-docs.deepseek.com/api/list-models/)。以上为2026-10-05查阅及本机实测状态。
