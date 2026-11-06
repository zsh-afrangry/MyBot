# 文档25 · P2记忆与会话连续性

需求、决定、实现和当前边界见[文档25第10节](../../../25_人格、记忆与会话连续性.md#10-p2记忆与会话连续性)及[第11节实聊补正](../../../25_人格、记忆与会话连续性.md#11-p2真人qq复验与工具契约补正2026-10-20)。本目录只保存P2证据；隔离验收、真实模型、真人QQ、生产迁移、加载和恢复材料分别记录，不能把材料模式恢复扩大解释为全业务验收。

## 证据

| 文件 | 结论 |
| --- | --- |
| [hook-probe.json（历史材料）](README.md#historical-material) | 初次隔离探查8/8；真实模型分支在I/O前拒绝，真实API调用为0。保留作研究记录。 |
| [hook-probe-final.json（历史材料）](README.md#historical-material) | 确定性模型下再次8/8；记录 reply_dispatch、before_prompt_build、agent_end 和 /new 生命周期。 |
| [hook-lifecycle.json（历史材料）](README.md#historical-material) | 首次扩展宿主失败；临时配置使用已废弃的 reserveTokens，0模型请求，非生产故障。 |
| [hook-lifecycle-fixed.json（历史材料）](README.md#historical-material) | 修正配置后扩展调查12/12；覆盖本人/成员 /new、手动压缩、压缩后续聊和临时宿主重启。 |
| [preflight-checks.json（历史材料）](README.md#historical-material) | P2前后只读保护检查；不代表生产迁移。 |
| [memory-continuity-host.json（历史材料）](README.md#historical-material)、[v2（历史材料）](README.md#historical-material) | 早期夹具把直接 kurumi_memory 当成可见工具，首个主人自动保存场景未完成；失败回执保留。 |
| [memory-continuity-host-v3.json（历史材料）](README.md#historical-material) | 修正了工具搜索流程前的夹具仍将搜索结果误判为新请求，反复搜索触发模型请求预算；非产品故障。 |
| [memory-continuity-host-v4.json（历史材料）](README.md#historical-material) | 已成功走 tool_search → tool_call 并完成写入，但断言错误地要求压缩工具列表直接包含 kurumi_memory；非产品故障。 |
| [memory-continuity-host-v5.json（历史材料）](README.md#historical-material) | 最终真实隔离宿主证据：4/4场景、6次确定性模型请求通过，工具搜索/包装调用、SQLite写入、/new后注入和成员隔离均核对。 |
| [recovery-verify.json（历史材料）](README.md#historical-material) | 使用 `/home/afrangry/kurumi-backups/2026-10-19-17-02-19-p2-memory-closeout/` 的材料模式隔离恢复；manifest、15个SQLite、必需内容及连续性读取共 **19/19** 通过，无生产服务或真实QQ。 |
| [recovery-verify-2026-10-22-quiesced.json（历史材料）](README.md#historical-material) | 2026-10-22 主人授权的停写点 `/home/afrangry/kurumi-backups/2026-10-22-10-57-25-e1-memory-recovery/`（`quiesced=true`，服务停约35秒后恢复）；完整模式隔离恢复 **26/26** 通过，隔离Gateway与14插件加载，恢复副本revision=29、4条事实；只含Fusion材料。 |
| [memory-continuity-host-2026-10-22-c12.json（历史材料）](README.md#historical-material) | `kurumi-memory` manifest补字段后的复跑：真实隔离宿主按仓库manifest加载插件，确定性模型10/10场景、20次请求通过；无真实API/QQ。 |
| [memory-contract-before.tap（历史材料）](README.md#historical-material) | 工具契约补正前17项中14通过、3个新增回归按预期失败：误导错误、跨action误参和读接口忽略写字段。 |
| [memory-contract-after.tap（历史材料）](README.md#historical-material)、[memory-contract-regression.tap（历史材料）](README.md#historical-material) | 首次修复44/44、扩展95/95；含旧显式模式、人格、权限与适配器。最终代码回归见下方补正记录，不相加计数。 |
| [memory-contract-host.json（历史材料）](README.md#historical-material) | 扩展后的真实隔离宿主10/10，20次确定性请求；包含描述、故意误参零提交、同消息修参成功、同ID更正、三次重开读取与成员隔离。 |
| [memory-contract-live.json（历史材料）](README.md#historical-material) | 首次真实DeepSeek的9个场景完成，22请求、工具错误0；最终断言把无关“绿茶”误判为书签颜色残留，保留该测试误判原回执。 |
| [memory-contract-live-verified.json（历史材料）](README.md#historical-material) | 修正颜色字断言后10/10、24次真实请求、工具错误0；仍带控制标记，不能作为普通陈述选observe的证据。 |
| [memory-contract-live-natural.json（历史材料）](README.md#historical-material) | 移除控制标记并检查action后，3次真实请求复现普通陈述用了显式upsert；引出本轮自动/显式选择指导补正，不当作通过。 |
| [memory-contract-live-final.json（历史材料）](README.md#historical-material) | 自动observe已通过；去标记后的旧只读夹具为空，被入口拒绝，属验收器缺少自然问句。已补齐问句和非空守卫，最终结果见closeout。 |
| [memory-contract-final-regression.tap（历史材料）](README.md#historical-material)、[memory-contract-host-final.json（历史材料）](README.md#historical-material) | 最终代码离线 **95/95**；真实隔离宿主/确定性模型 **10/10**、20请求。误参不写状态/回执、同消息修参、成功后变参拒绝及完整更正/遗忘覆盖。 |
| [memory-contract-live-closeout.json（历史材料）](README.md#historical-material) | 最终自然表达/官方DeepSeek **10/10**、22请求、工具错误0；普通偏好observe，显式保存/同ID更正upsert，遗忘delete；蓝/绿重开独立问答、最终不知道及成员隔离通过。 |
| [memory-contract-preflight.json（历史材料）](README.md#historical-material)、[memory-contract-reload.json（历史材料）](README.md#historical-material) | 加载前私密状态的摘要指纹；21:53:58 +08仅热重载kurumi-memory，运行generation 3→4、无需重启、无警告。 |
| [memory-contract-deployment-initial.json（历史材料）](README.md#historical-material)、[memory-contract-deployment.json（历史材料）](README.md#historical-material) | 首份验收器误读顶层state=enabled，加载状态实际为runtime.state=active；更正后11项核验全过。工具/参数描述与源码一致、12份投影对齐，生产记忆/配置/Cron/出站和服务PID不变。 |
| [memory-contract-selfchecks.json（历史材料）](README.md#historical-material) | 补正加载及主人AGENTS同步后的健康、依赖、配置、人格四项自检全过，QQ在线、testIngress=false。 |
| [memory-contract-validation.json（历史材料）](README.md#historical-material) | 本轮收录前的证据分类、脚本boundary、修改Markdown本地目标/围栏、私密值泄漏及diff格式检查；不包含远端URL和页内锚点核验。 |
| [memory-contract-qq-2241.json（历史材料）](README.md#historical-material) | `2ba0308`修复版22:41:03–22:42:14真人QQ显式保存/同ID更正/遗忘及三次重开问答通过；首次漏版本被拒后模型自行读取重试成功。最终13/5、原6条完整事实不变，测试条目已删除。仅原生日志定位和脱敏结论，无聊天正文。 |
| [compaction-host.json（历史材料）](README.md#historical-material) | E1宿主自动压缩 **6/6** 变体通过（确定性模型、隔离状态，待复验）：A/A2 token阈值触发、摘要进入后续输入、同sessionId、临时重启后保留、个人记忆不变且成员隔离、flush请求0；A3加载memory-core时flush被派发但messaging工具策略下无写工具而失败；B transcript字节阈值触发；C生产默认模式无质量守卫、畸形摘要原样被采用；C2 safeguard模式守卫重试后取消，之后主人回合无回复。 |

TAP证据仅规范行尾空白以通过Git格式检查（修复前回执4行），不改变测试结论、断言或诊断内容。

## 最终验收范围

脚本为 [memory-continuity-host.mjs](../../../../chatbot/tests/persona/memory-continuity-host.mjs)，使用真实本机OpenClaw与kurumi-memory/kurumi-qq插件、独立SQLite和模拟OneBot。默认确定性本地模型，显式`--live`调用配置的官方DeepSeek（上限40次请求、每次1200输出tokens）；每次必须指定新的绝对`--out`。真实模型只接收合成数据，凭据只从运行私密环境读取，不读取生产聊天/记忆，不调用真实QQ或邮件，不重启生产服务。离线/确定性/真实模型/用户QQ试聊分别记录。

离线入口为 chatbot/tests/persona/memory.test.mjs，覆盖迁移、SQLite CAS、并发、来源/凭证校验、摘要TTL、遗忘屏障、成员拒绝、异步 Store 拒绝和跨边界凭证标记。迁移入口为 chatbot/scripts/memory-migrate.mjs，默认预览，--apply 才写私密备份和运行状态。

本轮95项回归的复现命令（仓库根目录）：

```bash
node --test chatbot/plugins/kurumi-memory/test/*.test.js \
  chatbot/tests/access-control/*.test.mjs \
  chatbot/tests/domain-adapters/*.test.mjs \
  chatbot/tests/persona/*.test.mjs
```

宿主验收运行`node chatbot/tests/persona/memory-continuity-host.mjs --out <新的绝对JSON路径>`；加`--live`才调用付费模型。默认确定性分支的`toolErrors=1`是刻意注入的误参，后续已验证零提交及修正成功，不与最终真实模型的`toolErrors=0`混淆。

初版v5的4个宿主场景：

1. 主人当前原文自动保存稳定偏好，保存事实和 revision 可读回；
2. 主人后续回合收到有限个人上下文，并可通过 tool_search → tool_call 到达记忆工具；
3. /new 后旧聊天哨兵消失，但有效长期事实仍注入；
4. 成员收到共享人格但没有主人事实、摘要或 kurumi_memory 能力。

工具契约补正把宿主验收扩展为10个场景：在以上基础上增加显式保存、重开后蓝色读回、同ID更正、重开后绿色读回、遗忘和重开后不再知道。默认分支故意发一次错误的`upsert + facts`，验证当前revision及数据库没有变化后在同一消息修参重试；真实模型分支不注入该错误，使用自然表达并核对普通偏好实际调用`observe`。真人QQ两轮只读复核的时间、定位与未覆盖范围统一见[文档25第11节](../../../25_人格、记忆与会话连续性.md#11-p2真人qq复验与工具契约补正2026-10-20)，不复制原聊天。

## 已核实的宿主边界

- QQ的 before_prompt_build 没有可靠的 currentUserMessage/currentUserMessageId；当前原文必须从可信 reply_dispatch 入站记录取得。
- /new 前后 sessionId 可以不变，OpenClaw通过生命周期版本清理历史；不能只用固定 sessionKey 判断旧写入是否仍有效。
- 压缩钩子没有足够的 sender、runId 或 tool authority 字段，不能单独授予写权限；连续性写入必须绑定当前入站、实际 runId、sessionId 和宿主授权。
- 工具搜索模式隐藏普通工具 schema，正确调用路径是先搜索，再用精确工具名/ID调用；直接要求模型看到 kurumi_memory 会造成假阴性测试。

## 已完成的生产步骤与仍未覆盖范围

- 已完成：预览和`memory-migrate.mjs --apply`迁移主人原有6条长期事实；迁移前原文与运行配置均在`.openclaw-fusion/migration/before-memory-p2-2026-10-19T16-53-12-652Z/`私密保存。生产配置已定向更新并热加载，主人受管AGENTS已同步，四项只读自检通过。
- 已完成：`backup-state.mjs`生成非停写材料 `/home/afrangry/kurumi-backups/2026-10-19-17-02-19-p2-memory-closeout/`，15/15 SQLite快照包含连续性库；`quiesced=false`，不表示跨库同一瞬间停写。该最新材料的隔离恢复 **19/19** 通过，报告见[recovery-verify.json（历史材料）](README.md#historical-material)。
- 恢复验收器曾把迁移后的固定说明文本误报为缺少revision（18/19）；现已补充从恢复副本`memory_state`读取revision，并在本次最新材料上复验为19/19。修复只改验收器，不改生产记忆。
- 工具契约补正已按上述回执热重载，主人AGENTS定向同步；最终真实模型合成样本10/10通过。部署时生产6条事实和完整状态指纹未变，没有真实QQ/邮件外发或生产记忆写入；随后用户本人22:41实测产生3次合法提交，现revision=13/generation=5。显式闭环及版本缺失后的自动恢复均核实，原6条完整事实未变；19:59/21:08两轮仍为补正前证据，不混同计数。
- 宿主自动阈值压缩已由[compaction-host.mjs](../../../../chatbot/tests/persona/compaction-host.mjs)在隔离宿主覆盖（见上表，待复验）；生产真实长会话触发仍未观察。
- 仍未验证长期自动归纳/陪伴体感或生产停写恢复；22:41的显式用例不替代新的普通陈述observe验收。成员仍没有主人记忆，P3持久情绪、P4日记/主动联系未实施。未重打备份，19/19恢复只证明原材料版本，不包含本轮代码补正。

这些限制是当前验收边界，不把12/12或4/4扩展解释为生产功能全量通过。

<a id="historical-material"></a>

## 历史原始材料的保留位置

本目录生成的原始回执、日志和图片已退出活动树；既有结论及失败状态不因此改变，也不代表新版已验收。已入Git的内容可用 `git show c849e63:<原仓库相对路径>` 读取；表中的blob标识可核对原始字节。未入Git的临时输出按本次清理授权丢弃。当前执行状态只在全局《整理记录.md》维护。

| 原文件 | 原报告顶层字段（仅摘录） | Git blob |
| --- | --- | --- |
| `compaction-host.json` | passed=True；at=2026-10-21T10:38:20.303Z | `7777fd80f5ba4bedff0589ffa095f3ad2489d8b4` |
| `hook-lifecycle-fixed.json` | passed=True；at=2026-10-19T16:18:30.696Z | `f537f3969e2cecf55fe6a40038ff6b00116ff22a` |
| `hook-lifecycle.json` | passed=False；at=2026-10-19T16:18:04.093Z | `c25caf3f658e7874f1688a418989dfcfe7b22948` |
| `hook-probe-final.json` | passed=True；at=2026-10-19T16:12:12.430Z | `b1dd25a70021765aabc3f706ad95e1a2bb4fac33` |
| `hook-probe.json` | passed=True；at=2026-10-19T16:11:28.433Z | `5bb635d18fef80413dba26989550e45e0752acb5` |
| `memory-continuity-host-2026-10-22-c12.json` | passed=True；at=2026-10-22T10:50:39.092Z | `8ed11ab5caed0ba137aad1ee4d6eb50bcba81968` |
| `memory-continuity-host-v2.json` | passed=False；at=2026-10-19T16:42:32.221Z | `ed46c00d0ea535dddae192a05c4a96a32649df81` |
| `memory-continuity-host-v3.json` | passed=False；at=2026-10-19T16:43:06.641Z | `b2a92ab0da47ada5fde26745bcb33cadba78ee08` |
| `memory-continuity-host-v4.json` | passed=False；at=2026-10-19T16:46:19.348Z | `2888588d67ee69c5b963cd44e8e059ebc45b5457` |
| `memory-continuity-host-v5.json` | passed=True；at=2026-10-19T16:47:02.755Z | `4ea2e2ea1ed0f31acb011f5910d2e4ebaac988c4` |
| `memory-continuity-host.json` | passed=False；at=2026-10-19T16:41:37.400Z | `797ee984d0783bc75c4a2178ebc87f7885444e3a` |
| `memory-contract-after.tap` | 未提取；以原材料及现有结论为准 | `5f00f162e0b8f6c6bd6be55bfb61320a5756c249` |
| `memory-contract-before.tap` | 未提取；以原材料及现有结论为准 | `05da87421b6448759cda77670cc334f812b1023e` |
| `memory-contract-deployment-initial.json` | ok=False；at=2026-10-20T13:57:51.583Z | `463affb5a0bb6216237cfeca325838ec8458777e` |
| `memory-contract-deployment.json` | ok=True；at=2026-10-20T13:58:26.411Z | `79dac4cd0aa2d2fe280004925fd09501a3f0f587` |
| `memory-contract-final-regression.tap` | 未提取；以原材料及现有结论为准 | `5e67dc6c04dc9a8584dc258304488ad8715c961d` |
| `memory-contract-host-final.json` | passed=True；at=2026-10-20T13:50:31.421Z | `61f752459567fa876498904e85361c0561cec6e2` |
| `memory-contract-host.json` | passed=True；at=2026-10-20T13:41:12.110Z | `90213b5c0c7f8b31abe00867e9da1c20566f575e` |
| `memory-contract-live-closeout.json` | passed=True；at=2026-10-20T13:52:15.631Z | `7e916e58719a6ec4b6568e0a3cbf1ce0e1cfc7d9` |
| `memory-contract-live-final.json` | passed=False；at=2026-10-20T13:49:59.220Z | `2d42c2bc4c88cbbbe52aa604b216ff88c7d6b6c0` |
| `memory-contract-live-natural.json` | passed=False；at=2026-10-20T13:47:26.188Z | `70be80b04e7a8bb20b38a657a42d999cddaa30fb` |
| `memory-contract-live-verified.json` | passed=True；at=2026-10-20T13:43:58.913Z | `a68ffc165ca51bfdbd9e09ba05270b6d68b04e0c` |
| `memory-contract-live.json` | passed=False；at=2026-10-20T13:41:57.634Z | `3eb3effa76fb695bbf0c0313a43f5c35a628265a` |
| `memory-contract-preflight.json` | at=2026-10-20T13:48:21.798Z | `1d7008b4a7761c7ef2dd1e7e432d01a88d84d778` |
| `memory-contract-qq-2241.json` | passed=True；at=2026-10-20T14:45:16.631Z | `fa8116b3d54911f4c25ee43b2d9ae84c9d57c335` |
| `memory-contract-regression.tap` | 未提取；以原材料及现有结论为准 | `fdc34613228487babb47ae736f99d7197be411ae` |
| `memory-contract-reload.json` | at=2026-10-20T13:53:58.548Z | `90e1c4626ea671666c4d2678cfbedc966c6b923e` |
| `memory-contract-selfchecks.json` | ok=True；at=2026-10-20T13:57:24.019Z | `40b00a791c3e90306a134d01f03365d9533a1c56` |
| `memory-contract-validation.json` | ok=True；at=2026-10-20T14:05:51.283454+00:00 | `14ee536796cc9f275aa8732e43269b6adb959c1d` |
| `preflight-checks.json` | at=2026-10-19T16:20:03.692Z | `ad253fe414d28a27103ce1e4a59944642bf10a28` |
| `recovery-verify-2026-10-22-quiesced.json` | ok=True；passed=26 | `e8d1966b2acf0b2b676f248c36e18960bdac3da9` |
| `recovery-verify.json` | exitCode=0 | `76130e15a00612e7279e4c2d63c7fcca7079e12f` |
| `startup-error.txt` | 未提取；以原材料及现有结论为准 | `9aaaf1a0d08eae0b555a5617848eceb4f96756c9` |
