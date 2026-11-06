# 单目录DSH与QQ试点（2026-10-30）

归属：[文档28](../../../28_本机编码工具委托与实验任务.md#单目录qq试点授权2026-10-30)、[文档16](../../../16_验收与测试总表.md)、[配置契约](../../../../config/README.md)。前置实现和局部结果见[上一轮报告](../product-pilot-2026-10-29/README.md)。

状态：**已部署，待真人QQ验收（处理中）**。主人在本轮明确同意启用与真实QQ试点；仅开放`/home/afrangry/.local/share/kurumi-coding-pilot-20261029`。授权包含审阅差异后同步受管配置、重启Fusion、真实模型调用及本人QQ测试。额外目录申请逐项记录并拒绝，后续开放由主人判断；具体候选合入仍需另行确认，不包含push或共享DSH服务启停。

目录写入边界、临时/会话存储归属、权限请求累计与脱敏已补齐并验证。受管配置及主人模板已同步、Fusion已重启；尚无真人QQ发起的编码任务，未把准备、合成入站或本地模型测试写成真人QQ闭环。

## 已完成的目录边界预检

- 离线编码套件23项通过，含真实子进程的目录内写入、目录外创建/覆盖/截断/删除/移动/符号链接写入拒绝，以及检查命令同等限制；runner不可用时拒绝启动。权限申请跨续接累计、重复RPC去重、未知关联保留并拒绝及公开日志不含原始理由通过。
- 真实DSH在上述目录中完成1次编码prompt，新增clamp与Node测试，固定检查和项目检查通过，源`main`和未跟踪草稿未改动；无ACP额外申请。真实QQ层仍待部署与主人发起，见[结构化结果（历史材料）](README.md#historical-material)。
- 第一次预检在模型调用前被拦住：启动器试图重写`/var/lib/dsh/.dsh/profiles/acp/cordis.yml`，1次、未放行。这是启动期写入尝试，**不是模型发出的ACP申请**。私有stderr及`permission-review/operational-denials.jsonl`留在试点目录；原因从已安装启动器`prepareProfile`源码核实。改用试点目录内独立`DSH_HOME`，原凭据通过原有provider显式只读复用，无需放宽共享目录权限。
- 当前Linux 6.8/runner报告`partial`（旧ABI）；已验证上述普通文件内容操作，不宣称阻止所有文件元数据、网络或进程副作用。工作树仍只承担Git工作内容隔离。

## 旧入口的目录保护

首次同步并重启后确认`kurumi-coding`已active、主人工具目录有`kurumi_code`，健康通过。发送真人测试指令前核对人格模板，发现旧文案仍将代码交给`kurumi_task`的fusion开发副本。为落实本轮只开放试点目录，在源码为旧入口补充`codeEnabled=false`配置门禁并更新主人模板：新编码请求仅走`kurumi_code`，旧研究任务及历史状态/取消不受影响。该项收紧不授权旧副本写入，也不通过提示词代替后端门禁；变更验证并按配置/人格同步契约生效后再进行真人测试。

## 实际部署与QQ进度

- 本地源码`9eb6eeb`及旧路由保护`15b06b6`已合入主目录，保留其16项其他未提交文件的状态和内容；未push。受管配置先核对4处新增，再核对旧入口1处收紧；两次按契约apply/restart，无未审阅差异。主人模板只同步`workspace/AGENTS.md`，未复制记忆/历史。
- 实际`kurumi-coding`、`personal-confirmation`、`kurumi-tasks`及QQ插件active，主人目录有`kurumi_code`；通用deny保留，旧`kurumi_task`新编码启动关闭，`testIngress=false`。共享`dsh-web.service`保持active、MainPID `4174530`，没有执行DSH/Fusion切换脚本。见[部署结果（历史材料）](README.md#historical-material)。
- `health.mjs`、`verify-dependencies.mjs`、`sync-config.mjs --diff`及`sync-persona.mjs --diff`四项通过；依赖自持、配置与人格对齐不等于真人QQ闭环。
- 已通过QQ公开投递接口向配置中的本人发送试点说明，并取得真实OneBot回执，见[回执（历史材料）](README.md#historical-material)。这里只证明平台受理这条说明；真人读取、QQ发起编码、续接、候选确认/合入及任务完成通知仍需实际证据。主人从QQ发起后再核对任务映射与权限记录，不启用模拟入站。

## 真实权限申请拒绝验证

另起独立DSH合成会话，要求一个不写文件的`printf`命令显式申请`danger-full-access`。实际收到1次ACP请求，与先前真实toolCall和当前session关联；私有请求内容/理由保留，单次拒绝返回、没有批准，DSH结束回合，源项目未改动。见[结果（历史材料）](README.md#historical-material)。请求未提供可据以判断写入目标的结构化路径，scope保持`unknown`，不以命令看似无害自动授予更大权限。**这是人工诱发的功能检查，不能计入正常编码所需权限的频率。**

## 目录内普通文件与主机只读命令试验

真实DSH在另一个合成工作树完成普通文件创建、重命名、移动、复制与删除副本，宿主核对最终内容及旧路径已消失；固定/项目检查通过，源项目未改动，额外ACP申请0次。[结构化结果（历史材料）](README.md#historical-material)保留实际`free -h`/`ss -ltn`的toolCall/result关联，未导出主机端口或内存原始输出。这是本地执行工具侧的验证，不能据此宣称独立QQ主机查询入口、项目外文件操作或受管PDF重命名已验收。

本轮真实DSH共3次prompt：正常编码1次、目录内文件/查询试验1次、人工诱发权限申请1次；prompt数不是上游请求数或费用。正常试验额外ACP申请0次，人工诱发1次拒绝，启动期目录外重写1次拒绝，开放额外目录0个。私有原始资料全部留在试点目录。观察期间未出现真人QQ编码任务，因此真实发起/续接/候选确认合入/完成收件保留待验收，未自动合入任何试点结果。

## 本轮收尾与短期跟进

最终四项运行自检和身份策略只读校验通过，主目录文档归属/脚本索引/本地链接检查通过；[收尾记录（历史材料）](README.md#historical-material)区分了正常本地试验、人工诱发权限申请和启动期拒绝。2026-10-30 10:05（Asia/Shanghai）核对时，真实QQ编码任务仍为0，不能签收真人闭环。

按主人“运行时盯一下、记录权限申请”的要求，已建立本对话的短期只读心跳`dsh`，每5分钟观察，计划在当日12:05（Asia/Shanghai）结束并暂停。无新任务或状态不变时保持安静，只在新权限申请、失败/需要决定或完成/投递变化时提示；不发起、续接、取消或合入任务，不批准扩权、不外发QQ。观察结束后，插件的私有权限累计记录继续保留，后续开放由主人决定。

<a id="historical-material"></a>

## 历史原始材料的保留位置

本目录生成的原始回执、日志和图片已退出活动树；既有结论及失败状态不因此改变，也不代表新版已验收。已入Git的内容可用 `git show c849e63:<原仓库相对路径>` 读取；表中的blob标识可核对原始字节。未入Git的临时输出按本次清理授权丢弃。当前执行状态只在全局《整理记录.md》维护。

| 原文件 | 原报告顶层字段（仅摘录） | Git blob |
| --- | --- | --- |
| `closure.json` | 未提取；以原材料及现有结论为准 | `82566014dc1911f7af00c1c6c8150a23f34a1aef` |
| `configuration-additions.json` | 未提取；以原材料及现有结论为准 | `c1e1397de45dfbf3e68c6a2136c0be1691d30947` |
| `deployment.json` | at=2026-10-30T01:50:12.421Z | `9cfd50e6a411372f718233788b5712e60fc89c7c` |
| `file-operations.json` | ok=True；at=2026-10-30T01:55:15.121Z | `b6efedb6b20969644eda362ffb81103f88fc0f6d` |
| `host.json` | passed=True；at=2026-10-30T01:42:10.604Z | `c37c34f70710cc406fb15bf29c01ec4b4de5dd27` |
| `implementation-hashes.json` | 未提取；以原材料及现有结论为准 | `b9e15695f0d7ad57eab82b8d1cc3f0faae568926` |
| `permission-rejection.json` | ok=True；at=2026-10-30T01:52:52.635Z | `dff6c9e15337fa12e2ba028ad127827b66243b70` |
| `preflight.json` | ok=True；at=2026-10-30T01:39:15.328Z | `efe929b1ec3f9ea0072346b085f10785fdedd319` |
| `qq-instruction-receipt.json` | at=2026-10-30T01:49:21.788Z | `17bea812791e92df138aa86dbc6c5f39beafc639` |
| `validation.json` | 未提取；以原材料及现有结论为准 | `9dcee5029330a188f326d91aecb5e76029e0f967` |
