# 整理后四项定向修复（2026-11-07）

授权：主人明确要求先核对开发文档、将四项登记到《整理记录.md》，然后实施。本轮从6d7b7290起，在当前聊天cbc3工作树隔离开发；未合入整条冻结工作线。正式版本为OpenClaw2026.11.1、Node26.13。

## 实现与已验证范围

- N1：复用冻结日志协议解析/字段投影/审计改动，新增只读channel-delivery账本适配、--no-text、执行/业务结果分离及预览/条数截短标记。日志与E7及领域日志联合60例通过。生产05:49:59–05:50:10仅做只读核对，天气execution=ok/business=ok，频道sent且有平台receipt；未复制聊天正文。
- N4：择取986b912的批量目标冻结、领域事务及展示焦点修复，保留coding单项边界，并适配11.1 dispatch_action。confirmation-core 61例、personal-confirmation 27例、personal-domains 162例通过；领域/权限/邮件附件/编码80例通过。隔离真实宿主12用例、56次本地确定性模型请求通过，见[natural-host.json](natural-host.json)。无真实QQ/SMTP或付费模型调用；本地TLS SMTP仅模拟收发。迁移仅新增nullable presentation_order，旧数据保留及重入已有回归。
- N6/N7：当前P2批量ids事务保留；delete新增当前原文evidence、有限问句/引用/条件/否定拒绝边界，dispatch_action钩子兼容；22例事务/权限回归通过；扩展后的真实隔离宿主12用例、30次本地模型请求通过，包含问句拒绝与一次删两条，[memory-host.json](memory-host.json)保存摘要。隔离模型输入同时证实旧上下文仍含已遗忘合成文字，/new后消失。原文历史遮罩不在本轮实现，不能宣称N7全部解决。
- N20：FAQ精确空结果后最多3个短词重试；中文分词相邻单字兼容“团战”，游标绑定实际词，候选及空结果范围显式返回。全部E7回归包含在上述60例联合运行中；隔离宿主启停两阶段通过，见[e7-host.json](e7-host.json)。公开只读FAQ核对“团战人数差防御塔血量”→“团战”找到4条，包含41，并成功读取正文；[e7-public.json](e7-public.json)不包含完整正文。

## 命令与边界

使用/usr/bin/node：

- `--test scripts/fusion/test/log-query*.test.mjs chatbot/tests/*/log-query.test.mjs chatbot/tests/e7/*.test.mjs`
- `--test chatbot/tests/backend-boundaries/*confirmation*.test.mjs chatbot/tests/papers/mail.test.mjs chatbot/tests/coding/*.test.mjs`
- `--test chatbot/tests/persona/memory.test.mjs`
- 三个TypeScript包分别`npm test -- --run`，五个受管构建包`npm run build`。
- `chatbot/tests/backend-boundaries/acceptance-natural-confirmation-host.mjs --out <新临时绝对路径>`
- `chatbot/tests/persona/memory-continuity-host.mjs --out <新临时绝对路径>`（无--live）
- `chatbot/tests/e7/acceptance-host.mjs --out <新临时绝对路径>`

集合有重叠，不合计为一次全项目测试。开发中先发现新展示字段使旧文本断言不匹配，及ICU将团战拆成单字导致降级漏词，修正后回归通过。

## 剩余验收

自然确认、批量遗忘的真实模型选择/QQ体验及E7真人答复仍待复验；没有为清待办外发消息。N7旧历史遮罩留文档29阶段2，与全局N2同一实现线。记忆有限拒绝规则不是完整语义判定器，部分委婉疑问会保守拒绝；不能把它描述为全面解决意图识别。日志统计/实时跟随/完整QQ消息适配、E7 2C/图片均未扩入。

部署与收尾结果将在完成后以当前事实更新本段。
