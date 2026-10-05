# 目录资产与Git、备份整理

现在应该从哪里继续：已完成2026-10-05只读盘点和分类。优先解除融合项目对旧.openclaw的依赖，再补充旧B完整回退备份与新源码远端；本轮未移动、删除或重写旧仓库。

## TODO

- [x] 核对源码、运行数据、安装包、服务与备份的实际位置。
- [x] 区分Git版本管理与包含凭据/数据库的私有备份。
- [ ] 融合依赖自包含并验证，再考虑移动旧目录。
- [ ] qq-bridge本地修改单独保存到本地分支或受控备份，保留上游来源。
- [ ] 旧B的程序版本、配置、会话、登录数据、服务单元形成一致回退清单。
- [ ] 新源码设置用户自己的远端；当前没有执行创建远端或推送。
- [ ] 替代备份验证通过后，按保留策略清理重复备份。

## 实际资产

| 资产 | 位置 | Git与建议 |
| --- | --- | --- |
| 旧A源码及私有状态 | /home/afrangry/.openclaw，约1.2G | 已有Git，main，f8319c1，干净，176个跟踪文件；origin为用户MyBot仓库。干净不表示数据库、凭据、依赖已纳入Git |
| 新源码 | /home/afrangry/kurumi-fusion，约61M | 已有Git；盘点时HEAD f8c22b1，docs/example.md有用户修改。origin是本地旧.openclaw，没有独立云端副本 |
| 新运行状态 | /home/afrangry/.openclaw-fusion，约109M | 根目录无Git，合理：凭据、SQLite、会话走私有备份；其中projects/fusion是独立代码Git，不等于根目录需要Git |
| 旧bridge源码与状态 | /home/afrangry/桌面/qq-bridge，约52M | 已有Git，main，9df6a7e；origin为Derpyu520/qq-bridge。15个已跟踪文件修改，另有3个未跟踪条目；不能当作随时可重新下载的纯上游副本 |
| SnowLuma安装与运维文件 | /home/afrangry/snowluma，约210M | 无Git，包含发布压缩包、runtime及运维文档；它仍是新系统传输组件。仅自编启动/配置模板/文档需要版本管理，二进制、登录状态和日志不适合全部git add |
| DSH程序 | /opt/deepseek-harness | npm安装目录，无Git正常。当前包0.2.0-rc.2约509M；0.1.5-rc.3旧node_modules备份约524M |
| DSH服务数据 | /var/lib/dsh/.dsh，父目录约25M | 当前服务DSH_HOME明确指向这里，含凭据与会话，不进普通Git |
| 另一份DSH数据 | /home/afrangry/.dsh，约1.1M | 与服务数据目录不同；可能由其他CLI调用产生，未证实无用，不删除 |
| DSH工作目录 | /srv/dsh-workspace | 当前空目录，但仍是服务WorkingDirectory，不能只因空就删除 |
| DSH桌面草稿 | /home/afrangry/桌面/DSH，约44K | 草稿需与部署文件逐项核对，不能凭名称判重复 |
| QQ客户端与用户数据 | /opt/QQ、/home/afrangry/.config/QQ（约791M） | 新旧传输共用安装/登录基础，不能随旧B清理 |

旧A也不是只靠.openclaw：OpenClaw程序位于/home/afrangry/.npm-global/lib/node_modules/openclaw，用户服务单元在~/.config/systemd/user/openclaw-gateway.service。新融合也使用该全局SDK。

旧B另依赖/etc/systemd/system/dsh-web.service以及~/.config/systemd/user/下qq-bridge、snowluma、snowluma-qq服务。DSH当前服务用户为afrangry、HOME为/home/afrangry、DSH_HOME为/var/lib/dsh/.dsh。/opt/deepseek-harness/README.md中版本0.1.5-rc.3和服务用户dsh的文字已落后于实况，本轮没有改原件。

## 当前不能删除旧A的原因

融合chatbot目录内有148个符号链接最终指向旧.openclaw；Tavily运行插件直接加载旧.openclaw/npm/projects/.../node_modules/@openclaw/tavily-plugin。新源码与新数据库虽然隔离，依赖安装尚未完全独立。需先建立受版本约束的新依赖目录、更新链接和插件路径、跑构建与服务验证，才具备移动旧A的条件。

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

源码Git、软件安装、私有运行状态、备份四类分开。保留现有源码仓库，不创建包含整个home目录的大仓库。第三方Git仓库依然可以做本地提交；origin指别人只意味着没有推送权限，不意味着未受Git管理。长期开发可用自己的fork作为origin、原作者作为upstream；封存旧bridge则只需保留历史和本地差异，不必创建新线上仓库。

DSH/SnowLuma安装目录用版本号、安装来源、校验及部署脚本管理。自编脚本可放新源码的运维目录；统一启停脚本已在scripts/fusion/launchers版本管理。私有状态定期一致性备份，至少保留旧方案基线与最新新系统快照；确认恢复成功后滚动删除中间快照。

最新Start-DSH.sh已随f8c22b1改为停止旧消费者、启动DSH与融合栈；不再自动启动旧bridge。此前故障调查描述的是改造前脚本，不可拿旧结论指导当前操作。
