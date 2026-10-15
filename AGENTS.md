# 开发指引（本仓库）

本文件是 `/home/afrangry/kurumi-fusion` 开发侧的指令入口。它只说明开发路径、保护范围和验证方式，不复制运行规则。
按任务进入文档：阅读入口 [`docs/README.md`](docs/README.md) → 当前规则文档（文档 9、10、11、12、15、16、18、19、20、21 与 `config/README.md`） → 证据从 [`docs/verification/INDEX.md`](docs/verification/INDEX.md) 查。
**文档冲突时以上面这些规则文档和代码为准**，不读 `docs/1–8` 的“现在应该从哪里继续”当作待办。

## 两处目录，不要混用

| 位置 | 性质 | 允许的操作 |
| --- | --- | --- |
| `/home/afrangry/kurumi-fusion` | 源码与配置**意图** | 修改、测试、本地提交 |
| `/home/afrangry/.openclaw-fusion` | 运行**事实与私密状态** | 只按 [`config/README.md`](config/README.md) 的同步契约写入 |

运行目录含凭据、会话、记忆、数据库和聊天原文。不把它的内容复制进仓库，不在回复、文档、提交信息或测试输出里粘贴 API Key、token、私聊原文。
`.openclaw-fusion/projects/fusion` 是后台 agent 用的独立副本，不是第二份源码主线；它的提交要经操作者审阅后才合入本仓库。

## 受保护内容

- `docs/example.md`、`docs/kurimi.png`、`docs/tp.txt`、`docs/tp2.txt` 是用户内容，未获明确指示不得删除或覆盖。
- `roles/`、`config/` 是运行行为的权威来源；改行为改这里再同步，不改运行目录里的受管键。
- `docs/archive/` 与 `docs/1–8` 是历史资料，只用于追溯，不是当前规则。
- 旧系统原件只在 `/home/afrangry/kurumi-archive/` 保留，不直接启动、不修改。

## 改动的验证路径

改代码或配置后按下表验证，不要用“文件存在”或“服务在跑”代替结论：

| 改动 | 命令 / 依据 |
| --- | --- |
| 行为、模型、工具白名单 | `node scripts/fusion/sync-config.mjs --diff` → `--apply` → 重启 `kurumi-fusion.service` |
| 人格 | `node scripts/fusion/sync-persona.mjs --apply`（只写 workspace 四份文件） |
| 领域插件 | 文档 10「开发与验证」中列出的 `node --test` 与 `npm --prefix ... run build` |
| 收尾自检 | `health.mjs`、`verify-dependencies.mjs`、`sync-config.mjs`、`sync-persona.mjs` 四项全过 |

配置对齐、依赖自持、服务健康只证明系统没有偏离仓库；它们**不证明**代码已提交或已推送。

## 需要单独授权的操作

以下操作不属于“读文档即可执行”的范围，实施前须取得用户明确同意，并在对应任务的验收记录中注明授权范围与执行结果（记录规则见文档 16）：

- 任何远端写入：`git push`、改远端分支或标签。
- 停写快照与备份恢复：`backup-state.mjs --quiesce`、`restore-verify.mjs`、`restore-legacy.sh`。
- DSH/Fusion 启停：`Start-DSH.sh` / `Stop-DSH.sh`（会停 `dsh-web.service`，只检查并保留 SnowLuma/QQ，需要 sudo 密码）。
- 真实外发：`scripts/fusion/test-*.mjs` 会真实发本人 QQ、创建任务或重启服务，**不能当离线测试批量运行**；`testIngress` 保持关闭。
- 清理或删除：运行目录的数据库与账本是投递对账证据，不删除、不重建。

## 触及禁用限制时必须先告知

运行期 agent 的能力由 `config/runtime.config.json` 的 `agents.entries.<id>.tools` 决定，**不是由提示词决定**。
当前 `main`（QQ 私聊里的助手）禁用：`read`、`write`、`edit`、`apply_patch`、`exec`、`process`、`message`、
`sessions_spawn`；它能用的只有聊天与 `tools.alsoAllow` 明列的业务工具。群聊入口永久关闭，
`channels.kurumi-qq` 只服务主人私聊（四重校验含 `direct:` 会话）。

**当某个需求需要某项被禁用的能力时**（例如"让 QQ 里的助手读文件/跑命令"）：

1. **先明确告知主人**：需要放宽哪一项、为什么需要、放开后的风险是什么，由主人决定是否开放；
2. **不要默默绕道**：不得改用沙箱、改用其它工具拼凑，或把需求改小后声称完成；
3. **不要自行放宽**：`tools.deny`、`tools.alsoAllow`、`agents.entries` 属受管键，改动须经主人同意并走
   `sync-config.mjs --apply`；
4. **记录决定**：开放或拒绝都写进对应任务的记录里（记录规则见[文档 16](docs/16_验收与测试总表.md)）。

判断依据与分级建议见[文档 20](docs/20_邮件能力与横切扩展.md)的「权限现状与"触及禁用限制"的处理」。

验收标准与边界见[文档 16](docs/16_验收与测试总表.md)：沙箱模拟通过不等于真实模型或 QQ 往返通过。

## 后端代码边界

- 领域默认策略放 `policy.js`，可信入站放 `inbound.js`，写入编排放 `service.js`；`store.js` 不读取聊天原文。提醒列表与记忆通过 `application.js` 组合入口、`adapters.js` 注册表和 `contracts.d.ts` 消费 Policy/Store 接口，服务不导入具体实现。共享注册/选择机制在 `chatbot/packages/domain-adapters/`；不可热切换或静默回退。
- 提醒列表已有项的动作和对话指代由模型转换成 ID/版本，后端不重判原文动词/标题。可信当前请求、事务、版本和幂等是执行契约；单消息一项还受账本唯一键约束。替换列表存储必须同时覆盖工具、调度器和独立固定 runner，参见文档 21。
- 带码确认只通过 `@kurumi/confirmation-core`；业务插件提供自己的适配器，在业务事务内消费 grant。交互钩子不签发授权。结构与删减入口见[文档 21](docs/21_后端职责分层与代码整理.md)。

## 记录方式

- 新增领域后端脚本放 `chatbot/scripts/`，测试放 `chatbot/tests/<领域>/`；SQL 迁移随对应插件留在仓库。登记脚本与证据索引，不向 `archive/` 放未说明归属的文件。现有部署/运维脚本仍由 `scripts/fusion/` 管理。

- 新需求前的收尾清单已于 2026-10-10 归档（过程记录见 Git 历史），不再接收新任务。当前结论和批准延期项见文档 16，资产与恢复点见文档 12。后续任务记录使用 `待处理 / 处理中 / 待复验 / 已验收 / 阻塞 / 经用户确认延期`，有证据才写“已验收”。
- 行为变化先更新对应的规则文档（9、10、11、12、15、16、18、19、20、21 或 `config/README.md`），再在 `docs/verification/` 落证据并登记 `INDEX.md`；不把长日志复制进规范文档。
- 需要用户判断的事项写进对应任务记录，不自行豁免或标记通过。

## 其他 agent 指令入口

- `chatbot/AGENTS.md`：**不是本仓库的当前规则**。它是融合前遗留的能力登记，只作为 `chatbot/tests/acceptance/` 离线验收脚本的基础提示词保留，并已在文件头标注。不要据它判断当前能力、工具或权限。
- 运行期 agent 提示词在 `scripts/fusion/templates/AGENTS.md`，由 `config/persona.json` 的 `agentsSubstitution` 替换后经 `sync-persona.mjs` 写入 `.openclaw-fusion/workspace/AGENTS.md`；只改模板，不改运行副本。
- `project-fusion`、`researcher` 等后台 agent 的提示词由各自的 `configure-*.mjs` 生成在对应工作区，不在本文件维护。

返回[文档入口](docs/README.md)。
