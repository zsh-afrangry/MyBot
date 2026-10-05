# Kurumi 融合助手

OpenClaw统一会话、后台任务与提醒；Kurumi保留人格及个人领域能力；SnowLuma提供QQ传输。旧OpenClaw、SnowLuma/qq-bridge原件保留，后续开发在`/home/afrangry/kurumi-fusion`。

- [当前架构、验收和边界](docs/9_QQ融合助手架构与开发计划.md)
- [运行维护、开发、项目接入与回退](docs/10_融合助手运行维护.md)

日常检查：

```bash
cd /home/afrangry/kurumi-fusion
node scripts/fusion/health.mjs
systemctl --user status kurumi-fusion.service
```

融合已作为默认用户服务自启；私有状态在`/home/afrangry/.openclaw-fusion`。只向本人QQ私聊外发，测试入口关闭。`scripts/fusion/test-*.mjs`可能真实发消息或重启服务，不能当普通离线测试随意运行。
