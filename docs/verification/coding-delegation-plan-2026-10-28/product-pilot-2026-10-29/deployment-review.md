# QQ编码试点：待主人决定的具体启用范围

状态：**待确认；未apply、未重启、未外发。** 日期：2026-10-29。归属：[文档28](../../../28_本机编码工具委托与实验任务.md)、[N23](../../../待办清单.md#n23)。本地处理器结果见[报告](README.md)。

## 已准备的对象

- 项目ID：`dsh-pilot`，唯一目标为`/home/afrangry/.local/share/kurumi-coding-pilot-20261029/source`，分支`main`。这是新建的合成代码与Node测试，**没有远端、子模块或生产资料**；基线`3783b368914074172a70b14d0397a07716e2e78a`，预留的`local-draft.txt`必须保留。
- 独立工作树：同根目录的`worktrees/<任务UUID>`；SQLite、日志、ACP临时patch及失败快照在`state/`。这是可丢弃测试资产，不是当前生产恢复点，默认运行备份不会自动纳入它。
- 固定外部检查：同根`fixed-check.mjs`，加任务工作树内的`node --test`。前者复核已有sum及clamp边界，不能由模型通过工具参数替换；源码测试仍需审阅。
- 后端：`/opt/deepseek-harness/node_modules/.bin/dsh --profile acp --patch <任务私有文件>`；复用既有`DSH_HOME=/var/lib/dsh/.dsh`认证。选择`deepseek-official/deepseek-flash`，使用`workspace-write/native`，关闭该临时会话的自动标题模型调用，不修改共享配置。

## 受管配置的四处新增

精确值见[配置新增项JSON](configuration-additions.json)。本机另有完整候选文件`/home/afrangry/.local/share/kurumi-coding-pilot-20261029/runtime.config.proposed.json`，只供审阅，不直接覆盖运行配置。

| 位置 | 拟变更 |
| --- | --- |
| `plugins.allow` | 追加`kurumi-coding` |
| `plugins.load.paths` | 追加主源码内`chatbot/plugins/kurumi-coding`的绝对路径 |
| `plugins.entries.kurumi-coding` | 启用，并填入上述单一合成项目、固定DSH路径、工作树与检查 |
| `agents.entries.main.tools.alsoAllow` | 追加主人专用`kurumi_code` |

成员/群聊策略、身份名单以及main通用`read/write/edit/apply_patch/exec/process/message/sessions_spawn`的deny均不改。采用专用工具仍授予外部DSH读文件、改工作树与运行命令的实际能力，**不是绕过现有权限告知要求**。源码中新增`coding`确认域映射也不代表生产已启用。

## 需要同意的实际动作

同意本轮试点意味着允许：按上表改主源码受管配置，先展示`sync-config.mjs --diff`，再`--apply`并重启`kurumi-fusion.service`加载插件；在本人私聊测试发起/查询/续接、完成通知、冻结预览、取消和结果回传，核对真实OneBot回执。会调用真实模型并产生用量。此次不停止共享DSH、SnowLuma或QQ，不写其他仓库，不push。

首期合入另有一次具体决定：由主人先审阅真实任务diff、候选SHA与检查结果，再在QQ确认那份预览。启用许可不代替该合入确认，也不允许自动合入或项目外写入、系统安装、生产服务操作。

## 风险与未覆盖项

DSH以本机现有身份执行，并可按实际权限读取任务所需资料；必要内容可能进入既有模型通道。worktree只隔离工作目录/分支，**不等于OS沙箱**；本轮未证明DSH原生权限对任意命令、插件、网络或所有系统副作用都具备完整防护。提示词中的禁令不是此类保证，因此只选择无远端合成项目试点，真实仓库开放和执行边界硬化另行验收。

额外ACP权限请求目前拒绝并标`needs_permission`，不会自动点击同意，QQ内等待审批及Auto review尚未实现。运行中补充须等本回合结束；异常重启先标状态待核对，不自动重复任务。失败快照保留普通Git变更，不承诺保留忽略的构建缓存，暂不自动清理。任务完成/平台受理/真人收件分别记录。

本仓库[AGENTS.md](../../../../AGENTS.md#触及禁用限制时必须先告知)明确要求：“改动须经主人同意并走 `sync-config.mjs --apply`”；同文“需要单独授权的操作”要求真实外发另有明确许可。因此在此处等待具体启用与本人QQ测试决定，不能将本地成功写成真实QQ全流程通过。
