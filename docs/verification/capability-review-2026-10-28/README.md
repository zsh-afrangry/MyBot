# 能力插件、依赖边界与权限分级复核

日期：2026-10-28（Asia/Shanghai）。检查基线：`0dd547a`；开始时主工作区干净。规则归属：[21](../../21_后端职责分层与代码整理.md)、[24](../../24_统一身份与权限管理.md)、[27](../../27_E7数据插件设计.md)。验收结论归[16](../../16_验收与测试总表.md)。

用户要求检查现有能力和工具是否插件化、解耦和分级，符合预期后准备E7第二阶段。结论：**当前结构符合既定边界，没有发现必须先重构才能扩展E7的阻碍**。该结论由源码、同一基线的离线回归、真实隔离宿主及生产只读元数据共同支持；本次不重放真实模型、QQ、SMTP或全部业务。

## 检查结果

| 检查项 | 结果与依据 |
| --- | --- |
| 插件装配 | 本地15份manifest；生产启用14个本地插件及Tavily，15个均为active。manifest声明工具或provider，工具归属见[生产目录（历史材料）](README.md#historical-material) |
| 独立生命周期 | 四个个人领域全开及分别禁用共5组真实Gateway通过；禁用某领域不移除其它领域工具/确认后端。E7启用/禁用2组通过，启动无首次抓取并正常停止。论文异步stop、邮件确认注册注销在本轮离线宿主服务管理器回归中覆盖 |
| 依赖方向 | 扫描152个非生成生产JS/TS文件，无共享包反向导入插件/部署脚本。仅一处跨插件直接导入：论文组合入口→QQ公开`delivery.js`；没有导入其它插件`src`。静态字面量扫描范围见[依赖检查（历史材料）](README.md#historical-material)，不当作任意动态数据流证明 |
| 后端分层 | 共享能力归packages；E7分别由index/service/query/policy/client/store注册、编排、投影、约束、取数和缓存。需要替换的Policy/Store在组合入口选择，知识图谱走显式异步HTTP边界 |
| 适配器一致性 | 替换策略/存储覆盖工具、调度器和固定runner；未知实现拒绝，不静默回退。同步Store拒绝Promise，失败回滚与revision/事务/幂等回归通过。同步注册机制不承诺所有异步后端可直接替换 |
| 身份分级 | 唯一授权来源编译为运行策略；owner、两个member及其Agent/会话边界保留，群聊关闭。生产策略本地求值确认E7六类action仅owner获准，成员拒绝；没有执行真实业务调用 |
| 操作与执行分级 | 读取、维护、邮件发送、后台研究/代码、管理命令各有权限映射；未知工具/action拒绝。宿主强制策略覆盖动态工具内层调用，领域执行处复核；后台只接受已登记委托通道 |
| 确认与直接维护 | 一次性提醒、Profile/行程及邮件发送经共享确认层；列表、账单的明确维护按现行规则执行。回归检查预览回执、当前请求、有效期及事务消费，不将所有写入强行改为同一种确认方式 |
| 受限能力 | main的read/write/edit/apply_patch/exec/process/message/sessions_spawn仍禁用；E7无发图权限。`testIngress=false`，未知工具、尚未实现的E7 action和e7_image在实际生产策略求值中均拒绝 |
| 配置与运行 | 健康、固定依赖、配置和人格四项检查通过；只读元数据与离线检查摘要见[checks.json（历史材料）](README.md#historical-material) |

工具目录的`includePlugins`会列出未授权或仅后台使用的已安装工具，目录出现名称不代表该身份可执行。权限依据仍是Agent上限、强制宿主策略与领域检查。

## 验证与复现

先按以下顺序构建，均退出0：

```bash
npm --prefix chatbot/packages/confirmation-core run build
npm --prefix chatbot/plugins/personal-confirmation run build
node chatbot/scripts/build-personal-plugins.mjs
npm --prefix chatbot/plugins/kurumi-e7 run build
```

同一基线的离线回归共377项，均通过、无跳过。这里只合计本次四组互不重复的用例入口，不与历史报告数量累加。

| 回归入口 | 通过 |
| --- | ---: |
| `node --test chatbot/tests/backend-boundaries/*.test.mjs chatbot/tests/domain-adapters/*.test.mjs chatbot/tests/access-control/*.test.mjs chatbot/tests/e7/*.test.mjs` | 97 |
| `node --test chatbot/plugins/kurumi-qq/test/*.test.js chatbot/tests/knowledgemap/*.test.mjs chatbot/tests/web-deepseek/*.test.mjs` | 72 |
| `npm --prefix chatbot/packages/confirmation-core test` | 46 |
| `npm --prefix chatbot/packages/personal-domains test` | 162 |

另有7组真实隔离Gateway配置验证，均使用临时状态、合成身份、无模型/API/QQ/SMTP，不重启生产：

```bash
node chatbot/tests/backend-boundaries/acceptance-capabilities-host.mjs --out /absolute/new/domains-host.json
node chatbot/tests/e7/acceptance-host.mjs --out /absolute/new/e7-host.json
```

回执：[四领域5组（历史材料）](README.md#historical-material)、[E7两组（历史材料）](README.md#historical-material)。生产使用`plugins.list`和`tools.catalog`只读取元数据，并对内存中的当前授权策略求值；[production-catalog.json（历史材料）](README.md#historical-material)不含身份号码、凭据或聊天内容。[checks.json（历史材料）](README.md#historical-material)保留命令、摘要、版本及相关源码哈希；完整私密运行配置不进入仓库。

## 保留的耦合与未覆盖范围

- 四个个人领域共用`personal-domains`和集中构建；Profile/行程保留历史共库，旧Cron转发地址保留。这些是用户已确认的兼容约束，逻辑启停独立不承诺独立数据库或版本发布。
- 插件依赖固定的OpenClaw SDK，QQ投递依赖公开delivery契约。新E7发图需要先增加公开`sendImage`并测试，不能直接接入QQ内部实现或自行调用OneBot。
- 没有新设全局数值风险等级字段；现有分级由身份、权限/action、确认和后台工具上限具体执行。新增功能继续按同一契约登记，不仅修改提示词。
- 本轮没有重新验收业务内容准确性、长期记忆体验、成员真人往返、付费翻译或全量恢复。文档16的已有待验收项及外部KnowledgeMap问题CR-K01/P1保留原状态；该外部项目问题不是本轮新发现，也不以Fusion结构复核关闭。
- DeepSeek Search/Fetch插件源码及离线provider契约可检查，生产仍使用已配置的检索提供方；回归通过不代表新provider已启用。

## E7首批用户反馈

2026-10-28收尾登记：主人已在本会话确认首批测试无问题。依据此反馈，N20.2及文档16按**已实现的首批文本范围**记为已验收。用户没有逐项列出真人用例，因此不补造查询记录，不推定七个view、异常路径或多工具竞争均已逐一验收。

首批原始记录仍保存2026-10-27取证时的“待本人QQ复验”，不改写冻结证据；最新结论以文档16和此反馈登记为准。兑换码实际兑换、公告PDF正文及E7图片不由该反馈自动通过。

## 第二阶段准备边界

范围选择尚未收到回复，先按第二批文本查询整理可审阅的开发清单，见[27的开发准备](../../27_E7数据插件设计.md#第二批文本查询开发准备)。建议先角色配装/测评，再榜单/攻略/FAQ，最后GVG/宿命/礼包估值；共7个新增action，继续复用原只读工具、client和缓存。

此处完成架构前置检查和开发准备；未增加新action、权限、依赖或生产配置，也未实际外发图片。图片保留N20.3独立任务；若主人选择先做图片，后续按该选择调整开发排期，不将准备顺序视为已批准全部扩展上线。

<a id="historical-material"></a>

## 历史原始材料的保留位置

本目录生成的原始回执、日志和图片已退出活动树；既有结论及失败状态不因此改变，也不代表新版已验收。已入Git的内容可用 `git show c849e63:<原仓库相对路径>` 读取；表中的blob标识可核对原始字节。未入Git的临时输出按本次清理授权丢弃。当前执行状态只在全局《整理记录.md》维护。

| 原文件 | 原报告顶层字段（仅摘录） | Git blob |
| --- | --- | --- |
| `checks.json` | 未提取；以原材料及现有结论为准 | `2dc7f48721e0625f8e76e01e0f47f09b41553230` |
| `domains-host.json` | passed=True；at=2026-10-27T16:30:43.802Z | `c1e66193c64fab338146c2cf8ca001a71a6037ce` |
| `e7-host.json` | passed=True；at=2026-10-27T16:30:43.798Z | `a8455638c9e3786aa9857e99a19f37f9df05e70f` |
| `imports.json` | 未提取；以原材料及现有结论为准 | `08a739bc07286c5fc172373a1b186e9979c8e4e1` |
| `production-catalog.json` | at=2026-10-27T16:31:19.702Z | `4ee7bed4ebae31ffe1d3755e22c313965ae5a199` |
