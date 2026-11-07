# 系统资产、备份与回退管理

<a id="目录资产与-git备份管理"></a>

本文维护资产与恢复契约。当前阶段、指定版本、恢复点和任务状态以唯一全局手册 [整理记录.md](/home/afrangry/.openclaw-fusion/整理记录.md) 为准。历史材料中的体积、SHA、运行结论仅属于当时范围，不能当作当前恢复证明。

Fusion执行隔离原生包固定在`.openclaw-fusion/tools/node-addon-system-linux-x64`，由`config/exec-fence-release.json`约束版本/完整树指纹，`install-exec-fence.mjs`负责校验导入；含许可证、单独进入exec-fence工件。它与DSH整体安装生命周期分离，不改变现有试点写入权限。操作后核对两个launcher及依赖自检，验证依据见[本轮编码报告](verification/coding-autonomous-2026-11-07/README.md)。

## 资产归属

| 资产 | 位置 | 边界 |
| --- | --- | --- |
| 日常源码与配置意图 | `/home/afrangry/kurumi-fusion` | 唯一日常Fusion仓库；main单线维护；未上线确认修复保留冻结标签 |
| 私有运行状态 | `/home/afrangry/.openclaw-fusion` | 身份、凭据、人格投影、会话、记忆、SQLite和产物；不建运行根Git |
| 私密备份 | `/home/afrangry/kurumi-backups` | 统一恢复点、指定版本工件及必要离线历史；700目录/600文件 |
| 编码试点 | `/home/afrangry/.local/share/kurumi-coding-pilot-20261029` | 保留既有普通文件写入窄边界及功能必需Git/profile，不是第二个日常Fusion开发仓库；测试任务、输出与工作树已结束，必须纳入Fusion恢复范围 |
| OpenClaw安装 | `/home/afrangry/.npm-global/lib/node_modules/openclaw` | 指定版本第三方内核；扩展不直接改内核，隔离适配通过后才能替换；当前版本见全局手册 |
| 外部项目接口 | KnowledgeMap业务API、DeepSeek Harness | 两者都是独立项目；Fusion只保留自身的接口配置、专用接口凭据和业务/试点控制状态，不采集它们的源码、数据库、安装或全局认证 |
| QQ传输 | SnowLuma、QQ及登录配置 | 实际运行依赖，保留认证/版本/安装信息；隔离恢复使用模拟OneBot，不声称恢复真实QQ登录 |
| 已退役现场 | 原projects/fusion、worker原型、旧功能工作树 | 先保护独有历史再退役；不由旧提示词/脚本自动重建 |

## Git 与实时状态查询

日常在唯一主目录核对 `git status --short`、`git log -1`、`git worktree list`。配置/人格/依赖/服务健康只证明部署对齐，不证明已提交或推送。远端写入须用户明确授权；本轮不push。冻结标签只表示成果可恢复，不表示已经合入或部署。

读取远端时避免输出带凭据的URL；`git ls-remote`只证明可读及返回引用，仍不证明当前未提交文件已保存。

## 推荐管理方式

一次推进一个明确任务，开始前读全局手册；必要实验才短期隔离，完成后收录/冻结并退役工作树。使用Git记录源码，不把数据库、聊天和凭据塞进源码仓库；使用一致私密快照保护运行数据。原独立后台源码副本不再维护。

## 备份资产与保留规则

新备份仍使用格式v3，并显式标记`scope: fusion-only`。内核、论文Python环境及执行写入边界的原生辅助包保存为统一根artifacts中的内容寻址工件，恢复点逐项记录版本、源码树指纹及压缩包SHA256，重复点复用同一工件；未验证的工件不算可恢复。原生辅助包是Fusion实际使用的`@deepseek-ai/node-addon-system-linux-x64`依赖（含许可证），并非整套DSH；隔离恢复将其还原到Fusion私有tools目录并改写launcher路径。数据库发现不限制四层目录，同时识别.sqlite/.db并排除明确可重建缓存；保留Fusion拥有的编码试点Git、profile和控制状态，不采集DSH独立安装、全局认证或dsh-web服务单元。

未标记scope的既有v3点维持原契约，恢复器仍接受其中的DSH工件与认证材料；不得拆改既有点来假装转换范围。新点恢复验证要求真实DSH缺失时编码策略拒绝执行；仅用`/usr/bin/false`作为不执行的可用性夹具检查其余Git/目录策略，并由真实Linux辅助程序验证目录内可写、目录外拒绝。不运行DSH；实际使用编码能力还需独立DSH项目可用，不能把该夹具当成真实后端恢复。

备份工具为 `scripts/fusion/backup-state.mjs`，隔离验证为 `restore-verify.mjs`。指定恢复点必须包含源码历史与实际工作文件、受管/私有配置、全部保留SQLite的一致快照、人格/身份、业务控制、编码试点及指定版本工件/依赖重建定义。保留范围、排除项和缺失项应进入清单，失败或中断的材料不得算通过。

可重建依赖、诊断日志、临时捕获、旧测试论文和冗余回退副本不作为正式数据再次复制。第三方依赖须具备可验证的重建或配套工件；不能仅写“可重建”就删掉唯一安装。KnowledgeMap数据库属于外部依赖，Fusion恢复测试使用隔离模拟API，不对其生产写入。

滚动保留最近两个经过实际隔离恢复的点；新点完整通过并登记哈希绑定的VERIFIED后才淘汰被替代点。随后只删除已无任何保留/未完成点引用、且元数据与SHA256均有效的托管工件。未知文件不自动删除，采集锁存在时拒绝执行保留清理。唯一源码历史单独保留，不把Git冻结标签当成可部署状态或私密数据备份。

统一根的长期内容为恢复点、共享artifacts、唯一history和简短README导航；`.working`仅允许有消费者的短期预像，验证后退役。五份既存KnowledgeMap独立备份保持原路径和内容，明确排除Fusion自动保留与删除；它们不是Fusion恢复点。SnowLuma目录内四份旧备份均属DSH历史资料，按独立项目边界不在本次Fusion清理中处理。

配置同步只在统一根的`.working/config-sync/openclaw.before.json`留下最近待验证预像；发布验证后删除。宿主`openclaw.json.last-good`有实际消费契约，作为运行保护保留。

## 旧系统回退

旧A/B整体重建承诺已结束，以当前Fusion的成套恢复点代替；原“未真人启动验收”不改写为通过。旧迁移和原型入口已从活动源码移除，可从Git历史追溯。原归档物理目录已在R1验证、独有Git历史保护后退役；实时恢复点见全局手册。

升级若迁移了数据库，回退必须恢复对应旧版本内核和配套旧状态；不能把旧二进制直接接到升级后的库。旧消费者保持屏蔽，不与Fusion同时运行；恢复前停掉当前写入方，隔离验证时禁止QQ/邮件/真实业务外发。

`kurumi-baselines`曾经被删除，旧忽略文件没有逐项证明被等价覆盖；当前材料不能补回那个历史时点，不宣称重新获得迁移前完整基线。

## 尚待处理

全部阶段任务与未验收项统一见全局手册。功能契约见文档9、16、23、28；本文件不再复制另一份排期或旧恢复点清单。

内核批准版本与Node范围统一在 `config/openclaw-release.json`，启动、依赖链接、依赖校验和备份共同读取；npm依赖声明仍按锁文件记录兼容约束。旧A/B恢复脚本及旧迁移源路径模块已经退役，历史可从Git追溯。

实际隔离恢复成功后执行 `node scripts/fusion/backup-retention.mjs --record /tmp/<恢复目标>/verification.json`，生成与EXPECTED/MANIFEST哈希绑定的VERIFIED回执。默认预览最近两个已验证v3点及相应工件保留计划；`--apply`淘汰该集合中的多余点和不再被引用的已校验托管工件。失败/中断点不冒充恢复点，其已声明的工件引用仍受保护；旧项目材料不按此命令批量删除。整个统一根连同artifacts一起搬移才具备完整恢复输入，单独复制一个点不够。

QQ插件将宿主OpenClaw声明为可选peer：实际宿主版本由统一版本源/依赖校验强制，插件自身npm ci只重建锁定的业务依赖，避免另装一份OpenClaw。首轮R1演练实际发现并修复此锁文件重建缺口，失败候选不登记为有效点。

旧版R1（源码ce9835f / OpenClaw2026.9.7）曾25/25隔离恢复通过，升级及回退验证已完成；它不作为永久固定保留点，按最近两点规则替换，实际现存点见全局手册。旧Fusion快照与kurumi-archive物理目录已退役，必要独有源码历史集中在私密history/，它不承诺恢复旧A/B运行。五个独立KnowledgeMap备份保持原样。

升级隔离演练可对R1指定`restore-verify.mjs --adapt-source <本地bundle> --adapt-sdk <工件tar.gz>`；两项必须成对，原R1不变，仅替换隔离副本代码/内核并迁移其数据库。此模式结果标为upgrade-rehearsal，不能登记成生产恢复点或替代R1/R2。

适配演练按新源码的受管意图和身份配置生成隔离配置，按新锁文件安装外部插件，再在无生产路径/网络的命名空间运行官方doctor --fix；检查全部保留agent schema到批准版本、权限/插件意图不变后才启动。生产切换必须先准备回退状态，停Fusion，替换已验证工件/源码，安装锁定provider、同步受管配置、官方迁移后再启服务。

官方Doctor可能产生配置bak、数据库迁移原件、完成清单与相邻update-captures。它们只作为当前升级的临时回退材料；确认迁移完成并有独立成套恢复点后，集中到统一根的有限工作区，验证R2后退役。不得删除未完成迁移、活动更新或未知来源材料。配置bak不进入正式快照，last-good继续保留。

清单中的符号链接以 `symlink:<链接目标>` 的SHA256记录；请用restore-verify核验，普通 `sha256sum -c` 会跟随链接，不能替代本格式验证。
