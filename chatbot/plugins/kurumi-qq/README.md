# Kurumi QQ 频道

面向 OpenClaw 2026.9.7 的独立 OneBot 频道原型。仅允许一个配置的主人私聊，拒绝群消息和其他收件人。原 qq-bridge 未改动。

模块：`config.js` 负责账户/目标边界；`inbound.js` 使用 Host 路由、会话和回复管线；`transport.js` 投递文本/引用/已暂存图片；`media.js` 暂存受限 QQ 图片及校验引用所属会话；`ledger.js` 存储重复入站和投递回执。Host 仍负责对话和调度。

`channel.sqlite` 由频道自建，包含 inbound(id,status,at) 与 outbound(id,status,message_id,at)。发送前事务预留次数，送达未知或失败均占预算，未知结果不自动重发。预算当前上限 10 是本轮夜间测试授权，不是正式产品配额。已发送的相同投递键直接返回历史消息 ID。

`testIngress` 默认不启用。开启时注册 `kurumi-qq.testInbound`，要求 Gateway operator.admin，仅供隔离验收；它不是公开 Webhook。验收完成必须关闭。合成入站与人类真实 QQ 入站分别记录。

依赖：本地开发通过源码根 node_modules 中的链接解析已安装的 OpenClaw 2026.9.7 和 ws 8.21.3；不修改被链接的依赖。暂未制作独立发布包。复用格式化代码的来源与许可证见 src/vendor。

运行入口在 `scripts/fusion/`，状态、凭证与日志在 `/home/afrangry/.openclaw-fusion`，不进入 Git。prepare 脚本拒绝覆盖既有配置。启动前停止旧 qq-bridge，停止融合后可恢复旧 qq-bridge。不要同时启动两个 QQ 消费者。
