# 后台开发副本同步与复验（2026-10-11）

## 结论

`/home/afrangry/.openclaw-fusion/projects/fusion` 已从主仓库 `9cc804e` 同步完成，当前副本提交为 `4791d92`，分支仍为 `kurumi/main-sync-2026-10-10`，工作区干净且未配置远端。

副本保留三项有意差异：副本专用根 `AGENTS.md`、副本本地 `.gitignore` 规则和固定代码验收 fixture `scripts/fusion/fixtures/stats.py`。`chatbot/AGENTS.md` 采用主仓库版本，避免离线验收继续使用过期的副本短指令。

## 实施记录

1. 主仓库当前提交为 `9cc804e`；在副本执行：
   `git fetch /home/afrangry/kurumi-fusion main:main-sync-2026-10-11`。
2. 审阅待合入差异后执行普通 `git merge main-sync-2026-10-11`。合并产生两个冲突：
   - 根 `AGENTS.md`：保留副本专用开发指令；
   - `chatbot/AGENTS.md`：采用主仓库当前版本。
3. `.gitignore` 的自动合并结果保留副本上下文忽略规则；未使用 `reset --hard` 或静默覆盖冲突。
4. 以 `4791d92` 提交合并结果，随后复核 `git status --short --branch` 为空。

## 复核结果

```text
副本分支：kurumi/main-sync-2026-10-10
副本 HEAD：4791d92
主仓库来源：9cc804e
副本相对来源的有意差异：.gitignore、AGENTS.md、scripts/fusion/fixtures/stats.py
chatbot/AGENTS.md：与来源一致
副本工作区：clean
副本 remote：none
```

后台任务仍须在该副本的隔离检查中运行；副本提交不会自动部署，也不得从副本推送或直接重启生产服务。
