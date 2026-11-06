# 主人原生exec授权与验证（2026-10-30）

源码起点：`2cc1984ddc9286149001a6525a28664102a8031a`。规则见[文档28](../../../28_本机编码工具委托与实验任务.md#主人原生exec)；验收状态只在[文档16](../../../16_验收与测试总表.md)维护。

## 授权与现象

主人明确要求开放原生`exec`，沿用仅`dsh-pilot`目录的普通文件写入许可。允许通过受管配置同步及Fusion重启落实，成员、后台任务和群聊不扩展。此次不启动、续接、回滚或合入真人任务，不push、不向QQ追加测试消息。

18:16真人目录询问的私有回溯显示，OpenClaw调用的是`kurumi_code`的list/diff，没有运行ls，也没有为这次询问执行DSH。Python产物在任务工作树，尚未进入source；回复需区分这两个位置。原始会话和有限审计回执只保存在私有目录：

`/home/afrangry/.local/share/kurumi-coding-pilot-20261029/reviews/qq-20261030-1816-20261030T102014Z/`。

不将聊天原文或凭据复制到本报告。开放exec后，简单目录与主机查询直接依据命令输出回答；编码仍走独立工作树任务服务。

## 实现与边界

- main白名单增加原生exec，移除main/全局exec deny。身份表revision=5仅向owner显式授予`host.exec`；成员与后台仍保留窄工具上限。
- QQ可信宿主策略先校验身份，再调用共享host-exec参数约束。固定gateway、同步执行、无提权/PTY/模型环境覆盖；默认source，可指定同试点真实目录；单条命令最多60秒。原生full模式免去许可范围内逐命令确认，不冒称Auto review。
- payload在已有Landlock普通文件写入边界内以清空环境的bash运行。工作目录不是隔离；绝对路径、shell串接和子解释器继承实际边界。临时HOME留在试点，不继承Fusion提供商环境。
- 运行目录准备本身也使用受限mkdir，避免父目录符号链接导致宿主先越界创建再报错。该修正与DSH共用，不复制执行隔离逻辑。
- 内核runner报告partial。测试证明所列普通文件操作，不证明网络、进程、元数据及全部系统副作用均隔离。exec可修改试点普通文件，合入确认/push/受管业务等授权限制不能冒称由Landlock完整强制；模型仍遵守独立业务接口与授权。
- 准入审计只含可信关联、权限、允许/拒绝及目录范围；原生命令结果留在私有会话。原生exec失败与DSH ACP额外权限请求分开核对。

## 验证

| 证据 | 证明范围 |
| --- | --- |
| [offline.txt（历史材料）](README.md#historical-material) | 131项离线/本机隔离回归：原生参数与身份、实际目录读写、创建/覆盖/截断/删除/移动/符号链接越界、shell/解释器、环境/提权/超时绕过、运行目录准备；同时回归编码、权限、后端边界和QQ插件 |
| [host.json（历史材料）](README.md#historical-material)、[host-release.json（历史材料）](README.md#historical-material) | 12项真实独立Gateway/QQ插件/原生exec链路；本地确定性模型与合成OneBot，实际source与worktree查询、内存查询、环境清理、目录内写/目录外拒绝、参数绕过、实际超时、成员强制拒绝及审计 |
| [canonical-offline.txt（历史材料）](README.md#historical-material) | 合入当前源码副本后同一131项回归通过；保留并行的旧提示词归档工作 |
| [deployment.json（历史材料）](README.md#historical-material) | 受管配置与人格同步、19:25:45 CST重启Fusion；运行身份revision=5、native exec目录可见、QQ/编码插件active、其余Agent拒绝、试点任务与源Git内容未改 |
| [closeout.json（历史材料）](README.md#historical-material) | 本对话工具回执摘要：服务健康、依赖自持、配置对齐、人格对齐四项通过；不包含聊天原文或凭据 |
| [documentation.json（历史材料）](README.md#historical-material) | 两份源码的证据归属、生成表、文档元数据回归及本地链接核对 |
| [host-initial.json（历史材料）](README.md#historical-material)、[host-fixture-review.json（历史材料）](README.md#historical-material) | 初次宿主夹具的成员AGENTS缺失、deny优先导致工具未暴露；前10项实际执行通过。完善夹具后在最终记录证明强制宿主权限拒绝 |

这些记录不调用真实模型、不发真实QQ、不启动DSH，不证明主人的真实QQ本次已调用exec。生产部署及收尾回执见上表。原生exec尚未由主人在本次部署后通过真人QQ验证，后续从文档16跟进。私有源码变更备份与未触及文件哈希位于`deployment.json`引用的目录。当前工作树的本地提交与源码目录未提交状态分别按Git事实判断，未执行push。

<a id="historical-material"></a>

## 历史原始材料的保留位置

本目录生成的原始回执、日志和图片已退出活动树；既有结论及失败状态不因此改变，也不代表新版已验收。已入Git的内容可用 `git show c849e63:<原仓库相对路径>` 读取；表中的blob标识可核对原始字节。未入Git的临时输出按本次清理授权丢弃。当前执行状态只在全局《整理记录.md》维护。

| 原文件 | 原报告顶层字段（仅摘录） | Git blob |
| --- | --- | --- |
| `canonical-offline.txt` | 未提取；以原材料及现有结论为准 | `ef33a6e53e5897afffc09e8e9ed51bc3bb38cbdd` |
| `closeout.json` | 未提取；以原材料及现有结论为准 | `9b1d89db862702eb32b70c805b9e4e2c670692b4` |
| `deployment.json` | at=2026-10-30T11:27:14.681173+00:00 | `63ca03ced15bef17e44af7081c76840f0e3df1c1` |
| `documentation.json` | at=2026-10-30T11:30:00.318921+00:00 | `10f065fbdae9341d5955a92babaf7fbf470159c6` |
| `host-fixture-review.json` | passed=False；at=2026-10-30T11:18:31.362Z | `fd5a0b68de9bfffd93683171c69669ea06a1ee7a` |
| `host-initial.json` | passed=False；at=2026-10-30T11:17:06.457Z | `e16d25af97ba063bc29b633d35b0a3910c4c0b8f` |
| `host-release.json` | passed=True；at=2026-10-30T11:22:32.578Z | `3d2e839a3517475eeec10444d59b668216ecf98f` |
| `host.json` | passed=True；at=2026-10-30T11:19:13.808Z | `7085e44555dc21dbf0ff90c96fe7724e1bbb8143` |
| `links.json` | at=2026-10-30T11:31:48.061832+00:00 | `0d2b09d644d4b4191a217f934dfbb9fc79c7cf17` |
| `offline.txt` | 未提取；以原材料及现有结论为准 | `e981f4854e90d3a418669c726c380744e98e18cb` |
