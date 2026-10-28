# DSH接入参考、B站插件与工作树需求核实

日期：2026-10-28（Asia/Shanghai）。源码基点：`0548fe7`。状态：处理中（N23需求协商，尚未实施）。归属[文档28](../../28_本机编码工具委托与实验任务.md)，由[验证索引](../INDEX.md)的本目录条目覆盖。

## 用户决定与待定项

- 主人确认两期范围：编码/实验与主机只读查询在首期，项目外普通文件、软件安装等系统修改在第二期；此前确认记录继续保留。
- 优先调查DSH作为执行工具，并寻找记忆中的SnowLuma/qq-bridge方案。首期只需一个通道跑通，可在DSH、Claude桌面/CLI、Codex桌面/CLI等现有候选中选择，不要求全部接入。
- 代码任务采用Git worktree和任务分支，自主修改、检查与建立本地恢复点，验证后可合入项目Git；push必须主人明确同意。工作树不自带自动回档，需要任务系统实现。
- 合入是否等待主人确认、主目录未提交修改的基线、无Git实验目录策略、项目依赖安装与联网范围仍待协商。未把这些候选默认值写成用户已经批准的执行规则。

## QQ–SnowLuma–DSH项目

找到[Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)，取证提交为`a49877f4e58d04e47532d44b803360d0f001160d`。只读`/home/afrangry/kurumi-archive/qq-bridge`的upstream确认也是该URL，封存代码未改动或启动。

上游[README](https://github.com/Derpyu520/qq-bridge/blob/a49877f4e58d04e47532d44b803360d0f001160d/README.md)描述QQ经SnowLuma与bridge进入DSH Web API；提供事件、提问和工具审批转发。其[DSH客户端](https://github.com/Derpyu520/qq-bridge/blob/a49877f4e58d04e47532d44b803360d0f001160d/src/dsh-client.js)包含会话创建/投递/取消、事件订阅和认证处理，可作为协议参考。

本机只读程序包确认DSH为`0.2.0-rc.2`；上游声明面向`0.2.1-rc.2`并兼容`0.2.0-rc.2`，属于上游兼容说明，不是本机测试结论。本机程序包README列出headless、SDK和ACP profiles，可与Web API比较。没有启动任何profile或读取服务认证/会话资料。

候选结构保留Fusion唯一QQ入口，再由Fusion委托DSH；不把找到旧bridge解释成应恢复第二个QQ消费者。当前仓库对唯一入口的约束见[架构手册](../../9_QQ融合助手架构与开发计划.md#架构决定)。具体选用Web API、CLI、SDK还是ACP尚未确定。

## B站“鱼灾”与插件机制

[爱范儿/APPSO报道的凤凰网刊载页](https://tech.ifeng.com/c/8xSXpkNB7YG)日期为2026-10-23，报道B站AI“大肥鱼”评论并指向`c1overzz/dsh-bili-scroll`。可确认该现象有报道及对应开源项目；不能从报道证明所有相关账号都由同一插件驱动。

核对项目[README](https://github.com/c1overzz/dsh-bili-scroll)及提交`2c7b3f14f525360f8657b102ec453fd8f02baf3a`的以下源码：

- [index.js](https://github.com/c1overzz/dsh-bili-scroll/blob/2c7b3f14f525360f8657b102ec453fd8f02baf3a/index.js)：注册B站工具、设置和定时触发，启动指定profile的headless子进程执行巡览任务；评论开关影响本轮可见工具。
- [lib/mcp.mjs](https://github.com/c1overzz/dsh-bili-scroll/blob/2c7b3f14f525360f8657b102ec453fd8f02baf3a/lib/mcp.mjs)：启动内置Python MCP，通过stdio JSON-RPC进行初始化和工具调用。
- [vendor/bilibili-mcp/mcp_server.py](https://github.com/c1overzz/dsh-bili-scroll/blob/2c7b3f14f525360f8657b102ec453fd8f02baf3a/vendor/bilibili-mcp/mcp_server.py)：以`bilibili-api-python`和账号凭证接入B站数据与互动接口；实际读取的是字幕、评论和可获取的画面等材料。

它的工作链为定时/手动触发 → DSH会话 → B站MCP工具 → 检索、读取材料并生成日报；开启相应互动后，使用已登录账号发评论等。无需以模拟点击浏览器作为这条实现的前提；模型负责选择和生成，账号登录、工具与调度负责执行。源码中有专用profile和工具白名单设计，但这次没有运行或验证其隔离效果。

另有[annasleepy/dsh-bili-interact](https://github.com/annasleepy/dsh-bili-interact)，取证提交`d7b2a55b0b43af0985a00da40d3abc4a71bcd305`。其[index.js](https://github.com/annasleepy/dsh-bili-interact/blob/d7b2a55b0b43af0985a00da40d3abc4a71bcd305/index.js)提供互动工具与写入开关，[Python实现](https://github.com/annasleepy/dsh-bili-interact/blob/d7b2a55b0b43af0985a00da40d3abc4a71bcd305/python/bili_write.py)复用前述插件的登录凭证并调用B站接口。它是补充互动能力的另一插件，不是浏览所必需的同一组件。

这次核实支持“执行工具可通过插件与外部服务交互”的判断；不证明只接入DSH即可自动获得B站能力。本需求未新增B站开发，也未安装插件、访问本人B站账号或触发互动。

## 工作树方案的具体含义

[Git官方worktree文档](https://git-scm.com/docs/git-worktree)说明多个工作树属于同一仓库并可检出不同分支。隔离代码修改和选择恢复点可据此设计；自动恢复、测试判定、未提交产物保留、合入和外部副作用处理仍需要任务流程实现。没有Git的目录需要另定策略，不能承诺原地直接创建Git worktree。

## 验证范围

本次只读公开页面、公开源码和本机程序说明，并更新需求文档。未执行外部仓库的安装或脚本；未调用DSH模型/接口、启停服务、改权限、操作真实任务工作树、回档用户项目、合入业务代码、外发消息或推送远端。

- `node scripts/fusion/evidence-coverage.mjs`通过，650份证据均有明确归属。
- `node scripts/fusion/evidence-index.mjs --check-markdown`通过，212项脚本归属与已保存索引一致；归属规则未改动。
- 本地链接检查覆盖117份文档、2082处本地链接，缺失文件、锚点和未闭合围栏均为0；`git diff --check`通过。
- 四项只读自检从日常源码目录执行通过：`health.mjs`、`verify-dependencies.mjs`、`sync-config.mjs --diff`、`sync-persona.mjs --diff`。无`--apply`；不保存健康输出中的私密任务标识，也不将这些检查作为业务功能验收。

文档在独立worktree本地提交后以`--ff-only`合入日常源码目录。合入前已有另一项工作留下的16个变更路径，逐文件哈希保护核对；不覆盖、不暂存这些并行改动。本地合入不包含远端推送。
