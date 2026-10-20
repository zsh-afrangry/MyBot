# 文档25 · P2记忆与会话连续性

需求、决定、实现和当前边界见[文档25第10节](../../../25_人格、记忆与会话连续性.md#10-p2记忆与会话连续性)。本目录只保存P2证据；隔离验收、生产迁移、定向配置同步和恢复材料分别记录，不能把材料模式恢复扩大解释为真实QQ或全业务验收。

## 证据

| 文件 | 结论 |
| --- | --- |
| [hook-probe.json](hook-probe.json) | 初次隔离探查8/8；真实模型分支在I/O前拒绝，真实API调用为0。保留作研究记录。 |
| [hook-probe-final.json](hook-probe-final.json) | 确定性模型下再次8/8；记录 reply_dispatch、before_prompt_build、agent_end 和 /new 生命周期。 |
| [hook-lifecycle.json](hook-lifecycle.json) | 首次扩展宿主失败；临时配置使用已废弃的 reserveTokens，0模型请求，非生产故障。 |
| [hook-lifecycle-fixed.json](hook-lifecycle-fixed.json) | 修正配置后扩展调查12/12；覆盖本人/成员 /new、手动压缩、压缩后续聊和临时宿主重启。 |
| [preflight-checks.json](preflight-checks.json) | P2前后只读保护检查；不代表生产迁移。 |
| [memory-continuity-host.json](memory-continuity-host.json)、[v2](memory-continuity-host-v2.json) | 早期夹具把直接 kurumi_memory 当成可见工具，首个主人自动保存场景未完成；失败回执保留。 |
| [memory-continuity-host-v3.json](memory-continuity-host-v3.json) | 修正了工具搜索流程前的夹具仍将搜索结果误判为新请求，反复搜索触发模型请求预算；非产品故障。 |
| [memory-continuity-host-v4.json](memory-continuity-host-v4.json) | 已成功走 tool_search → tool_call 并完成写入，但断言错误地要求压缩工具列表直接包含 kurumi_memory；非产品故障。 |
| [memory-continuity-host-v5.json](memory-continuity-host-v5.json) | 最终真实隔离宿主证据：4/4场景、6次确定性模型请求通过，工具搜索/包装调用、SQLite写入、/new后注入和成员隔离均核对。 |
| [recovery-verify.json](recovery-verify.json) | 使用 `/home/afrangry/kurumi-backups/2026-10-19-17-02-19-p2-memory-closeout/` 的材料模式隔离恢复；manifest、15个SQLite、必需内容及连续性读取共 **19/19** 通过，无生产服务或真实QQ。 |

## 最终验收范围

脚本为 chatbot/tests/persona/memory-continuity-host.mjs，使用真实本机 OpenClaw 与 kurumi-memory/kurumi-qq 插件、确定性本地模型和模拟 OneBot；每次必须指定新的绝对 --out，只写临时状态和本证据文件，不访问生产会话/记忆，不调用真实API、QQ或邮件，不重启生产服务。

离线入口为 chatbot/tests/persona/memory.test.mjs，覆盖迁移、SQLite CAS、并发、来源/凭证校验、摘要TTL、遗忘屏障、成员拒绝、异步 Store 拒绝和跨边界凭证标记。迁移入口为 chatbot/scripts/memory-migrate.mjs，默认预览，--apply 才写私密备份和运行状态。

最终宿主场景：

1. 主人当前原文自动保存稳定偏好，保存事实和 revision 可读回；
2. 主人后续回合收到有限个人上下文，并可通过 tool_search → tool_call 到达记忆工具；
3. /new 后旧聊天哨兵消失，但有效长期事实仍注入；
4. 成员收到共享人格但没有主人事实、摘要或 kurumi_memory 能力。

## 已核实的宿主边界

- QQ的 before_prompt_build 没有可靠的 currentUserMessage/currentUserMessageId；当前原文必须从可信 reply_dispatch 入站记录取得。
- /new 前后 sessionId 可以不变，OpenClaw通过生命周期版本清理历史；不能只用固定 sessionKey 判断旧写入是否仍有效。
- 压缩钩子没有足够的 sender、runId 或 tool authority 字段，不能单独授予写权限；连续性写入必须绑定当前入站、实际 runId、sessionId 和宿主授权。
- 工具搜索模式隐藏普通工具 schema，正确调用路径是先搜索，再用精确工具名/ID调用；直接要求模型看到 kurumi_memory 会造成假阴性测试。

## 已完成的生产步骤与仍未覆盖范围

- 已完成：预览和`memory-migrate.mjs --apply`迁移主人原有6条长期事实；迁移前原文与运行配置均在`.openclaw-fusion/migration/before-memory-p2-2026-10-19T16-53-12-652Z/`私密保存。生产配置已定向更新并热加载，主人受管AGENTS已同步，四项只读自检通过。
- 已完成：`backup-state.mjs`生成非停写材料 `/home/afrangry/kurumi-backups/2026-10-19-17-02-19-p2-memory-closeout/`，15/15 SQLite快照包含连续性库；`quiesced=false`，不表示跨库同一瞬间停写。该最新材料的隔离恢复 **19/19** 通过，报告见[recovery-verify.json](recovery-verify.json)。
- 恢复验收器曾把迁移后的固定说明文本误报为缺少revision（18/19）；现已补充从恢复副本`memory_state`读取revision，并在本次最新材料上复验为19/19。修复只改验收器，不改生产记忆。
- 仍未验证宿主自动阈值压缩、真实模型对自动归纳质量的判断、真人QQ体感或生产停写恢复。成员仍没有主人记忆；P3持久情绪、P4日记/主动联系未实施。

这些限制是当前验收边界，不把12/12或4/4扩展解释为生产功能全量通过。
