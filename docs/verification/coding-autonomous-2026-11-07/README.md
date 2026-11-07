# 本机编码委托：独立验收与恢复补齐

日期：2026-11-07。基线`aa852e7`；具体实现以本记录所在提交为准。主人本轮明确授权开发助手自行完成可独立推进的开发/验收，包含真实DSH调用、文件改名/后缀与终端操作。所有模型任务位于原已批准试点的合成子目录，使用原有认证加载器；不修改DSH源码/认证/服务，不发送真实QQ或邮件，不push。产品中的具体生产候选仍须主人确认，以下合入授权是合成夹具。

## 当前交付

- `reconcile`核对重启前的真实进程与工作树；不重放请求、不补发通知。已停止任务保存快照后进入`interrupted`；明确续接才重新调用原外部会话。
- 取消重启前任务依据PID、启动时刻、boot ID及进程组/会话的存活归属锚点；未知归属、PID复用或工作目录改变拒绝。检查进程身份同样持久记录。中断合入只按已冻结候选和目标当前事实核对，不补做合入。
- 原生隔离包`@deepseek-ai/node-addon-system-linux-x64@0.1.2`含BSD许可证独立导入Fusion tools，完整树指纹固定；两个launcher引用同步，依赖自检核对。DSH实际调用仍使用独立DSH项目已有入口；移动隔离包没有扩大任何写入范围。
- 两个旧live验收脚本修正为只在批准的试点父目录内创建合成任务，避免沿用旧`/tmp`范围。

## 本轮证据

| 层次 | 结果 | 材料 |
| --- | --- | --- |
| 离线及真实本地进程 | 87/87；包含6个新增重启/孤儿进程/过期PID/中断合入用例，以及原编码、权限、结果、exec、恢复回归 | `node --test chatbot/tests/coding/*.test.mjs chatbot/tests/host-exec/policy.test.mjs chatbot/tests/access-control/policy.test.mjs scripts/fusion/test/recovery.test.mjs` |
| 实际DSH/模型，2轮 | clamp修改与独立检查、中文/空格文件改名与后缀变化、逐字内容不变、真实终端输出、同session续接、无确认拒绝、合成确认后本地合入；原目录未提交/暂存/未跟踪文件保持 | [dsh-flow.json](dsh-flow.json) |
| 实际DSH/模型，1轮 | 真实长命令心跳增长；取消后本任务运行树与心跳停止，原目录不变 | [dsh-cancel.json](dsh-cancel.json) |
| 实际DSH/模型，1轮 | Python原地排序独立检查通过，真实执行输出分页、通知同源且不重发；源分支未合入 | [dsh-python-result.json](dsh-python-result.json) |
| 真实隔离Gateway/确定性本地模型 | 12项终端/工作目录/写入边界/超时/身份用例通过 | [owner-exec-host.json](owner-exec-host.json) |
| 真实隔离Gateway | 编码插件启用/禁用两阶段、目录与工具catalog、停止释放服务锁通过；无实际模型 | [coding-host.json](coding-host.json) |

最初工作树未装构建依赖而出现模块缺失，按8份锁文件`npm ci --ignore-scripts`并完成5包构建后再执行全部回归；不将首次启动失败算通过。重启测试初次夹具清理时目录先被测试框架移除，遗留2个明确归属的测试进程；按实际身份停止并补齐夹具清理后87例完整退出通过。没有停止共享DSH或其他用户会话。

这些证据证明本轮技术流程，不等于真实QQ平台收件、其他后端、项目外写入、系统提权、自动合入或长期体验验收。无Git回写、真实仓库登记/硬化、额外审批等待等仍按文档28及唯一手册继续，不因本轮成功自动开放。
