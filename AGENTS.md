# 开发指引（本仓库）

本文件是 `/home/afrangry/kurumi-fusion` 开发侧的指令入口。它只说明开发路径、保护范围和验证方式，不复制运行规则。
按任务进入文档：阅读入口 [`docs/README.md`](docs/README.md) → 当前规则文档（文档 9、10、11、12、15、16 与 `config/README.md`） → 证据从 [`docs/verification/INDEX.md`](docs/verification/INDEX.md) 查。
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

验收标准与边界见[文档 16](docs/16_验收与测试总表.md)：沙箱模拟通过不等于真实模型或 QQ 往返通过。

## 记录方式

- 新需求前的收尾清单已于 2026-10-10 归档（过程记录见 Git 历史），不再接收新任务。当前结论和批准延期项见文档 16，资产与恢复点见文档 12。后续任务记录使用 `待处理 / 处理中 / 待复验 / 已验收 / 阻塞 / 经用户确认延期`，有证据才写“已验收”。
- 行为变化先更新对应的规则文档（9、10、11、12、15、16 或 `config/README.md`），再在 `docs/verification/` 落证据并登记 `INDEX.md`；不把长日志复制进规范文档。
- 需要用户判断的事项写进对应任务记录，不自行豁免或标记通过。

## 其他 agent 指令入口

- `chatbot/AGENTS.md`：**不是本仓库的当前规则**。它是融合前遗留的能力登记，只作为 `chatbot/tests/acceptance/` 离线验收脚本的基础提示词保留，并已在文件头标注。不要据它判断当前能力、工具或权限。
- 运行期 agent 提示词在 `scripts/fusion/templates/AGENTS.md`，由 `config/persona.json` 的 `agentsSubstitution` 替换后经 `sync-persona.mjs` 写入 `.openclaw-fusion/workspace/AGENTS.md`；只改模板，不改运行副本。
- `project-fusion`、`researcher` 等后台 agent 的提示词由各自的 `configure-*.mjs` 生成在对应工作区，不在本文件维护。

返回[文档入口](docs/README.md)。
