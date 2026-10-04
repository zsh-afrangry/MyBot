归档证据：2026-08-30 ~ 2026-09-10 开发期的无引用样本
归档日期：2026-10-01
归档人：DSH（主人确认）

为什么在这里
------------
以下文件在 2026-10-01 全仓库检索后确认**零引用**（不含自身）：
  planning-contract-a.json
  planning-contract-b.json
  natural-language-planning-a.json
  natural-language-planning-b.json
  natural-language-reminder-b.json

它们属于规划/自然语言解析的早期 A/B 样本，其中 -a 或 -fixed 版本才是最终采用的证据
（例如 natural-language-reminder-a.json 仍被 docs/verification/2026-09-10_文档与现状复核.txt 引用，
故留在原地未动）。这些 -b / contract 样本是被取代的中间产物。

如需恢复
--------
直接移回 docs/verification/ 即可；当初没有任何文档引用它们，因此移回也不需要改引用。
