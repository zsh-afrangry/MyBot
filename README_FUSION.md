# Kurumi 融合助手

OpenClaw 统一会话、后台任务与提醒；Kurumi 保留人格及个人领域能力；SnowLuma 提供 QQ 传输。
**开发在 `/home/afrangry/kurumi-fusion`，运行数据在 `/home/afrangry/.openclaw-fusion`。**

> **本文件是给人和工具的项目总览，不是规则正文。** 规则与操作细节只在 [`docs/`](docs/README.md) 维护，
> 避免两处各写一份、随后互相漂移。改了命令、路径或契约时，改 `docs/` 对应文档，这里只保留指针。

## 只需要记住这五条

| 用途 | 位置 | 规则在哪 |
|---|---|---|
| 开发新系统 | `/home/afrangry/kurumi-fusion` → 远端 `MyBot`（`git@github.com:zsh-afrangry/MyBot.git`） | [文档 12](docs/12_目录资产与Git备份整理.md) |
| 新系统运行数据 | `/home/afrangry/.openclaw-fusion`（配置、凭据、会话、记忆、数据库、提醒、任务） | [config/README.md](config/README.md) |
| 旧 bridge 二次开发 | 封存分支 `personal/main` + 标签 `seal/qq-bridge-personal-2026-10-05` | [文档 15](docs/15_旧系统回退.md) |
| 恢复资料 | `/home/afrangry/kurumi-backups` | [文档 16](docs/16_验收与测试总表.md) |
| 官方组件 | SnowLuma、DSH、OpenClaw 按固定版本与升级流程管理，不手工改动安装目录 | [文档 10](docs/10_融合助手运行维护.md) |

旧目录已移出活动位置的统一放在 `/home/afrangry/kurumi-archive`（详见其 `README.md`）。

## MyBot 分支

| 分支 | 内容 |
|---|---|
| `main` | 当前融合项目（本仓库） |
| `archive/legacy-openclaw` | 旧 `.openclaw` 的源码历史终点（`f8319c1`，与 `main` 共享历史） |

## 四条边界（细节全在文档里）

1. **仓库是意图，运行目录是事实。** 改行为改仓库再同步；密钥只改运行目录。命令与保证见
   [配置契约](config/README.md)，不要按记忆里的旧命令操作。
2. **本文件不重复自检、备份与恢复命令。** 四项自检与它们的证明范围见
   [文档 16「日常自检」](docs/16_验收与测试总表.md#日常自检)，
   备份、`--quiesce` 与隔离恢复的边界见[文档 16](docs/16_验收与测试总表.md)。
3. **只向本人 QQ 私聊外发**；群聊入口永久关闭；合成验收入口（`testIngress`）按设计关闭。
4. **`scripts/fusion/test-*.mjs` 是验收脚本**，会真实发本人 QQ、创建任务或重启服务，不能当离线测试批量运行；
   运行前取得授权、结束后正常取消任务并检查真实终态。**不要删任务账本**——它是投递对账依据。
   脚本清单、副作用与授权要求见 [`docs/verification/SCRIPTS.md`](docs/verification/SCRIPTS.md)。
   统一启停脚本 `scripts/fusion/launchers/{Start,Stop}-DSH.sh` 需要 sudo 密码且会停 `dsh-web.service`，
   请在合适时机手动执行。

## 文档

- [**文档入口（唯一阅读入口）**](docs/README.md)
- [docs 目录文件清单](docs/FILES.md)：每个文件的用途、是否为当前规则
- [**验收与测试总表（权威入口）**](docs/16_验收与测试总表.md)
- [脚本与证据索引](docs/verification/SCRIPTS.md)
- [后台开发副本维护契约](docs/17_后台开发副本维护契约.md)
- [新需求前收尾与验收清单](docs/临时_新需求前收尾与验收清单_2026-10-10.md)：当前正在处理的收尾事项
