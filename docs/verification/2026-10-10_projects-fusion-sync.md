# 后台开发副本同步与复验（2026-10-10）

对应清单条目：C02。规则见[文档 17](../17_后台开发副本维护契约.md)。
本文只记录本次实际执行的命令与结果；未做的验证在末尾明确列出。

## 同步前状态

| 项目 | 值 |
| --- | --- |
| 路径 | `/home/afrangry/.openclaw-fusion/projects/fusion` |
| 分支 / HEAD | `kurumi/memory-validation` / `ed7aca82236140acc94a8157374e7b599aa0b4b0` |
| 工作区 | 干净（`git status --porcelain` 为空） |
| remote | 无 |
| 分支 | `integration/onebot`、`kurumi/memory-validation`、`kurumi/project-base`；标签 `baseline/pre-integration-2026-10-05` |
| 活动任务 | `state/openclaw.sqlite` 的 `task_runs` 共 9 条，全部 `succeeded`，最新一条早于本次检查；无运行中任务，同步不会与任务写入冲突 |

副本独有提交（`kurumi/project-base..HEAD` 共 9 个，`c7546f7` 及以上）：

```text
ed7aca8 Add stats helpers satisfying the fixed stats acceptance test
b955abe Sync accepted fusion capabilities into the independent development copy
c7546f7 Make fusion the default service with health checks and recovery validation
...（c7546f7 及以下已存在于主仓库）
```

`ed7aca8` 与 `b955abe` 两个提交在主仓库中不存在（`git cat-file -t` 返回 ABSENT）。
`b955abe` 的内容是迁移阶段的能力同步，主仓库后续提交已包含并演进；`ed7aca8` 只新增
`scripts/fusion/fixtures/stats.py`。

## 同步前归档

```bash
ARCH=/home/afrangry/kurumi-backups/projects-fusion-copy-2026-10-10
mkdir -p "$ARCH/generated-workspace-files" "$ARCH/copy-only-commits"
cp -p <副本>/IDENTITY.md <副本>/SOUL.md <副本>/USER.md "$ARCH/generated-workspace-files/"
cp -p <副本>/scripts/fusion/fixtures/stats.py "$ARCH/"
(cd <副本> && git bundle create "$ARCH/copy-only-commits/projects-fusion-before-rebase.bundle" --all)
(cd <副本> && git format-patch --stdout kurumi/project-base..HEAD > "$ARCH/copy-only-commits/copy-only-9-commits.patch")
```

`git bundle verify` 输出包含 `refs/heads/kurumi/memory-validation`、`refs/heads/kurumi/project-base`、
`refs/tags/baseline/pre-integration-2026-10-05`，结论“这个归档包记录一个完整历史”。
bundle 3.7 MB、补丁 245 KB，均保留在私有备份目录。

## 基线更新

```bash
cd /home/afrangry/.openclaw-fusion/projects/fusion
git tag -f archive/pre-fusion-main-sync-2026-10-10 kurumi/memory-validation
git tag -f archive/pre-fusion-main-sync-2026-10-10-base kurumi/project-base
git switch -c kurumi/main-sync-2026-10-10          # 未 force reset，旧分支与标签都还在
git fetch /home/afrangry/kurumi-fusion main:main-sync   # -> dacfac4，20 个提交待合入
git merge -X theirs main-sync                      # 0 冲突
git commit -m "Sync development copy to main dacfac4 (kurumi/main-sync-2026-10-10)"   # e157529
```

合并后副本工作树与主仓库 `dacfac4` 的差异只剩 4 个文件：3 个 Host 生成的
`IDENTITY.md`/`SOUL.md`/`USER.md`（未跟踪）与保留的 `scripts/fusion/fixtures/stats.py`。
主仓库工作区当时未提交的 `AGENTS.md`、`docs/README.md`、`docs/example.md` 与本次临时清单**没有**被带进副本，
即副本取的是主仓库已提交内容，不复制未提交改动。

### 变更方式与理由

| 选项 | 为什么不采用 / 为什么采用 |
| --- | --- |
| `git reset --hard dacfac4` 或重新 clone | **未采用**：会丢掉副本独有提交与旧分支引用，违反清单“不要直接覆盖或强制 reset”。 |
| 保留旧线继续开发 | **未采用**：副本的作用是承载新任务，长期停在 `ed7aca8` 会让固定检查与主仓库持续分叉。 |
| `git switch -c` 新分支 + `fetch` + `merge` | **采用**：两个父提交都留在历史里，旧线可随时用标签取回；工作树因此同时拿到主仓库的 99 个变更文件。 |
| `-X theirs` | **采用，但仅在已确认差异范围之后**：99 个差异文件逐个看过，唯一“两边都改”的路径影响有限，且需刻意保留的 4 个文件（3 个 Host 上下文 + `stats.py`）在合并后逐个复核。它不是“拿来消冲突”的手段；合并后仍逐文件比对过差异清单。 |

合并后**没有**只凭“0 冲突”就宣告完成：又用文件清单逐一比对副本与主仓库
（只多出上述 4 个文件），并用 `git rev-list` 确认旧线仍可达，才认为基线切换成功。
后续维护（见文档 17）要求先审阅 `git log --oneline HEAD..main-sync` 再决定是否合并，
有疑问先停下问操作者；**不得继续用 `-X theirs` 掩盖冲突**。

## 副本本地 ignore 规则

基线同步采用主仓库的 `.gitignore`，其中没有副本根目录的 Host 上下文规则，
导致 `IDENTITY.md`/`SOUL.md`/`USER.md` 变成未跟踪文件。已恢复副本本地规则并提交：

```bash
printf '\n# Host context stays outside project source (copy-local rule).\n/IDENTITY.md\n/SOUL.md\n/USER.md\n/MEMORY.md\n' >> .gitignore
git commit -m "Keep Host-generated workspace context out of the synced copy's source"   # 1363282
git check-ignore -v IDENTITY.md SOUL.md USER.md   # 三条命中 .gitignore:51-53
git status --porcelain                            # 空
```

## 检查复验

登记检查为 `fusion-offline-regression`（60s，9 个 argv 项）。fixture 内的
`/workspace/...` 与 `/checks/...` 只在沙箱中存在，**主机会 `ERR_MODULE_NOT_FOUND`，不构成真实失败**。
因此按部署实际路径，用副本自己的 `sandbox.js` 在真实 Bubblewrap 中执行登记检查：

```bash
node --input-type=module -e "
import fs from 'node:fs';
const {runSandbox}=await import('/home/afrangry/.openclaw-fusion/projects/fusion/chatbot/plugins/kurumi-tasks/sandbox.js');
const project=JSON.parse(fs.readFileSync('/home/afrangry/.openclaw-fusion/projects.json','utf8')).projects[0];
for(const c of project.checks) console.log(await runSandbox(project,c.argv,{timeoutMs:c.timeoutMs}));
"
```

结果：`code=0 signal=null timedOut=false truncated=false`，`tests 33 / pass 33 / fail 0`，
其中 fixture 项与 8 个插件测试文件全部通过。实际生效的隔离参数（`sandboxArguments` 输出）：

```text
--unshare-all --die-with-parent --new-session --clearenv \
--ro-bind /usr /usr --ro-bind /bin /bin --ro-bind /lib /lib --ro-bind /lib64 /lib64 \
--ro-bind /home/afrangry/.npm-global/lib/node_modules/openclaw <同路径> \
--proc /proc --dev /dev --tmpfs /tmp \
--bind /home/afrangry/.openclaw-fusion/projects/fusion /workspace --chdir /workspace \
--setenv HOME /tmp --setenv PATH /usr/bin:/bin --setenv LANG C.UTF-8 \
--ro-bind /home/afrangry/.openclaw-fusion/project-checks/fusion-memory-revision.mjs /checks/fusion-memory-revision.mjs \
-- /usr/bin/node --test /checks/fusion-memory-revision.mjs <8 个插件测试文件>
```

副本内直接运行 8 个插件测试文件（不含 fixture）：`tests 32 / pass 32 / fail 0`。

## 保留 fixture 的实测依据

`stats.py` 是后台代码任务固定验收的必需件，不是垃圾文件：

```bash
cd <副本>/scripts/fusion/fixtures
python3 -m unittest test_stats            # Ran 6 tests, OK
mv stats.py /tmp/ && python3 -m unittest test_stats   # Ran 1 test, FAILED (errors=1)
mv /tmp/stats.py . && python3 -m unittest test_stats   # Ran 6 tests, OK
```

## 未覆盖范围

- 未通过主聊天真实回合调用 `kurumi_project_check` / `kurumi_project_git`，因此“agent 侧工具接线”未在真实回路上验收；
  本次验证的是同一沙箱函数与同一登记 argv。
- 未 `push` 副本任何提交；副本本就无 remote。
- 未部署、未重启生产服务，也未改动 `.openclaw-fusion/openclaw.json` 的 agent 配置。
- `projects.json` 与 `openclaw.json` 的登记内容本次未修改：路径、`agentId`、`checks` 与登记检查要求一致，无需变更。
