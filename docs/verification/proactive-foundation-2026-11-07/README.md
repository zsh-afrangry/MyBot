# N3可信运行基础：独立验证

日期：2026-11-07（Asia/Shanghai）。开发基线9b98c9c；本轮源码指纹见[checks.json](checks.json)，提交从Git追溯。**共同基础24项机制测试与真实隔离宿主10场景通过，尚未接入生产。** 对应契约为文档24/25与主动唤醒工作稿第10节，实时排期只见《整理记录.md》。

## 实现与机制验证

`proactive-core/{policy,store,authority,service}.js`使用实际SQLite、进程内不可克隆凭据、真实宿主上下文和最终效果检查。没有生产路径默认值、定时器、生产插件、真实QQ发送器或新权限；现有QQ/领域授权未改动或接线。执行库只保留绑定/状态/哈希/回执，兴趣与自身记录不由该库替代。

`node --test chatbot/tests/proactive/core.test.mjs`：24/24通过。覆盖伪造身份/参数、精确运行与会话、独立连接并发/事件去重、暂停/新消息/策略及会话代际变化、深夜依据、超时、重启、已发送事实和未知不重试。使用合成主体及真实临时SQLite，无真实QQ、模型API或生产状态访问。

## 真实隔离宿主

`node chatbot/tests/proactive/acceptance-authority-host.mjs --out <新的绝对路径>`：10场景通过，18次本地确定性模型请求，详见[host.json](host.json)。实际OpenClaw2026.11.1 Gateway、公共SDK的runWithWorkAdmission/getSessionEntryAsync/runEmbeddedAgent及实际工具钩子参与；没有真实模型API或QQ。

- 普通回合与仅声称heartbeat来源的无凭据回合不能取得后台权限。
- 活跃凭据与真实runId/sessionId/sessionKey/agentId匹配时允许指定合成只读工具；模型参数中的主人位、目标和runId不生效。
- 错会话、错Agent、策略撤回、前台代际失效、额外工具、未启用及无通知授权均被拒绝。
- 合成领域执行器同时复核真实调用钩子和`assertInvocationCurrent`，没有只靠前置hook；所有运行结束无活跃凭据残留，fixture发送计数始终0。

最初两次夹具失败分别为生成源码换行转义和缺少官方强制策略manifest声明，已修复并记录于checks；不作为通过样本。后者进一步确认`contracts.trustedToolPolicies`必须显式登记，最终工厂拒绝检查保留。通过后的子Gateway、临时库与生成插件已清退，失败夹具亦定向清退，只保留最小事实。

## 尚未完成及生产边界

本fixture注册自己的强制策略和合成领域工具，**不能证明生产QQ策略或现有领域已接通**；未来必须在QQ唯一强制策略组合入口明确委托新的后台用途校验，并让各领域执行器独立复核，另注册allow策略不能覆盖现有拒绝。

唤醒方式B03.1仍待主人选择。周期/成本、真实上下文、P2只读目的授权、领域适配、可信活动和reset钩子、暂停入口、调度、主动外发与生产部署均未完成。本轮不开放main.message、N2原文/迁移/整理，不增加发言次数配额，也不将执行账本称为自身记忆或已完成的自主陪伴。

收尾：10项文档归属/索引回归、234项脚本索引与195份证据归属检查、生产四检通过。配置字节与B2一致，Fusion及4个独立服务的InvocationID均与B2之后一致；本轮N3开发未重启服务，未创建生产数据库或定时器。
