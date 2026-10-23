# 12_目录资产与Git备份整理：迁出的阶段记录

**历史记录，不作为当前操作与待办。** 原文来源：`c3f395330eeff40afdd060823ee6b02abd1de44d:docs/12_目录资产与Git备份整理.md`。2026-10-23 按文档职责迁出，仅调整相对链接；原有日期、结果与当时授权范围保留。

当前规则见[原归属文档](../../12_目录资产与Git备份整理.md)，本轮整理见[专项记录](../../verification/documentation-2026-10-23/README.md)。

---

## 实际资产

| 资产 | 位置 | Git与建议 |
| --- | --- | --- |
| 旧A源码及私有状态 | `/home/afrangry/kurumi-archive/legacy-openclaw` | 旧原路径 `/home/afrangry/.openclaw` 已不存在；归档 Git HEAD `f8319c1`，对应 MyBot 的 `archive/legacy-openclaw` 分支。凭据、数据库和依赖仍以归档/备份为准 |
| 新源码 | `/home/afrangry/kurumi-fusion` | Git 远端为 `git@github.com:zsh-afrangry/MyBot.git`；日常在 `main` 开发；同步状态用 `git status -sb` 和 `git rev-list --left-right --count origin/main...main` 查询（远端跟踪分支以最近 fetch 为准） |
| 新运行状态 | /home/afrangry/.openclaw-fusion，约109M | 根目录无Git，合理：凭据、SQLite、会话走私有备份；其中projects/fusion是独立代码Git，不等于根目录需要Git |
| 旧bridge源码与状态 | `/home/afrangry/kurumi-archive/qq-bridge` | Git HEAD `d64a4d2`，分支 `personal/main`，标签 `seal/qq-bridge-personal-2026-10-05`；`upstream` 保留原作者，`origin` 指向个人远端但当前 `git ls-remote` 返回 `Repository not found`。原桌面路径不再是权威工作树 |
| SnowLuma安装与运维文件 | /home/afrangry/snowluma，约210M | 无Git，包含发布压缩包、runtime及运维文档；它仍是新系统传输组件。仅自编启动/配置模板/文档需要版本管理，二进制、登录状态和日志不适合全部git add |
| DSH程序 | /opt/deepseek-harness | npm安装目录，无Git正常。当前包0.2.0-rc.2约509M；0.1.5-rc.3旧node_modules备份约524M |
| DSH服务数据 | /var/lib/dsh/.dsh，父目录约25M | 当前服务DSH_HOME明确指向这里，含凭据与会话，不进普通Git |
| 另一份DSH数据 | /home/afrangry/.dsh，约1.1M | 与服务数据目录不同；可能由其他CLI调用产生，未证实无用，不删除 |
| DSH工作目录 | /srv/dsh-workspace | 当前空目录，但仍是服务WorkingDirectory，不能只因空就删除 |
| DSH桌面草稿 | /home/afrangry/桌面/DSH，约44K | 草稿需与部署文件逐项核对，不能凭名称判重复 |
| QQ客户端与用户数据 | /opt/QQ、/home/afrangry/.config/QQ（约791M） | 新旧传输共用安装/登录基础，不能随旧B清理 |

旧A也不是只靠 `.openclaw`：OpenClaw程序位于 `/home/afrangry/.npm-global/lib/node_modules/openclaw`，用户服务单元在 `~/.config/systemd/user/openclaw-gateway.service`。新融合使用受版本约束的 SDK；恢复验收使用固定哈希归档副本，不依赖旧A原路径。

旧B另依赖 `/etc/systemd/system/dsh-web.service` 以及 `~/.config/systemd/user/` 下 qq-bridge、snowluma、snowluma-qq 服务。DSH 当前服务用户为 afrangry、HOME 为 `/home/afrangry`、DSH_HOME 为 `/var/lib/dsh/.dsh`。`/opt/deepseek-harness/README.md` 中版本 0.1.5-rc.3 和服务用户 dsh 的文字已落后于实况；该官方安装目录不属于 MyBot 文档改造范围。

## 当前资产复核（2026-10-17）

本节记录文档23第二轮收尾时的资产状态；实现提交后还有文档/证据收尾提交，实际HEAD和领先数量从Git读取。

| 范围 | 当前事实 |
| --- | --- |
| Fusion 主仓库 | `/home/afrangry/kurumi-fusion`，`main`，第二轮实现`97ed797`；当前HEAD用`git rev-parse HEAD`、领先数用`git rev-list --count origin/main..HEAD`查询。本轮本地提交，不推送 |
| KnowledgeMap 主仓库 | `/home/afrangry/repository`，`master`，第二轮实现`1efec0e`；当前HEAD/领先数从Git读取，原6份P15并行改动保留未提交。桥接只纳入共享Bills.vue两处版本传参及本轮todolist状态，未提交视觉实现 |
| Fusion 后台副本 | `/home/afrangry/.openclaw-fusion/projects/fusion`，分支 `kurumi/main-sync-2026-10-10`，HEAD=`a4e7487`，干净、无 remote；最后内容同步基线为 `2c234af`/`0ada63a`，尚未追平 Fusion 当前主仓库 |
| 运行服务 | `kurumi-fusion.service`、`knowledgemap-assistant.service`、`snowluma.service`、`snowluma-qq.service` 均 active/enabled；`openclaw-gateway.service` 与 `qq-bridge.service` inactive/masked；用户级 `dsh-web.service` 当前不存在，本复核未改动系统级单元 |
| 备份资料 | 第一轮基线/配对恢复资料继续保留；第二轮新增`knowledgemap-bills-round2-2026-10-17-code`及`...-mysql`，代码文件逐项恢复、MySQL完整还原并通过恢复用例（数量见[第二轮证据](../../verification/knowledgemap-bills-round2-2026-10-17/README.md)）。不是同一时刻跨系统停写快照，精确路径与范围见文档23 |

本次业务变更、受管配置、迁移SQL与收尾文档分别在两仓库提交；未改文档22业务。原6份并行文件中的不相交4份字节不变，共享文件仅按本任务差异入index。后台副本的追平与合入留到下一次后台代码任务开始前处理。

## 旧收尾基线

新需求前收尾已于 2026-10-10 完成独立复验并归档；结论与批准延期项统一见[文档 16](../../16_验收与测试总表.md)。**收尾核验基线**为当时本地及实际远端 main `8dbdaef`；本次回填只改文档，不改变 `0f2255a2` 恢复点的运行态覆盖范围。
