# 论文翻译第三方 API 协议探查

日期：2026-10-17（Asia/Shanghai）。源码基线：`df376ca9ee51d6ee1bd8fd39cf52883c72d2607e`。
需求与后续方案见[文档 22](../../22_论文PDF翻译与文件投递.md)。逐请求的合成输入、HTTP 结果、响应 ID、用量与上游包哈希见 [api-results.json](api-results.json)。

## 授权与边界

主人明确指定 `https://naiccc.com`、`gpt-6.1-sol`、`max` 与三凭据顺序，并要求调查、允许按需安装后本机测试。本次采用发布包源码检查和标准 HTTP 请求，未安装完整翻译环境，也没有切换生产模型、调整工具权限、写生产数据库或发送 QQ/邮件。

凭据只在进程内从指定本机文件的“中转-GPT”段读取，不进入请求命令行、仓库或证据。全部请求只使用 `OPENAI_API_KEY1_014`；`OPENAI_API_KEY2_030`、`OPENAI_API_KEY3_040` 未发起网络调用。报告写入前检查三份密钥原值均不存在于输出中；不保存 Authorization 请求头或加密推理内容。

## 方法与结果

对同一 host、模型、推理强度发起 1 次 `/v1/models` 查询和 8 次短文本生成：7 次生成成功、1 次显式 JSON 模式返回 502。没有 SDK 自动重试或自动降级。

| 请求标签 | HTTP | 输入 token | 已报告缓存 token | 输出 token | 推理 token | 结论 |
| --- | --- | --- | --- | --- | --- | --- |
| `model-list` | 200 | — | — | — | — | 模型列表包含目标模型 |
| `responses-max-nonstream` | 200 | 4239 | 4096 | 53 | 41 | 不传顶层 instructions，Responses 返回译文 |
| `chat-max-nonstream` | 200 | 4239 | 4096 | 37 | 25 | 普通 Chat Completions 返回相同译文 |
| `responses-max-explicit-instructions` | 200 | 29 | 0 | 12 | 0 | 简短顶层 instructions 消除固定输入开销 |
| `chat-max-explicit-system` | 200 | 4241 | 未返回 | 45 | 33 | 仅添加 system 消息未消除固定开销 |
| `responses-max-json-placeholder` | 502 | 未知 | 未知 | 未知 | 未知 | `text.format.type=json_object` 单次失败；不能判定为不支持 |
| `chat-max-custom-instructions` | 200 | 29 | 未返回 | 44 | 32 | Chat 顶层自定义 instructions 也能消除固定开销 |
| `responses-max-json-prompt-only` | 200 | 49 | 0 | 139 | 119 | 不启用显式 JSON 模式，返回可解析 JSON，保留 `{v1}`；响应回显 effort=max |
| `responses-max-small-output-cap` | 200 | 35 | 0 | 106 | 21 | 请求 max_output_tokens=16，实际输出 106、completed、响应限制字段为 null |

Responses 首个样本的用量明细将 4216 个输入 token 归入 `instructions`，而请求中没有该字段；显式 instructions 样本该项为 17 token。这证明该渠道在这组请求下存在可被显式指令替换的额外输入开销，不证明其内部实现或上游身份。Chat 的顶层 instructions 是实测可用的渠道扩展，不是标准 Chat Completions 字段。

用量均为第三方返回值。缓存输入不等于零成本；缺失的缓存字段不按 0 处理；502 的用量未知，不能据表格推算完整账单。少量短句的推理 token 差异不能用于断言某协议在整篇论文上更省。

输出限制问题通过实际输出数超过请求上限验证，不能只根据“响应字段为 null”判断。此渠道当前不能把 `max_output_tokens` 用作可信硬预算。未进一步尝试其它未文档化预算字段或其它密钥。

## 翻译客户端检查

从 PyPI 下载指定版本 wheel 并核对其发布 SHA256；仅读取源码，未安装、导入或修改上游包。哈希及调用位置均保存在 JSON：

- `pdf2zh 1.9.11`：`pdf2zh/translator.py` 的 OpenAI 实现调用 `chat.completions.create`。
- `pdf2zh-next 2.9.0`：`pdf2zh_next/translator/translator_impl/openai.py` 的普通翻译、LLM 辅助翻译均调用 Chat；配置 max 还需开启 `openai_send_reasoning_effort`。
- `BabelDOC 0.6.2`：`babeldoc/translator/translator.py` 的 OpenAI 翻译路径亦调用 Chat。
- `pdf2zh-next` 的 translator 创建还包含一次忽略缓存的 `Hello` 健康检查；默认 RateLimitError 外层重试上限 100 次。后续需把初始化探测、术语/辅助翻译与 SDK 内层重试计入请求/预算策略。

这证明所检查版本的客户端没有自动切换 Responses，不能证明已安装运行或整篇论文排版通过。

## 复核方式与未覆盖范围

JSON 中每条 `request_body` 是实际发送的合成正文；路径、凭据标识、HTTP 状态、耗时与响应 ID 可用于复核。复现时从本机私密来源加载凭据，以标准 HTTP 客户端请求相同 host/path，保持证书校验、不携带凭据跨站重定向；重新运行可能产生费用，502 不进行无限重试。本轮临时下载包和探查程序清理后不作为恢复依赖。

本次不覆盖：完整 pdf2zh 安装/实际 CLI、官方 SDK 运行、流式响应、多轮推理回放、第二/第三密钥真实降级、并发、整篇论文、QQ/邮件附件交付及第三方账单核对。显式 JSON 模式稳定性与可信输出预算仍待处理。各项作为[文档 22](../../22_论文PDF翻译与文件投递.md)的独立后续项，不标整项功能已验收。

收尾检查：证据覆盖 182/182，脚本索引 139 项、34 个 boundary 声明一致；本轮 4 份 Markdown 的 50 个本地目标存在，围栏配对、空白与 `git diff --check` 通过。JSON 结构检查确认共 9 条请求、实际只用 014、保留占位符和 max 回显，以及输出超过请求上限的记录。上述检查不调用模型或真实投递。
