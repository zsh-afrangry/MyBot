# QQ图片收发真人验收（2026-10-27）

> 以下保留00:25首次失败时的原始结论与检查结果。01:19修复后真人复测及接手核对见[复测报告](retest-0119.md)，对应记录为[retest-0119.json（历史材料）](README.md#historical-material)。本页的“未改代码”等表述只适用于首次核对。

范围：文档10「QQ图片与引用」与[待办 N14](../../待办清单.md#n14)中的“真实QQ新图片”一项。方式是离线回归，加上主人在QQ里手动测试（主人发一张新图、要一个表情）。AI只读核对账本、权限日志、暂存目录和运行日志，过程中不发消息，不改配置，不重启服务，也没有运行 `scripts/fusion/test-*.mjs`。本文不粘贴聊天原文和图片内容。

结论：**不通过**。两步都失败，原因相同：QQ 图片 CDN 的域名在本机解析到代理的 Fake-IP 网段 `198.18.0.0/15`，宿主默认的 SSRF 防护把它当成内网地址拦截。频道能如实降级，不会假装看到了图片；账本、权限和外发链路都正常。

## 离线回归

2026-10-27 00:21:50，逐个指定 `chatbot/plugins/kurumi-qq/test/` 下的 `channel`、`stickers`、`presentation` 三个测试文件，共19项，全部通过。这三个文件只使用临时夹具和本地HTTP，不连运行目录。原始数据见 [checks.json（历史材料）](README.md#historical-material)。

## 测试前基线

基线取于2026-10-27 00:22，`epochMs=1793031724723`。当时 `kurumi-fusion.service` 状态为 active，入站账本382行，出站账本625行，权限事件315行，`media/inbound` 有15个文件。

## 真人测试核对

| 步骤 | 账本/日志事实 | 判定 |
| --- | --- | --- |
| 1 主人发新图 | 入站 `…:-569022561`（00:25:11，`onebot`，completed）；运行日志同一秒有 `blocked URL fetch targetOrigin=https://multimedia.nt.qq.com.cn reason=…private/internal/special-use IP`；`media/inbound` 无新文件；模型收到“部分图片未加载”提示，回复说明没看到图片，没有编造内容；出站2条，状态 sent | 入站图片 **失败**；降级提示 **符合预期** |
| 2 主人要表情 | 入站 `…:1502112895`（00:25:31，completed）；run `3d087cd3…` 中 `kurumi_sticker` 共5次调用，权限日志5次都是 `stickers.use allow`、`requesterIsOwner=true`；结果为1次参数校验失败、2次 list 成功、2次 send 失败，日志为 `blocked URL fetch targetOrigin=https://p.qpic.cn` 与 `Failed to fetch media`；出站2条均为文字，没有图片 | 表情外发 **失败**；权限判定与失败说明 **符合预期** |

同时间段还有一条无关出站 `paper-notice:job_368e…`（00:23:28），不计入本次结果。

## 原因

- 本机DNS把 `multimedia.nt.qq.com.cn`、`p.qpic.cn` 解析成 `198.18.0.38`、`198.18.0.39`。`assets2.e7.wiki` 同样解析到 `198.18.0.40`。
- `kurumi-qq/src/media.js` 的 `stageImage` 在入站图片和表情两条路上都调用 `saveRemoteMedia`，但没有传 `ssrfPolicy`，因此使用默认的严格策略，拒绝RFC 2544地址。
- 2026-10-05 的出站表情验收和CDN下载能通过，说明当时这些域名还没有走Fake-IP。`runtime.log` 中这两个QQ域名最早的拦截记录就是本次测试。
- 已有先例：2026-10-11 天气插件遇到同类问题（提交 `6faea7a`），修法是对单个精确Host使用 `ssrfPolicyFromHttpBaseUrlFakeIpHostnameAllowlist` 配合 `trusted_env_proxy`。`saveRemoteMedia` 的选项支持 `ssrfPolicy`。本次只做核对，**没有改代码**。

完整计数与ID见 [checks.json（历史材料）](README.md#historical-material)。

<a id="historical-material"></a>

## 历史原始材料的保留位置

本目录生成的原始回执、日志和图片已退出活动树；既有结论及失败状态不因此改变，也不代表新版已验收。已入Git的内容可用 `git show c849e63:<原仓库相对路径>` 读取；表中的blob标识可核对原始字节。未入Git的临时输出按本次清理授权丢弃。当前执行状态只在全局《整理记录.md》维护。

| 原文件 | 原报告顶层字段（仅摘录） | Git blob |
| --- | --- | --- |
| `checks.json` | 未提取；以原材料及现有结论为准 | `0e3886013872d01eab6ab56b4cc989024ced0ffa` |
| `retest-0119.json` | 未提取；以原材料及现有结论为准 | `cc45d0baa4ea1d635313e81989507a7367d50a22` |
