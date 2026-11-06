# Kurumi 融合助手

全局目标、待办与继续位置先读唯一执行手册 [整理记录.md](/home/afrangry/.openclaw-fusion/整理记录.md)。本文件只提供项目总览，功能规则从 [docs/README.md](docs/README.md) 进入。

OpenClaw 提供会话和宿主能力，自研插件提供 Kurumi 个人领域功能，SnowLuma/QQ 提供传输。

| 职责 | 位置 |
| --- | --- |
| 唯一日常源码仓库 | `/home/afrangry/kurumi-fusion`，main单线维护 |
| 唯一私有运行目录 | `/home/afrangry/.openclaw-fusion`，身份、凭据、状态和人格投影 |
| 统一恢复材料 | `/home/afrangry/kurumi-backups`，最近两个已验证恢复点、共享工件及必要离线源码历史 |
| 独立业务依赖 | KnowledgeMap；不合入本仓库，不由Fusion恢复其源码或数据库 |
| 受控编码试点 | 独立dsh-pilot窄根；保留执行所需Git，不能扩大为Fusion主仓库写权限 |

旧后台源码副本、旧功能工作树和 `kurumi-archive` 已退役。独有设计已收录、未上线修复有冻结标签；状态见全局手册。源码版本可本地追溯，远端写入另需明确授权。

修改行为先改 `config/`、`roles/` 或插件源码，再按 [配置契约](config/README.md) 同步。凭据和聊天不进入源码Git。官方内核按 `config/openclaw-release.json` 固定，先隔离验证再切换。

只服务显式登记的QQ私聊身份，成员仅有登记能力并回传自身；群聊和 `testIngress` 关闭。个人业务、主机执行与真实外发按 [文档24](docs/24_统一身份与权限管理.md) 和 [文档28](docs/28_本机编码工具委托与实验任务.md) 的边界执行。

日常四项自检见 [文档16](docs/16_验收与测试总表.md#日常自检)，成套备份/恢复见 [文档12](docs/12_目录资产与Git备份整理.md)。脚本副作用见 [SCRIPTS.md](docs/verification/SCRIPTS.md)：真实模型、QQ、任务和启停脚本不能当离线测试批量运行。
