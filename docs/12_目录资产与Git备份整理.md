# 目录资产与Git、备份整理

当前资产说明（2026-10-06）：目录整理、旧系统归档和 MyBot 远端配置已经完成。本文件只描述当前事实；历史盘点和未完成事项保留在下方的历史说明中，不应作为当前状态使用。

## TODO

- [x] 核对源码、运行数据、安装包、服务与备份的实际位置。
- [x] 区分Git版本管理与包含凭据/数据库的私有备份。
- [x] 融合依赖已自包含并通过隔离恢复验证；旧目录已移入归档。
- [x] qq-bridge本地修改已保存到 `personal/main`、封存标签和本地归档，保留上游来源。
- [ ] 旧B的程序版本、配置、会话、登录数据、服务单元形成一致回退清单。
- [x] 新源码已设置用户自己的 `MyBot` 远端；当前 `main` 比 `origin/main` 超前 5 个提交（截至本文件最后更新）。
- [ ] 替代备份验证通过后，按保留策略清理重复备份。

## 实际资产

| 资产 | 位置 | Git与建议 |
| --- | --- | --- |
| 旧A源码及私有状态 | `/home/afrangry/kurumi-archive/legacy-openclaw` | 旧原路径 `/home/afrangry/.openclaw` 已不存在；归档 Git HEAD `f8319c1`，对应 MyBot 的 `archive/legacy-openclaw` 分支。凭据、数据库和依赖仍以归档/备份为准 |
| 新源码 | `/home/afrangry/kurumi-fusion` | Git 远端为 `git@github.com:zsh-afrangry/MyBot.git`；当前 `main` 比 `origin/main` 超前 5 个提交。用户 `docs/example.md` 的未提交修改保持独立 |
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

旧B另依赖/etc/systemd/system/dsh-web.service以及~/.config/systemd/user/下qq-bridge、snowluma、snowluma-qq服务。DSH当前服务用户为afrangry、HOME为/home/afrangry、DSH_HOME为/var/lib/dsh/.dsh。/opt/deepseek-harness/README.md中版本0.1.5-rc.3和服务用户dsh的文字已落后于实况，本轮没有改原件。

## 旧A的当前状态

融合项目已经完成从旧 `.openclaw` 原路径移出、配置重映射和隔离恢复验收。旧A现在是归档回退材料，不是新系统的运行依赖；不要根据历史盘点中的旧链接描述判断当前布局。

## kurumi-baselines是什么

这是前面迁移工作建立的回退快照目录，约556M，不是活动服务工作目录，也不是Git源码仓库。

| 子目录 | 体积 | 内容及处置建议 |
| --- | --- | --- |
| 2026-10-05-before-integration | 331M | 旧OpenClaw完整压缩包、Git bundle、未提交差异与状态；保留旧A迁移前基线 |
| 2026-10-05-full-migration | 221M | 新运行状态约53MB、源码bundle约3.7MB、固定SDK包约175MB及校验记录；保留迁移检查点，但它早于后续角色/模型/启停脚本修改，不能当最新备份 |
| 2026-10-05-fusion-acceptance | 4.3M | 早期融合原型快照；后续回退点与恢复验证充分时可删除，节省很少 |

上述清单不是旧B完整备份：不能从这些文件名/目录推断已经保全DSH、bridge本地修改及QQ登录。Git bundle也不会包含未提交修改、被忽略配置和数据库。

优先清理候选是DSH旧node_modules备份约524M，前提是确认不再需要回退到0.1.5-rc.3或已有可恢复替代包。SnowLuma发布压缩包、旧快照与零散备份也应先核对唯一性。当前未逐个验证这些候选均可安全删除，因此没有删除任何一项。

## 推荐管理方式

源码Git、软件安装、私有运行状态、备份四类分开。`MyBot` 是融合项目的唯一主仓库；不要把整个 home、运行状态或第三方 bridge 的完整 Git 历史塞进 MyBot。

qq-bridge 应作为**独立仓库/独立归档资产**管理，因为它有自己的上游历史、发布节奏和回退边界。它与当前项目的“绑定”应通过融合项目中的配置、启动契约和归档版本记录表达，而不是把两个项目强行合并成一个 Git 工作树。当前推荐顺序：

1. 继续保留本地 `/home/afrangry/kurumi-archive/qq-bridge` 作为权威封存副本；`personal/main`、封存标签、本地 bundle 和全量备份共同构成可恢复性。
2. 若要在线协作或跨机器恢复，在 GitHub 创建你自己的 `zsh-afrangry/qq-bridge-personal` 空仓库，再将现有 `origin` 推送到该仓库；保留 `upstream` 指向原作者。远端尚未创建成功前，不要删除本地归档，也不要反复 `git push` 当作验证。
3. MyBot 只记录采用的 qq-bridge 封存提交/标签和兼容说明；不需要 Git submodule。只有未来要让 MyBot 在每次克隆时自动拉取 bridge，并接受 submodule 运维成本时，才考虑 submodule。

当前个人远端是失效地址，`Repository not found` 通常表示仓库不存在、改名或当前账号没有权限；这不影响本地 Git 的完整性，但意味着它不是备份。创建远端需要 GitHub 侧写入操作，本轮不代替用户创建仓库或推送。

DSH/SnowLuma安装目录用版本号、安装来源、校验及部署脚本管理。自编脚本可放新源码的运维目录；统一启停脚本已在scripts/fusion/launchers版本管理。私有状态定期一致性备份，至少保留旧方案基线与最新新系统快照；确认恢复成功后滚动删除中间快照。

当前 `Start-DSH.sh` 已改为停止旧消费者、启动DSH与融合栈；不再自动启动旧bridge。此前故障调查描述的是改造前脚本，不可拿旧结论指导当前操作。
