# E7第二批2A：社区配装与测评

日期：2026-10-29（北京时间）。任务N20.4，开发侧验证通过，当前待部署与主人QQ复验。规则：[文档27](../../../27_E7数据插件设计.md#第二批文本查询开发)。

主人在结构复核和开发顺序整理后回复“能否开始”，授权按组开始第二批文本查询。本组新增`builds/reviews`，复用`e7_data`、本人已有的`e7.read`、独立E7插件及缓存。没有增加原生工具、成员权限、主机、站点写接口或图片能力。用户此前要求及时本地提交；没有远端写入授权。

## 已验证结果

| 层次 | 结果 | 证据与边界 |
| --- | --- | --- |
| 离线E7 | 24项通过 | 合成数据、临时缓存与注入HTTP；新增配装字符串数值、百分数点/空值、组合条件、游标绑定及JSON字段换序、分类/空测评、错角色/异常数据保护、长文裁剪 |
| 权限/分层/人格 | 95项通过 | 既有真实处理器、合成身份、临时SQLite和本地模拟服务；包括本人准入、成员拒绝、撤权、共享包导入方向与独立生命周期；不等于真人验收 |
| 构建 | 通过 | E7语法检查；为较广回归先构建确认核心、确认入口与共享领域库。初次回归因新工作区未构建依赖而失败，补齐后95项全过，没有修改这些领域的实现 |
| 实际client | 8个查询、4次HTTP通过 | [首轮](live-2a.json)、[最终复测](live-2a-final.json)。真实E7公开读取、临时缓存；没有QQ外发或生产状态写入 |
| 隔离宿主 | 启用/禁用2组通过 | [host-2a.json](host-2a.json)。实际Gateway加载、工具目录、无启动预取和正常停止；没有模型/API/QQ网络 |
| 真实模型 | 4题全部通过 | [model-2a.json](model-2a.json)。现行官方DeepSeek、真实工具处理器与公开接口，合成可信主人上下文；不是完整Gateway/QQ入站。每题最多5轮、单次最多1600输出tokens；仅保留判定、调用元数据和回复哈希 |
| 生产与主人QQ | 待处理 | 合入后按受管模板同步、正常服务重载及四项自检；不启用`testIngress`或代发QQ，真人结果另记 |

实际取样：梅铃返回20条配装、0条测评；小春返回RTA/PVP/PVE/综合4类测评。梅铃配装首样本暴伤289表示289%，含装备，不是角色基础暴伤165%。套装与速度/暴伤组合筛选、无重复续页、缓存复用均通过。配装来源与更新时间保留，不推断最优解；测评保留作者和更新时间，不以配装补写不存在的测评。

新增HTTP固定为两个已验证的公开只读POST：`hero_equipment_scheme/getSchemeByHeroCode`使用`hero_code`，`hero_review/by-hero`使用`heroCode`。模型只能提供受校验的角色代码与查询条件，不能指定URL/请求体。单次结果继续默认5条、最多10条，完整工具结果预算16KiB；每日刷新仅原5类基础目录，社区资料按需缓存24小时。

2B的榜单/攻略/FAQ和2C的GVG/宿命/礼包已少量公开取样，但尚未接入工具。取样成功不登记为实现或生产开放。E7图片、公告PDF正文及真实兑换码可用性不在本组结论内。

## 可重复验证

```bash
npm --prefix chatbot/plugins/kurumi-e7 run build
node --test chatbot/tests/e7/*.test.mjs
node --test chatbot/tests/access-control/*.test.mjs chatbot/tests/backend-boundaries/*.test.mjs chatbot/tests/persona/*.test.mjs
node chatbot/tests/e7/acceptance-live.mjs --live --community-only --out /absolute/new-live-report.json
node chatbot/tests/e7/acceptance-host.mjs --out /absolute/new-host-report.json
node chatbot/tests/e7/acceptance-live.mjs --live --community-only --model --out /absolute/new-model-report.json
```

实际HTTP/模型脚本须显式选择执行，不能当离线测试批量运行；输出路径必须尚不存在。运行只读取私密配置所指的代理/模型凭据，不记录其内容，不复制私聊、生产缓存或完整wiki数据。
