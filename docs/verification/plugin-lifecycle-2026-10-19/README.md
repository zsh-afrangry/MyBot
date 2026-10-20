# 插件停止与确认注册归属修复

状态：**源码修复与隔离验收完成；尚未生产重载**。日期：2026-10-19（Asia/Shanghai）。规则入口：[文档21](../../21_后端职责分层与代码整理.md)。

**后续部署（2026-10-20）**：00:26:58已受控加载本修复，00:51:20加载共享代码/四领域插件整理后的最终结构，生产RPC与四项自检见[结构整理专项报告](../capability-decoupling-2026-10-20/README.md)。本报告其余状态与数字保留10月19日的原验收范围，不将当日运行健康误当成当日已加载，也不将后续证据累加到原345项。

收尾归档：生命周期源码与回归已本地提交为 `b5b91a7`，未推送。报告中“尚未生产重载”“混合工作区”等表述是各自验收时点的历史边界；后续加载与当前Git归档状态以[文档21](../../21_后端职责分层与代码整理.md)和[文档16](../../16_验收与测试总表.md#git工作线归档2026-10-20)为准。

## 需求与范围

用户授权先修架构复核中发现的两个实际缺陷，并记录工作：

1. 论文任务和邮件确认后端错误地从 `start()` 返回清理函数；OpenClaw 宿主忽略这个返回值，必须提供显式 `stop()`。
2. 共享确认注册表在复用同一 provider 对象重新注册后，旧注销句柄会误删新注册；注销只能属于该次注册。

只修这两项及对应测试，不扩展为新一轮架构改造。当前工作树另有身份权限、附件入口和人格等未提交工作，按当前文件小范围补丁保留；不混合提交或推送。

## 已落实的决定

- 核对安装中的 OpenClaw 2026.9.7：服务契约为 `start(ctx): void | Promise<void>`、可选 `stop(ctx): void | Promise<void>`；真实服务管理器只从显式 `stop` 建立清理操作。
- [x] 先增加回归复现，再修源文件。论文显式 `start/stop` 转交服务并返回清理 Promise；停止会中止活动任务、清空等待队列并等待清理，重启不重放。
- [x] 邮件用实例内句柄保存确认注册，显式 `stop` 清空并注销；重复停止安全，宿主对失败启动的清理也能执行。两个邮件测试夹具按真实宿主约定调用显式 `stop`，不再接受 `start` 返回清理函数。
- [x] 确认注册每次保存一个独立 provider 包装对象，并绑定原 `open()` 接收对象；注销捕获固定 ID 与该次包装对象，旧句柄不能删除新注册。保持原 18 个公开运行时导出、跨加载副本的 `Symbol.for("kurumi.confirmation.backends.v1")`、确认格式与数据库事务契约。
- [x] 使用真实宿主服务管理器、临时目录、合成身份、注入翻译器/投递器；没有生产服务启停或实际模型、外部 API、QQ/邮件外发。
- [x] 相关回归/构建、只读运行自检、脚本/证据索引及文档回填完成。无数据库 schema/SQL 迁移。

## 结果

| 验证 | 修复前 | 修复后 | 原始证据 |
| --- | --- | --- | --- |
| 确认核心 | 18过 / 1失败；复用 provider 后旧句柄删掉新注册 | 19/19，包括后续真实确认路由、重复注销和原接收对象 | [core-before.txt](core-before.txt)、[core-after.txt](core-after.txt) |
| 实际宿主服务管理器 | 0过 / 3失败；停止未转交、论文仍在线、邮件后端残留 | 3/3：异步清理等待、活动/队列中止、零投递/不重放；邮件停止/重启/重复停止；重复ID失败不误删他人注册；注册后日志异常由宿主清理 | [host-before.txt](host-before.txt)、[host-after.txt](host-after.txt) |
| Node相关回归 | 原有用例遗漏插件到宿主停止链路，两个邮件夹具接受了错误约定 | 149/149，包含上述3项、适配器、分层/确认事务、论文任务/邮件附件及全部邮件单元测试 | [node-regression.txt](node-regression.txt) |
| 确认入口 / 天气 | 本次不改变业务规则 | 15/15、162/162 | [confirmation-tests.txt](confirmation-tests.txt)、[weather-tests.txt](weather-tests.txt) |
| 三个TS构建 | — | 全部退出0 | [core-build.txt](core-build.txt)、[confirmation-build.txt](confirmation-build.txt)、[weather-build.txt](weather-build.txt) |
| 四项只读运行自检 | — | 全部退出0；Gateway/QQ正常，testIngress=false，依赖自持、受管配置和12份人格文件对齐 | [health.json](health.json)、[dependencies.txt](dependencies.txt)、[config.txt](config.txt)、[persona.txt](persona.txt) |
| 索引 / 文档 / 差异格式 | — | 脚本完整分类、boundary无矛盾；证据完整分类；本次文档本地链接和 `git diff --check` 通过 | [evidence-index.txt](evidence-index.txt)、[evidence-coverage.txt](evidence-coverage.txt)、[links.json](links.json) |

合计 **345/345** = Node149 + 确认核心19 + 确认入口15 + 天气162；宿主管理器3项已经包含在Node149，不重复计数。`host-after.txt` 内的两条失败启动日志来自预期负向用例，最终测试退出0。

## 复验入口与源码位置

源码：[确认注册表](../../../chatbot/packages/confirmation-core/src/registry.ts)、[论文插件](../../../chatbot/plugins/kurumi-papers/index.js)、[邮件插件](../../../chatbot/plugins/kurumi-mail/index.js)。回归：[确认核心](../../../chatbot/packages/confirmation-core/src/confirmation.test.ts)、[真实服务管理器](../../../chatbot/tests/backend-boundaries/plugin-lifecycle.test.mjs)、邮件 [adapters](../../../chatbot/plugins/kurumi-mail/test/adapters.test.js) / [tool](../../../chatbot/plugins/kurumi-mail/test/tool.test.js) 夹具。关键源码与测试哈希见 [sources.json](sources.json)。

在仓库根目录先构建，再运行以下离线回归：

```bash
npm --prefix chatbot/packages/confirmation-core run build
npm --prefix chatbot/plugins/personal-confirmation run build
npm --prefix chatbot/plugins/personal-weather run build
npm --prefix chatbot/packages/confirmation-core test
npm --prefix chatbot/plugins/personal-confirmation test
npm --prefix chatbot/plugins/personal-weather test
node --test chatbot/tests/domain-adapters/registry.test.mjs chatbot/tests/domain-adapters/integration.test.mjs chatbot/tests/backend-boundaries/domain.test.mjs chatbot/tests/backend-boundaries/confirmation.test.mjs chatbot/tests/backend-boundaries/plugin-lifecycle.test.mjs chatbot/tests/papers/jobs.test.mjs chatbot/tests/papers/mail.test.mjs chatbot/plugins/kurumi-mail/test/*.test.js
```

宿主测试从已安装SDK解析 `services-*.mjs` 中真实 `startPluginServices`，不复制宿主逻辑、不静默跳过不兼容版本；更换SDK布局时需更新这项集成测试。导入宿主前设置临时状态与配置目录；翻译和投递注入，测试后清理。

## 版本与未覆盖范围

验收在 `9c88003` 基础上的当前混合工作树完成，并依赖已存在的身份权限修改；不能仅检出该HEAD就宣称复现本报告。不整仓提交/推送、不覆盖并行工作，构建产物仍按仓库规则忽略。

**本次未生产重载**，运行自检通过只证明原有运行服务健康，不能证明这些源码已经加载。需在下一次受控重启时加载，并核实在途翻译/投递；没有本次完整Gateway启停、真实模型、真人QQ/SMTP、操作系统级强杀或付费翻译子进程终止验收。论文取消/子进程已有测试不等于本次新增真实付费场景。正常关闭的内部资源清理由实际宿主管理器配合注入worker验证，不扩大为全部生命周期故障已排除。

没有更改权限、DDL/确认业务策略、数据结构或外发对象，也没有重做备份恢复、更新后台副本或替换既有端到端证据。本轮没有待决策阻塞项。
