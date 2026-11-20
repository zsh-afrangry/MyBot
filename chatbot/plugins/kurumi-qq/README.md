# Kurumi QQ 频道

`index.js` 注册 OpenClaw 的 OneBot 私聊频道，`src/inbound.js` 处理可信入站和宿主派发，`src/media.js` 与 `src/attachments.js` 提供媒体暂存和附件接收。投递与收发账本复用 [`qq-delivery`](../../packages/qq-delivery/)。

配置位置、私聊防抖和离线测试见[文档 32](../../../docs/32_QQ渠道与SnowLuma.md)，宿主版本和依赖准备见[文档 9](../../../docs/9_QQ融合助手架构与开发计划.md#开发与验证)。身份和工作区规则见[文档 24](../../../docs/24_统一身份与权限管理.md)。

隔离验收可用 `kurumi-qq.testInbound` 直接投递一条合成事件，仅在 `testIngress` 启用时注册，要求 Gateway `operator.admin`。日常配置关闭此入口。
