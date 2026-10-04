归档：personal-search 旧测试脚本
归档日期：2026-10-01（A3）
归档人：DSH（主人确认 A3 执行）

为什么在这里
------------
`personal-search` 插件源码已于 2026-10-01 删除（453MB，见 docs/8_检索功能重构.txt §七）。
这两个脚本是专门为该插件写的验收驱动，插件删除后**已无法运行**：

- `run-agent-errors.mjs` —— 依赖 `chatbot/plugins/personal-search/dist/{index,provider}.js`
  和它的 `openclaw.plugin.json`，并断言 `personal_web_search` 的报错语义。
- `run-search-provider.mjs` —— 直接 `import ../../plugins/personal-search/dist/provider.js`。

现行检索链路的验收已由下列脚本接管（都还在 `chatbot/tests/acceptance/`）：
- `run-retrieval-smoke.mjs` —— 离线隔离，含"旧 personal_web_search 不得重新出现"的回归守卫。
- `run-retrieval-host.mjs` —— 生产等价的 Host 原生 web_search / web_fetch 路径。
- `run-retrieval-t3.mjs` —— 6 题端到端对照（含 C 组旋钮）。
- `run-fallback-failover.mjs` —— 主模型失败时的真实切换验证（2026-10-01 新增）。

如何恢复
--------
历史版本在 git 中；插件源码另有备份：
`state/backups/personal-search-src-*.tar.gz`（不含 node_modules）。
注意：恢复插件并不等于恢复能力——该方案已被 Host 原生检索取代，
恢复前请先读 docs/8_检索功能重构.txt 的决策记录。
