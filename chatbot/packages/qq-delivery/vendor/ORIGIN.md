# 来源

md-to-plain.js 复制自 `/home/afrangry/kurumi-archive/qq-bridge/src/md-to-plain.js` 的 2026-10-05 本机快照，未改动。SHA-256: 4315e51f49d4085a0f7b41968e9962df0ae8b4a55bf5cdb0fb55d39ce8eddda3。许可证见 qq-bridge-LICENSE。

仅复用格式化实现；没有复制其 DSH 会话、调度或权限控制。QQ 连接配置的私有副本位于 /home/afrangry/.openclaw-fusion/source-snapshots/qq-bridge-config.json，不纳入 Git。

sticker-lib.js复制自同一原件src/sticker-lib.js，2026-10-05快照，未改动。SHA-256: 6169b2e87092a0e1a6b3f2c67d822af560324f09662fff333745bb88bcf2bed7。只调用目录读取/查找/格式化，不使用它的写入或注入提示功能；标签始终视为不可信资料，单行清洗不代表防提示注入保证。
