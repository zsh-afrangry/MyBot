# 基础能力插件边界整理验收

状态：**三项前置、受控加载及文档/索引收尾完成；DeepSeek Search/Fetch仅设计，未接入**。日期：2026-10-20（Asia/Shanghai）。现行结构归[文档21](../../21_后端职责分层与代码整理.md)，下一阶段检索设计归[文档26](../../26_基础能力插件边界整理与检索接入设计.md)，汇总结论见[文档16](../../16_验收与测试总表.md)。

## 范围与结果

本轮授权为：加载已有生命周期修复，整理共享代码归属与论文下载边界，拆分天气容器，完成必要测试、配置同步与Fusion受控重启。原有身份/权限/工具名称、确认格式与持久数据保留；没有数据库schema迁移或SQL。没有新增身份、真实QQ/SMTP外发、付费API请求或远端写入。健康检查只查询本机Gateway、OneBot状态与KnowledgeMap接口。

| 验证 | 结果与边界 | 证据 |
| --- | --- | --- |
| 既有修复加载准备 | 确认核心、确认入口、当时天气包构建成功；实际宿主服务管理器3/3，包含论文清理等待/停止、不重放与邮件注销 | [initial-core-build.txt（历史材料）](README.md#historical-material)、[initial-confirmation-build.txt（历史材料）](README.md#historical-material)、[initial-weather-build.txt（历史材料）](README.md#historical-material)、[initial-lifecycle.txt（历史材料）](README.md#historical-material) |
| 初次受控加载 | 00:26:58重启Fusion，健康通过；源码/构建哈希标识当时工作树 | [initial-loaded.json（历史材料）](README.md#historical-material)、[initial-loaded-health.json（历史材料）](README.md#historical-material) |
| 结构整理初轮 | 边界18/18；后加维护停止等待用例由最终Node回归覆盖，不能将18再加进总数 | [boundary-tests.txt（历史材料）](README.md#historical-material) |
| 默认领域最终构建 | 共享TypeScript构建及旧/新兼容CLI生成成功 | [final-domain-build.txt（历史材料）](README.md#historical-material) |
| Node回归 | 337/337；覆盖原业务、共享依赖、下载/阅读分离、四入口独立注册和真实宿主管理器等待停止 | [node-regression.txt（历史材料）](README.md#historical-material) |
| 默认领域回归 | 162/162，原天气/Profile/行程/一次性提醒行为 | [domain-tests.txt（历史材料）](README.md#historical-material) |
| 通用确认 | 核心19/19、入口15/15 | [core-tests.txt（历史材料）](README.md#historical-material)、[confirmation-tests.txt（历史材料）](README.md#historical-material) |
| 最后授权import复验 | 邮件adapters/tool及并行记忆入口30/30；最后改动为等价共享授权import，不改P2行为 | [final-import-regression.txt（历史材料）](README.md#historical-material) |
| 真实隔离Gateway | 全开、逐个禁用四插件共5/5，RPC核对实际插件状态、工具目录和确认后端。没有模型/上游API/QQ或生产写入 | [isolated-host-final.json（历史材料）](README.md#historical-material) |
| 配置同步契约 | 初始9项自检通过后，新增负向用例发现未校验`plugins.allow`成员；修复后10项通过，覆盖完整live条目保留及未知/禁用/路径/allow成员变更拒绝 | [原始9项结果（历史材料）](README.md#historical-material)、[补充用例失败回执（历史材料）](README.md#historical-material)、[修复后10项结果（历史材料）](README.md#historical-material) |
| 最终生产加载 | 00:51:19显式延期记忆条目后同步，00:51:20重启；本轮核对的七个相关插件（邮件、论文、确认入口和四个领域插件）均active，这不是生产插件总数；四领域工具归属1/3/3/7，11个Cron声明未变，论文仍11项、无在途，搜索仍Tavily | [final-preflight.json（历史材料）](README.md#historical-material)、[final-config-apply.txt（历史材料）](README.md#historical-material)、[final-loaded.json（历史材料）](README.md#historical-material) |
| 四项最终检查 | 退出码均0；QQ在线、testIngress=false、依赖自持、完整配置对齐、12份人格文件对齐 | [final-health.json（历史材料）](README.md#historical-material)、[final-dependencies.txt（历史材料）](README.md#historical-material)、[final-config-check.txt（历史材料）](README.md#historical-material)、[final-persona-check.txt（历史材料）](README.md#historical-material) |
| 收尾元数据 | HEAD、混合工作树、服务启动时间、15个已记录源码/构建指纹仍匹配；不是新停写恢复点 | [closeout-state.json（历史材料）](README.md#historical-material) |
| 索引与文档 | 脚本分类/boundary双向一致、证据全归类；当前规则/本轮报告本地链接及diff格式通过 | [evidence-index.txt（历史材料）](README.md#historical-material)、[evidence-coverage.txt（历史材料）](README.md#historical-material)、[links.json（历史材料）](README.md#historical-material)、[diff-check.txt（历史材料）](README.md#historical-material) |

最终回归合计 **533/533 = Node337 + 默认领域162 + 确认核心19 + 确认入口15**。初轮18项、真实服务管理器用例及末次30项与上述集合有重叠，不重复累计；隔离Gateway5组场景、配置10项自检另列。

## 夹具修正与证据限制

- 初轮夹具曾错误假设“相同所在地一定生成新提案”、拒绝错误码及CLI的usage输出流；按真实契约修正夹具，未放宽业务/授权断言。最终回归均通过，未放宽实现迎合夹具。
- 配置同步收尾复核新增“延期目标必须在`plugins.allow`内”的负向用例。该用例在原实现上失败并保存为`sync-deferral-before.txt`；修复后10项同步自检全部通过，当前代码会拒绝未登记插件。`sync-selftest.txt`保留首次9项回执，不代表修复后的最终状态。
- 第一次隔离Gateway探针未声明启动激活，RPC不存在；第二次错误地只接受SDK状态`disabled`，实际为`unloaded`。失败原回执为[isolated-host.json（历史材料）](README.md#historical-material)、[isolated-host-fixed.json（历史材料）](README.md#historical-material)。最终接受宿主两种非活动状态，但仍要求禁用插件工具与对应确认后端实际消失，兄弟插件仍可用；最终报告5/5。
- `initial-loaded.json` 的 `registrationLogs` 为空，其note提到registered backends不构成注册证据；该文件只证明记录的启动时间与源码哈希。确认后端实际ID通过**隔离Gateway**的RPC核对；生产没有加探针，不宣称在生产直接枚举了确认后端。
- Cron比较按相同字段顺序对每个真实ID的`payload/schedule/delivery/enabled`做SHA256。执行状态与`nextRunAt`会自然推进，不纳入声明不变的断言；没有重建、重放或删除既有Cron。
- 源码哈希和启动时间标识重载的工作树，生产RPC证明活动状态与工具归属；不把健康检查当成真实模型理解或提醒必达证据。
- Git收录前仅规范化本目录文本回执的行尾空白与末尾多余空行；测试条目、通过/失败、时间和计数未改写。

## 并行任务与版本边界

验收取证时HEAD为`9c88003136216d082417290676027b01a40aab69`，领先缓存`origin/main`28个提交，未刷新远端。本轮依赖起点即存在的身份、附件、人格及生命周期等未提交修改；取证时源码新增/移动、测试、配置与文档仍在混合工作树。用户随后授权单独提交本轮变更，重叠文件按代码块提取，不收录并行权限/附件/人格/P2实现；结构整理本地提交为 `8937cae`，收录共享包、下载/阅读、四领域装配、同步补正及其配套测试/配置/文档；起点统一权限、附件、人格/P2及既有生命周期等依赖当时另属并行任务。因此仅检出8937cae不能单独复现本报告或当时生产，原始元数据保留取证时点不改写；构建dist按仓库规则忽略。编辑保护用的`/tmp/kurumi-decoupling-20261020-vqpnmihp/`不是正式生产恢复点，证据不依赖该目录继续存在。

00:51:19本轮使用`--defer-plugin=kurumi-memory`保留完整live记忆条目；00:53:34并行P2任务独立启用了连续性。未回退该变化，也不将其迁移/备份/恢复纳入本轮验收。最终完整配置与人格检查已经通过；开发中一次人格漂移来自并行模板尚未同步，最终结果以上表为准。P2部署与未覆盖项由[文档25](../../25_人格、记忆与会话连续性.md)及其[P2证据](../persona-memory-2026-10-19/p2/README.md)维护。

## 复验入口

在主仓库根目录按锁文件安装依赖后，先构建三个TypeScript包，再跑对应离线测试。以下是当前复验入口；并行新测试可能改变数量，报告533以保存的原始日志为准：

```bash
npm --prefix chatbot/packages/confirmation-core run build
npm --prefix chatbot/plugins/personal-confirmation run build
node chatbot/scripts/build-personal-plugins.mjs
npm --prefix chatbot/packages/confirmation-core test
npm --prefix chatbot/plugins/personal-confirmation test
npm --prefix chatbot/packages/personal-domains test
node --test chatbot/tests/backend-boundaries/*.test.mjs chatbot/tests/papers/source-boundary.test.mjs
node --test chatbot/plugins/*/test/*.test.js chatbot/tests/reminder-list/*.test.mjs chatbot/tests/domain-adapters/*.test.mjs chatbot/tests/access-control/*.test.mjs chatbot/tests/knowledgemap/*.test.mjs chatbot/tests/papers/*.test.mjs scripts/fusion/test/log-query.test.mjs
node --test chatbot/plugins/kurumi-mail/test/adapters.test.js chatbot/plugins/kurumi-mail/test/tool.test.js chatbot/tests/persona/memory.test.mjs
node scripts/fusion/sync-config.mjs --selftest
```

真实隔离宿主脚本`chatbot/tests/backend-boundaries/acceptance-capabilities-host.mjs`须用`--out <新的绝对路径>`，启动临时Gateway、写临时目录和明确证据文件；不覆盖本报告原回执。它没有真实模型、QQ/邮件或上游API，不批量混跑其它acceptance脚本。原生接口与Provider设计见文档26，本轮没有新检索API请求。

## 未覆盖

本轮没有真实模型自然对话、真人QQ/SMTP、付费翻译子进程终止、新DeepSeek Search/Fetch参数或价格验证、完整停写恢复、后台项目副本更新和远端写入。恢复隔离增加Profile的共享API禁用，仅有改写回归，不扩大成全量恢复已通过。保留Profile/行程历史共库和集中构建的共享实现，不宣称四领域具备独立版本/数据库部署能力。

Tavily时间参数、新成员冷启动、渠道冷却和真人体感属于各自任务。当前无需追加新的架构前置；下一步可以按文档26实现并验证一个独立DeepSeek插件内的Search/Fetch provider，复用宿主工具和防护边界。

返回[证据索引](../INDEX.md)。

<a id="historical-material"></a>

## 历史原始材料的保留位置

本目录生成的原始回执、日志和图片已退出活动树；既有结论及失败状态不因此改变，也不代表新版已验收。已入Git的内容可用 `git show c849e63:<原仓库相对路径>` 读取；表中的blob标识可核对原始字节。未入Git的临时输出按本次清理授权丢弃。当前执行状态只在全局《整理记录.md》维护。

| 原文件 | 原报告顶层字段（仅摘录） | Git blob |
| --- | --- | --- |
| `boundary-tests.txt` | 未提取；以原材料及现有结论为准 | `23618a1f8bb6d86f2aea90f88bff182f338442b4` |
| `closeout-state.json` | at=2026-10-19T17:08:40.371208+00:00 | `04c36b3b8b71d92d4c05dfa8eba130cd7ddc4573` |
| `confirmation-tests.txt` | 未提取；以原材料及现有结论为准 | `52429ada738c94d0900ed5260db7d9b78656b438` |
| `core-tests.txt` | 未提取；以原材料及现有结论为准 | `01573d3d15a2c0264ff0010d98840633fd9a5315` |
| `diff-check.txt` | 未提取；以原材料及现有结论为准 | `e69de29bb2d1d6434b8b29ae775ad8c2e48c5391` |
| `domain-tests.txt` | 未提取；以原材料及现有结论为准 | `7ccc09f9cfd9ef6a15b94a9e4a408d82c8d9c50c` |
| `evidence-coverage.txt` | 未提取；以原材料及现有结论为准 | `4135849934c19672c495d4ceb54225eb35c0104d` |
| `evidence-index.txt` | 未提取；以原材料及现有结论为准 | `ce0bc364d2d6adbc4326c2c56d26888266910906` |
| `final-config-apply.txt` | 未提取；以原材料及现有结论为准 | `a26d6415b921186f3a9c4a0aa29271aacdcbddc5` |
| `final-config-check.txt` | 未提取；以原材料及现有结论为准 | `f213f317a97141af0a82ec853632b0f9b6ca0d7f` |
| `final-dependencies.txt` | 未提取；以原材料及现有结论为准 | `622d7148ba3d42c21a3040b46b0a3ffda11e502b` |
| `final-domain-build.txt` | 未提取；以原材料及现有结论为准 | `191a35d8c6270a4753a7fecc4d2f83134c718959` |
| `final-health.json` | ok=True；at=2026-10-19T17:06:03.282Z | `9827542f8a31a9f280a57529c52393208b8e8d9e` |
| `final-import-regression.txt` | 未提取；以原材料及现有结论为准 | `b0501e552831b92b162b05480e56ae7a13136566` |
| `final-loaded.json` | at=2026-10-19T16:56:22.533Z | `dcabf41481123ea86f2b738a39bd1881634ad61d` |
| `final-persona-check.txt` | 未提取；以原材料及现有结论为准 | `97d09eea8194f983110b911d0ef0ac7874c7711a` |
| `final-preflight.json` | at=2026-10-19T16:51:09.579Z | `145a5ec8a0954a3ee9a732448a1104932df3d478` |
| `initial-confirmation-build.txt` | 未提取；以原材料及现有结论为准 | `c0fde78c57d039c78069914b1bfb111d344b3904` |
| `initial-core-build.txt` | 未提取；以原材料及现有结论为准 | `d122bca7ca16e2e371419bd3e21b7fac5f5dd912` |
| `initial-lifecycle.txt` | 未提取；以原材料及现有结论为准 | `8d1013a52f05a5bf1da1ee58d1088f52c479045c` |
| `initial-loaded-health.json` | ok=True；at=2026-10-19T16:27:11.537Z | `15249e9dc968a04eafdb97d141a5776f599457d2` |
| `initial-loaded.json` | 未提取；以原材料及现有结论为准 | `c863062d1c0cdc523f70e4ca57877805f3e5c61e` |
| `initial-weather-build.txt` | 未提取；以原材料及现有结论为准 | `303d41177cb4a73f6a8431d92b76c879a7437f7f` |
| `isolated-host-final.json` | passed=True；at=2026-10-19T16:47:32.540Z | `1454591139571274b61cad161e5542e4133e4cce` |
| `isolated-host-fixed.json` | passed=False；at=2026-10-19T16:46:03.388Z | `eda44399c93e15a21d93cc737944a68527a6225c` |
| `isolated-host.json` | passed=False；at=2026-10-19T16:44:27.158Z | `7effb227dc4935bc60314f20ab9c6fb9293977eb` |
| `links.json` | passed=True；at=2026-10-19T17:17:25.763882+00:00 | `9c3ebbf2799001a912e561932610e79c0f26d6f6` |
| `node-regression.txt` | 未提取；以原材料及现有结论为准 | `8fc0f70aa7942f70397c503f6d60f47b884184b0` |
| `sync-deferral-before.txt` | 未提取；以原材料及现有结论为准 | `dba83c0a1912c211c19f99737cb64fe884139572` |
| `sync-deferral-final.txt` | 未提取；以原材料及现有结论为准 | `6952bd1fe96267577c2c9e2f16882b05623bdbfe` |
| `sync-selftest.txt` | 未提取；以原材料及现有结论为准 | `a37c478eb1d6109704c0fe76e5c2becbc9183346` |
