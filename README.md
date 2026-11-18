# Kurumi Fusion

个人维护的 QQ 助手。OpenClaw 提供会话和宿主能力，自研插件提供个人领域功能，SnowLuma/QQ 提供传输。

| 职责 | 位置 |
| --- | --- |
| 源码仓库 | `/home/afrangry/kurumi-fusion`，main 单线维护 |
| 私有运行目录 | `/home/afrangry/.openclaw-fusion`，身份、凭据、状态和人格投影 |
| 恢复材料 | `/home/afrangry/kurumi-backups`，已验证恢复点和共享工件，按[文档12](docs/12_目录资产与Git备份整理.md)管理 |
| 独立业务依赖 | KnowledgeMap，不合入本仓库，Fusion 通过接口使用 |
| 受控编码试点 | 独立的 dsh-pilot 目录，不等于 Fusion 主仓库的写权限 |

开发约束和文档管理规范见 [AGENTS.md](AGENTS.md)，各功能的文档从 [docs/README.md](docs/README.md) 进入，配置同步见 [config/README.md](config/README.md)。

修改行为先改 `config/`、`roles/` 或插件源码，再按配置契约同步。凭据和聊天内容不进入仓库。官方内核版本由 `config/openclaw-release.json` 固定。

只服务显式登记的 QQ 私聊身份，群聊关闭。真实模型、QQ、任务和启停脚本不能当离线测试批量运行，判断规则见 [AGENTS.md](AGENTS.md#需要单独授权的操作)。
