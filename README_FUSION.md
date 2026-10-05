# Kurumi 融合助手

OpenClaw 统一会话、后台任务与提醒；Kurumi 保留人格及个人领域能力；SnowLuma 提供 QQ 传输。
**开发在 `/home/afrangry/kurumi-fusion`，运行数据在 `/home/afrangry/.openclaw-fusion`。**

## 只需要记住这五条

| 用途 | 位置 |
|---|---|
| 开发新系统 | `/home/afrangry/kurumi-fusion` → 远端 `MyBot`（`git@github.com:zsh-afrangry/MyBot.git`） |
| 新系统运行数据 | `/home/afrangry/.openclaw-fusion`（配置、凭据、会话、记忆、数据库、提醒、任务） |
| 旧 bridge 二次开发 | 封存分支 `personal/main` + 标签 `seal/qq-bridge-personal-2026-10-05`（见下"待处理"） |
| 恢复资料 | `/home/afrangry/kurumi-backups` |
| 官方组件 | SnowLuma、DSH、OpenClaw 按固定版本与升级流程管理，不手工改动安装目录 |

旧目录已移出活动位置的统一放在 `/home/afrangry/kurumi-archive`（详见其 `README.md`）。

## MyBot 分支

| 分支 | 内容 |
|---|---|
| `main` | 当前融合项目（本仓库） |
| `archive/legacy-openclaw` | 旧 `.openclaw` 的源码历史终点（`f8319c1`，与 `main` 共享历史） |

## 日常检查

```bash
cd /home/afrangry/kurumi-fusion
node scripts/fusion/health.mjs              # 服务、QQ、频道、数据库
node scripts/fusion/verify-dependencies.mjs # 依赖自持、无归档树逃逸、版本与锁文件一致
node scripts/fusion/sync-config.mjs         # 运行配置是否与仓库一致（含删除项）
node scripts/fusion/sync-persona.mjs        # 角色卡是否与运行工作区一致
systemctl --user status kurumi-fusion.service
```

## 改配置

仓库是**意图**，运行目录是**事实与私密状态**。改行为改仓库再同步，改密钥只改运行目录。

```bash
# 行为 / 工具 / 插件 / 频道 / 模型
$EDITOR config/runtime.config.json
node scripts/fusion/sync-config.mjs --diff  # 看会改什么（含被删除的键）
node scripts/fusion/sync-config.mjs --apply # 合并写入（只写 openclaw.json）

# 人格
$EDITOR config/persona.json                 # 指向 roles/ 下的角色卡
node scripts/fusion/sync-persona.mjs --apply

systemctl --user restart kurumi-fusion.service
```

`sync-config.mjs` 只写 `openclaw.json`，`sync-persona.mjs` 只写 `workspace/` 下四份文件，
两者都不打开 `state/`、`channel/`、`agents/`、`media/` 或任何数据库，因此
**不可能覆盖记忆、提醒或聊天历史**。详见 `config/README.md`。

> 长期记忆是 `workspace/MEMORY.md`，**不在** `state/` 里。

## 备份与恢复

```bash
node scripts/fusion/backup-state.mjs --label before-<变更名>              # 在线快照
node scripts/fusion/backup-state.mjs --label rollback --quiesce          # 停写快照（跨库一致）
node scripts/fusion/restore-verify.mjs --backup <备份目录>                # 恢复演练
```

- 备份采用**反向白名单**：除明确跳过项外，运行目录下所有内容都会收录（含
  `workspace/` 记忆与人格、`code-workspace/`、`project-checks/`、`research-*`、`media/`）。
- 数据库用 `VACUUM INTO` 取一致快照。**单库一致 ≠ 跨库一致**：提醒库、调度状态与投递账本
  可能来自不同时刻。作为提醒对账用的回退点请加 `--quiesce`（短暂停服后快照，
  结束后自动恢复服务），`EXPECTED.json` 会记录 `quiesced` 是否为真。
- 未提交改动分三种形式保全：文本补丁、**二进制修改打包**（文本补丁带不了内容）、
  **未跟踪文件打包**（`git diff HEAD` 不含它们）。
- 备份会写 `EXPECTED.json` 预期清单并**硬校验必需内容**：任一必需项失败即**非零退出**。
- 恢复演练是**组装并加载**级别，且**不借用生产**：完整组装运行目录、
  按锁文件在**恢复出的仓库**里 `npm ci`、重建第三方插件前缀、
  把配置里的插件路径**改写进恢复副本**后校验解析、用**恢复出的源码**读取记忆、
  9 个库在组装位置打开。当前 **20/20 通过**。

## 注意

- 只向本人 QQ 私聊外发；群聊入口永久关闭；合成验收入口（`testIngress`）按设计关闭。
- `scripts/fusion/test-*.mjs` 是**验收脚本**，会真实发本人 QQ、创建任务或重启服务，
  不能当普通离线测试随意运行。它们现在使用 `lib/fresh-id.mjs` 生成新的 message id，
  可重复执行；但会在任务账本留下记录，必要时先清理。
- 统一启停脚本 `scripts/fusion/launchers/{Start,Stop}-DSH.sh` 需要 sudo 密码，
  且会停 `dsh-web.service`（DSH 网页本身），请在合适时机手动执行。

## 文档

- [架构、验收和边界](docs/9_QQ融合助手架构与开发计划.md)
- [运行维护、开发、项目接入与回退](docs/10_融合助手运行维护.md)
- [小鲸鱼与 DeepSeek 切换及确认策略](docs/11_小鲸鱼与DeepSeek切换及确认策略研究.md)
- [目录资产与 Git 备份整理](docs/12_目录资产与Git备份整理.md)
- [配置来源、同步与备份恢复](docs/13_配置来源与同步.md)
- [整理收尾与最终布局](docs/14_整理收尾与最终布局.md)
- [第六步独立运行验收记录](docs/verification/step6-2026-10-05/README.md)
- [旧系统回退：归档保留 + 原路径复制恢复 + 显式切换](docs/15_旧系统回退.md)
