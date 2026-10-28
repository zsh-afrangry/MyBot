# 受管PDF改名的范围核对

日期：2026-10-28（Asia/Shanghai）。源码基点：`c9672b5086ebd3f0733fb13309db2bc26176bf33`。状态：**已验收（仅源码核对与文档检查）**；业务需求[N24](../../../待办清单.md#n24)尚未实现或启用。

用户在讨论本机编码委托时反馈QQ助手无法给受管PDF改名，并要求判断是否由本次开发涵盖。此次核对只读源码，不读取实际PDF、聊天、运行文档记录或凭据，不修改生产文件、配置或权限，不启动模型/编码工具、外发或重启。

## 代码依据

- `chatbot/plugins/kurumi-papers/index.js`：`kurumi_document`仅有`list/get/find/fetch`；无重命名接口。
- `chatbot/packages/documents/index.js`：内容哈希导出稳定文档ID，内部文件路径固定为`files/<id>.pdf`；`filename`是独立记录字段，按名查找包括该字段。
- `chatbot/plugins/kurumi-qq/src/files.js`：QQ文件上传的`file`取内部路径，`name`取`doc.filename`。内部哈希名不要求QQ显示相同名称。
- `chatbot/packages/access-control/permissions.js`：文档工具动作有显式权限映射，未知动作拒绝；新增写入动作不能借用现有工具白名单默认放行。

## 结论与归属

编码委托可以在授权项目/实验目录处理普通PDF文件的重命名；受管论文库的对外名称维护属于[论文模块关联需求](../../../22_论文PDF翻译与文件投递.md#受管pdf重命名关联需求)，不会因接入编码CLI或ACP自动获得。建议新增受管名称维护动作，保留内部文件、ID、哈希及既有引用；这不是将通用文件权限开放给编码工具。

需求已登记N24，[文档28](../../../28_本机编码工具委托与实验任务.md#普通文件与受管pdf的边界)补充普通文件/受管文档边界及CLI启动形式与原生会话管理的区别。N24不等于G5旧记录题名补全，两者继续分别维护。

此次只完成代码事实和需求归属核对；未实现重命名、未改真实文件，也未进行真实模型或QQ改名验收。本目录由现有`paper-translation-2026-10-17/`证据组与INDEX整组条目覆盖，未新增归属规则。

## 本轮文档检查

以下检查均退出0；文档检查在Codex worktree执行，主目录同期存在另一项历史指引归档改动，未将它的未提交内容纳入本次提交。

| 检查 | 实际范围与结果 |
| --- | --- |
| `node scripts/fusion/evidence-coverage.mjs` | 646份证据全部有唯一有效归属；新增记录继承论文证据组 |
| `node scripts/fusion/evidence-index.mjs --check-markdown` | 212项脚本生成索引一致；归属规则未改，无须重跑其隔离回归 |
| 本地Markdown链接/锚点/围栏扫描 | 114份文档、2069个本地链接，无错误 |
| `git diff --check` | 本次文档差异无空白错误 |
| `health.mjs`、`verify-dependencies.mjs`、`sync-config.mjs --diff`、`sync-persona.mjs --diff` | 从`/home/afrangry/kurumi-fusion`只读执行，四项通过；`testIngress=false`，未apply或重启，不把主目录依赖可用推定为worktree依赖齐备 |

将本轮四个文件的独立提交本地合入主目录；合入前核对目标文档未被并行修改，其他16个并行改动路径按字节哈希保留。不执行远端写入。

返回[文档入口](../../../README.md)。
