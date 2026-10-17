# 三渠道故障切换与 DeepSeek 官方接入

归属：[文档 22](../../../22_论文PDF翻译与文件投递.md)。本次授权：先补 014 → 030 → 040 的渠道故障切换，再接 DeepSeek 官方 Key；保持 GPT 6.1 Sol/MAX 默认，不推送远端。已有本人 QQ/邮件单页收件确认仍有效。

状态：GPT 渠道切换实现和回归完成，三个渠道独立真实短文通过；新规则全文任务和 DeepSeek 接入仍在进行。

| 证据 | 范围 |
| --- | --- |
| `responses-tests.txt` | 新规则离线回归；模拟所有渠道错误，不证明实际 Key 可用 |
| `channels-api.json` | 三个真实渠道分别执行合成短文原生 Responses；不故意耗尽/吊销 Key，不冒称是真实故障切换往返 |
| `paper-node-phase1.txt` | 20/20 论文 Node 回归；worker/SMTP/QQ 等按测试注入，不是实际投递 |
| `engine-phase1.txt` | 4/4，使用实际安装的 BabelDOC 合约、缓存和批次模板；API 为注入实现 |

三渠道真实短文结果：014 / 030 / 040 各 1 请求成功，分别 8.336 / 4.418 / 5.433 秒、91 / 188 / 205 已报告 tokens。请求始终是 gpt-6.1-sol / max / Responses。可用性是该次采样结果，不保证持续稳定。17 项客户端回归覆盖流中断、超时、5xx、顺序/共享冷却、全失败、请求/token 总预算，以及永久/格式错误不切换。

`gpt-full/acceptance.json` 是新规则下明确启动的一次指定 16 页 PDF 复验，复用私有验收根 `paper-acceptance/mvb7tbhu` 的成功批次；不开启 QQ/邮件发送。任务结果待回填，不能依据启动状态写通过。

新增脚本 `chatbot/tests/papers/acceptance-api.py` 只读指定私密凭据；真实调用只翻译合成短句，没有 QQ/邮件发送。完整 PDF、DeepSeek 接入、部署状态与未覆盖项随执行更新本页。
