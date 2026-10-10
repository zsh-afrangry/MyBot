// Build the verified script/evidence index required by 清单 C05 (corrected per R02).
//
// Design, revised after the 2026-10-10 independent re-verification:
//   1. Scan scope covers every runnable script and test, including the 22 TypeScript sources under
//      */src/*.test.ts that the first version missed, plus fixtures and helper libraries.
//   2. Every row names a `basis` for its classification: "boundary" (the script's own
//      machine-readable declaration), "header" (its top comment), "code" (read from the source),
//      or "offline" (an in-process unit test).
//   3. Cross-check: many acceptance scripts declare a `boundary:` string. This generator parses it
//      and FAILS when the table contradicts the declaration — e.g. a script that declares
//      "no model" or "no QQ network" but is labelled as calling a real model or sending QQ. That
//      contradiction is exactly what R02 found in the first version (run.mjs, verify-restart.mjs).
//
// Side-effect vocabulary:
//   model       真实模型 API 调用
//   externalApi 真实外部 API（Tavily / QWeather / GeoAPI / 论文站点）
//   qq          真实 QQ 外发或投递
//   task        创建/修改任务、Cron、提醒
//   restart     启动或停止服务/进程
//   writesState 写运行目录（.openclaw-fusion）状态
//   writesRepo  写仓库内文件（docs/verification 等）
//   testDir     只写临时隔离测试目录
//   readonly    无写入
//   auth        需操作者授权后运行
//
// Usage:
//   node scripts/fusion/evidence-index.mjs             # human summary
//   node scripts/fusion/evidence-index.mjs --json
//   node scripts/fusion/evidence-index.mjs --markdown  # table for docs/verification/SCRIPTS.md
import fs from 'node:fs';
import path from 'node:path';
import {REPO_ROOT} from './lib/legacy-source.mjs';

const ROOT = REPO_ROOT;

// [group, purpose, flags, basis]
const TABLE = {
  // ---- 离线单元测试：进程内，无外发、无真实模型 ----
  'chatbot/plugins/kurumi-qq/test/channel.test.js': ['离线', 'QQ 频道分段、配额、账本与幂等', {readonly: 1}, 'offline'],
  'chatbot/plugins/kurumi-qq/test/presentation.test.js': ['离线', 'QQ 呈现与分段节奏', {readonly: 1}, 'offline'],
  'chatbot/plugins/kurumi-qq/test/stickers.test.js': ['离线', '表情目录与发送边界', {readonly: 1}, 'offline'],
  'chatbot/plugins/kurumi-memory/test/memory.test.js': ['离线', '长期记忆读写、版本与损坏拒绝', {readonly: 1}, 'offline'],
  'chatbot/plugins/kurumi-tasks/test/task.test.js': ['离线', '后台任务工具的所有权与绑定', {readonly: 1}, 'offline'],
  'chatbot/plugins/kurumi-tasks/test/git.test.js': ['离线', '副本内受限 Git 提交范围', {readonly: 1}, 'offline'],
  'chatbot/plugins/kurumi-tasks/test/sandbox.test.js': ['离线', 'Bubblewrap 隔离边界与进程树终止', {readonly: 1}, 'offline'],
  'chatbot/plugins/kurumi-research/test/papers.test.js': ['离线', '论文来源校验与拒绝规则', {readonly: 1}, 'offline'],
  'scripts/fusion/test/recovery.test.mjs': ['离线', '备份/恢复工具单元与集成回归', {readonly: 1}, 'offline'],
  'scripts/fusion/fixtures/test_stats.py': ['离线', '固定验收 fixture：后台代码任务的 mean/moving_average 断言', {readonly: 1}, 'code'],
  'chatbot/tests/acceptance/call-analysis.test.mjs': ['离线', '旧调用分析离线断言（读取两份输入样本）', {readonly: 1}, 'offline'],

  // ---- TypeScript 源码测试（R02 指出第一版漏掉的 22 个）----
  'chatbot/packages/confirmation-core/src/confirmation.test.ts': ['离线', '确认核心：提案校验、TTL、幂等与 grant 消费', {readonly: 1}, 'offline'],
  'chatbot/packages/confirmation-core/src/public-id.test.ts': ['离线', '公开 ID 脱敏与冲突规避', {readonly: 1}, 'offline'],
  'chatbot/plugins/personal-confirmation/src/inbound.test.ts': ['离线', '确认入站插件：身份绑定与重放拒绝', {readonly: 1}, 'offline'],
  'chatbot/plugins/personal-confirmation/src/index.test.ts': ['离线', '确认入站插件装配与工具暴露', {readonly: 1}, 'offline'],
  'chatbot/plugins/personal-weather/src/clarification-gate.test.ts': ['离线', '地点歧义澄清闸门', {readonly: 1}, 'offline'],
  'chatbot/plugins/personal-weather/src/config.test.ts': ['离线', '插件配置解析与默认值', {readonly: 1}, 'offline'],
  'chatbot/plugins/personal-weather/src/confirmation-gate.test.ts': ['离线', '领域确认闸门', {readonly: 1}, 'offline'],
  'chatbot/plugins/personal-weather/src/controlled-replies.test.ts': ['离线', '受控回复与原文交付', {readonly: 1}, 'offline'],
  'chatbot/plugins/personal-weather/src/formatter.test.ts': ['离线', '天气输出格式与地点保真', {readonly: 1}, 'offline'],
  'chatbot/plugins/personal-weather/src/index.test.ts': ['离线', '天气插件工具注册与装配', {readonly: 1}, 'offline'],
  'chatbot/plugins/personal-weather/src/native-reminder-scheduler.test.ts': ['离线', '原生提醒调度适配', {readonly: 1}, 'offline'],
  'chatbot/plugins/personal-weather/src/parsers.test.ts': ['离线', '自然语言时间与地点解析', {readonly: 1}, 'offline'],
  'chatbot/plugins/personal-weather/src/planning.test.ts': ['离线', '行程提案与事务提交', {readonly: 1}, 'offline'],
  'chatbot/plugins/personal-weather/src/profile.test.ts': ['离线', 'Profile 当前所在地读写', {readonly: 1}, 'offline'],
  'chatbot/plugins/personal-weather/src/qweather-client.test.ts': ['离线', 'QWeather 客户端请求构造与拒绝规则', {readonly: 1}, 'offline'],
  'chatbot/plugins/personal-weather/src/reminder-gateway.test.ts': ['离线', '提醒与 Gateway 对账', {readonly: 1}, 'offline'],
  'chatbot/plugins/personal-weather/src/reminder-reconciler-service.test.ts': ['离线', '提醒 reconciler 服务循环', {readonly: 1}, 'offline'],
  'chatbot/plugins/personal-weather/src/reminder-reconciler.test.ts': ['离线', '提醒 reconciler 判定与退避', {readonly: 1}, 'offline'],
  'chatbot/plugins/personal-weather/src/reminders.test.ts': ['离线', '提醒提案、修改与取消', {readonly: 1}, 'offline'],
  'chatbot/plugins/personal-weather/src/store.test.ts': ['离线', '领域 SQLite 存储与迁移', {readonly: 1}, 'offline'],
  'chatbot/plugins/personal-weather/src/weather-location.test.ts': ['离线', '天气地点解析与叶子名保留', {readonly: 1}, 'offline'],
  'chatbot/plugins/personal-weather/src/weather-service.test.ts': ['离线', '天气服务聚合与失败语义', {readonly: 1}, 'offline'],

  // ---- 只读运维与库：不写状态、不外发 ----
  'scripts/fusion/health.mjs': ['只读运维', '服务、QQ、频道、Cron、数据库健康', {readonly: 1}, 'header'],
  'scripts/fusion/probe-final.mjs': ['只读运维', 'health.mjs 的兼容入口', {readonly: 1}, 'header'],
  'scripts/fusion/stack-summary.mjs': ['只读运维', '启停输出压缩显示', {readonly: 1}, 'header'],
  'scripts/fusion/verify-dependencies.mjs': ['只读运维', '依赖自持、无归档树逃逸、锁文件一致', {readonly: 1}, 'header'],
  'scripts/fusion/sync-config.mjs': ['只读运维', '默认只报告配置漂移；--apply 才写 openclaw.json', {readonly: 1, writesState: 1}, 'header'],
  'scripts/fusion/sync-persona.mjs': ['只读运维', '默认只报告人格漂移；--apply 才写 workspace 四份文件', {readonly: 1, writesState: 1}, 'header'],
  'scripts/fusion/evidence-index.mjs': ['只读运维', '生成本脚本与证据索引', {readonly: 1}, 'header'],
  'scripts/fusion/evidence-coverage.mjs': ['只读运维', '校验证据目录分类覆盖，未分类即非零退出', {readonly: 1}, 'header'],
  'scripts/fusion/inspect-receipts.mjs': ['只读运维', '查看验收回执', {readonly: 1}, 'code'],
  'scripts/fusion/rpc.mjs': ['库', 'Gateway RPC 客户端库（被其他脚本导入）', {readonly: 1}, 'code'],
  'scripts/fusion/lib/fresh-id.mjs': ['库', '生成不重复的 message id', {readonly: 1}, 'header'],
  'scripts/fusion/lib/plugins.mjs': ['库', '第三方插件声明（纯数据，导入无 I/O）', {readonly: 1}, 'header'],
  'scripts/fusion/lib/recovery-isolation.mjs': ['库', '隔离恢复的路径与凭据改写', {readonly: 1}, 'header'],
  'scripts/fusion/lib/working-tree-backup.mjs': ['库', '已跟踪修改的 Git 补丁归档', {readonly: 1}, 'header'],
  'scripts/fusion/lib/backup-service.mjs': ['库', '备份期间停写并恢复服务', {restart: 1}, 'header'],
  'scripts/fusion/lib/legacy-source.mjs': ['库', '解析旧 OpenClaw 源树路径（仅迁移脚本用）', {readonly: 1}, 'header'],
  'chatbot/tests/acceptance/call-analysis.mjs': ['库', '旧验收调用观察工具（只观察，不证明写入）', {readonly: 1}, 'header'],
  'chatbot/tests/acceptance/domain-fixture.mjs': ['库', '旧验收领域夹具与工具定义', {readonly: 1}, 'code'],
  'chatbot/tests/acceptance/host-driver.mjs': ['库', '旧 harness Host 驱动，只开测试状态目录', {readonly: 1, testDir: 1}, 'code'],
  'chatbot/tests/acceptance/model-driver.mjs': ['库', '旧 harness 模型驱动（构造模型客户端，读取遗留 AGENTS）', {model: 1}, 'code'],
  'chatbot/tests/acceptance/retrieval-config.mjs': ['库', '旧验收检索输出预算配置', {readonly: 1}, 'header'],

  // ---- 写运行状态的运维工具：需操作者明确执行 ----
  'scripts/fusion/backup-state.mjs': ['运维写状态', '制作备份；--quiesce 会短暂停写并恢复服务', {auth: 1, writesState: 1, restart: 1}, 'header'],
  'scripts/fusion/restore-verify.mjs': ['运维写状态', '隔离恢复演练（只写新建 /tmp 目标）', {auth: 1, testDir: 1}, 'header'],
  'scripts/fusion/restore-legacy.sh': ['运维写状态', '按 A/B 方案把旧系统复制回原路径（不自动启动）', {auth: 1, restart: 1}, 'header'],
  'scripts/fusion/recovery-probe.mjs': ['运维写状态', '仅供 restore-verify 在沙箱内启动 Gateway', {auth: 1, testDir: 1}, 'header'],
  'scripts/fusion/install-service.mjs': ['运维写状态', '首次切换 systemd 单元到融合服务', {auth: 1, restart: 1}, 'header'],
  'scripts/fusion/install-plugins.mjs': ['运维写状态', '按锁文件安装受控第三方插件', {auth: 1, writesState: 1}, 'header'],
  'scripts/fusion/link-dependencies.mjs': ['运维写状态', '固定并链接本地 SDK 只读依赖', {auth: 1, writesState: 1}, 'header'],
  'scripts/fusion/run-gateway.mjs': ['运维写状态', '前台生产入口；日常只由 systemd 启动', {auth: 1, restart: 1, model: 1, writesState: 1}, 'header'],
  'scripts/fusion/stop-gateway.mjs': ['运维写状态', '按环境证明停止隔离 Gateway', {auth: 1, restart: 1}, 'header'],
  'scripts/fusion/close-acceptance.mjs': ['运维写状态', '验收结束后关闭 testIngress，不重置发送账本', {auth: 1, writesState: 1}, 'header'],
  'scripts/fusion/copy-domain-state.py': ['运维写状态', '迁移领域状态库（迁移工具，不是日常命令）', {auth: 1, writesState: 1}, 'code'],
  'scripts/fusion/register-project.mjs': ['运维写状态', '维护 projects.json 登记（默认只预览，--apply 才写）', {auth: 1, writesState: 1}, 'header'],

  // ---- 一次性迁移/引导工具 ----
  'scripts/fusion/prepare.mjs': ['迁移工具', '首次引导隔离运行目录，拒绝覆盖已写内容', {auth: 1, writesState: 1}, 'header'],
  'scripts/fusion/configure-deepseek-persona.mjs': ['迁移工具', '一次性切到 DeepSeek+小鲸鱼；日常禁用作人格入口', {auth: 1, writesState: 1, model: 1}, 'header'],
  'scripts/fusion/configure-domains.mjs': ['迁移工具', '启用主人绑定领域插件', {auth: 1, writesState: 1}, 'header'],
  'scripts/fusion/configure-fulltext-research.mjs': ['迁移工具', '研究会话、笔记工作区与来源缓存', {auth: 1, writesState: 1}, 'header'],
  'scripts/fusion/configure-interaction.mjs': ['迁移工具', '复制表情目录并设定迁移/每日发送预算', {auth: 1, writesState: 1}, 'header'],
  'scripts/fusion/configure-persona-memory.mjs': ['迁移工具', '只导入稳定的主人字段进私有记忆', {auth: 1, writesState: 1}, 'header'],
  'scripts/fusion/configure-production.mjs': ['迁移工具', '关闭仅验收能力，保留历史；需先审阅活动任务', {auth: 1, writesState: 1}, 'header'],
  'scripts/fusion/configure-projects.mjs': ['迁移工具', '一次性首次引导：只在 id 不存在时追加登记并写运行 openclaw.json', {auth: 1, writesState: 1}, 'header'],
  'scripts/fusion/configure-research.mjs': ['迁移工具', '配置检索 provider 与抓取路径', {auth: 1, writesState: 1}, 'header'],
  'scripts/fusion/configure-worker.mjs': ['迁移工具', '显式配置隔离代码 worker', {auth: 1, writesState: 1}, 'header'],

  // ---- 整套启停 ----
  'scripts/fusion/launchers/Start-DSH.sh': ['启停脚本', '启动 DSH Web + 融合栈，停旧消费者', {auth: 1, restart: 1}, 'header'],
  'scripts/fusion/launchers/Stop-DSH.sh': ['启停脚本', '按消费者优先顺序停止整套栈', {auth: 1, restart: 1}, 'header'],

  // ---- 当前融合验收：副作用按各脚本自己的 boundary 声明标注 ----
  'scripts/fusion/test-background-code.mjs': ['验收', '后台代码任务登记检查与终态', {auth: 1, model: 1, qq: 1, task: 1, writesState: 1, writesRepo: 1}, 'header'],
  'scripts/fusion/test-domain-read.mjs': ['验收', '领域只读自然语言验收，不发 QQ、不写偏好', {auth: 1, model: 1, writesRepo: 1}, 'header'],
  'scripts/fusion/test-domain-due.mjs': ['验收', '提醒到点投递（跨重启）', {auth: 1, model: 1, qq: 1, task: 1, writesState: 1, writesRepo: 1}, 'header'],
  'scripts/fusion/test-domain-planning.mjs': ['验收', '行程提案与确认写入（隔离库）', {auth: 1, model: 1, writesState: 1, writesRepo: 1}, 'header'],
  'scripts/fusion/test-domain-reminder.mjs': ['验收', '提醒 CRUD 与确认口令，回复本地捕获', {auth: 1, model: 1, task: 1, writesState: 1, writesRepo: 1}, 'header'],
  'scripts/fusion/test-fulltext-research.mjs': ['验收', '论文全文研究任务', {auth: 1, model: 1, task: 1, writesState: 1, writesRepo: 1}, 'code'],
  'scripts/fusion/test-live-inbound.mjs': ['验收', '合成入站 → 真实模型 → 本人 QQ 外发', {auth: 1, model: 1, qq: 1, writesState: 1, writesRepo: 1}, 'header'],
  'scripts/fusion/test-live-media.mjs': ['验收', '合成图片入站与真实外发', {auth: 1, model: 1, qq: 1, writesState: 1, writesRepo: 1}, 'header'],
  'scripts/fusion/test-memory.mjs': ['验收', '真实模型记忆 CRUD（合成事实）', {auth: 1, model: 1, writesState: 1, writesRepo: 1}, 'header'],
  'scripts/fusion/test-native-concurrency.mjs': ['验收', '两个原生会话并发；不发 QQ', {auth: 1, model: 1, writesState: 1, writesRepo: 1}, 'header'],
  'scripts/fusion/test-native-cron.mjs': ['验收', '原生 Cron CRUD 与频道投递', {auth: 1, qq: 1, task: 1, restart: 1, writesRepo: 1}, 'header'],
  'scripts/fusion/test-profile-confirmation.mjs': ['验收', 'Profile 变更确认后恢复原值', {auth: 1, model: 1, writesState: 1, writesRepo: 1}, 'header'],
  'scripts/fusion/test-project-maintenance.mjs': ['验收', '真实 QQ → 项目 worker → 隔离检查 → 本地提交', {auth: 1, model: 1, qq: 1, task: 1, writesState: 1, writesRepo: 1}, 'header'],
  'scripts/fusion/test-project-scoped-commit.mjs': ['验收', '提交范围只含指定文件', {auth: 1, model: 1, qq: 1, task: 1, writesState: 1, writesRepo: 1}, 'header'],
  'scripts/fusion/test-qq-interaction.mjs': ['验收', '仅本人 QQ 的分段与表情外发', {auth: 1, qq: 1, writesState: 1, writesRepo: 1}, 'header'],
  'scripts/fusion/test-recurring-weather.mjs': ['验收', '周期天气 automations', {auth: 1, model: 1, qq: 1, task: 1, writesState: 1, writesRepo: 1}, 'code'],
  'scripts/fusion/test-reminder-delivery.mjs': ['验收', '自然语言 → automations → 到点外发', {auth: 1, model: 1, qq: 1, task: 1, writesState: 1, writesRepo: 1}, 'header'],
  'scripts/fusion/test-reminder-tool.mjs': ['验收', '提醒工具 CRUD（须先取消未来任务）', {auth: 1, model: 1, task: 1, writesState: 1, writesRepo: 1}, 'header'],
  'scripts/fusion/test-research-cancel.mjs': ['验收', '研究任务查询与取消', {auth: 1, model: 1, task: 1, writesState: 1, writesRepo: 1}, 'header'],
  'scripts/fusion/test-research.mjs': ['验收', '公开论文检索，无 QQ 输出、无记忆写入', {auth: 1, externalApi: 1, writesState: 1, writesRepo: 1}, 'header'],
  'scripts/fusion/test-service-recovery.mjs': ['验收', '服务故障注入与恢复；不发 QQ、不调模型', {auth: 1, restart: 1, writesState: 1, writesRepo: 1}, 'header'],
  'scripts/fusion/test-task-control.mjs': ['验收', '任务查询与取消', {auth: 1, model: 1, task: 1, writesState: 1, writesRepo: 1}, 'header'],

  // ---- 融合前遗留 harness：分类依据是脚本自己的 boundary 声明 ----
  'chatbot/tests/acceptance/run.mjs': ['遗留验收', '旧 harness 总入口：真实 Host 调度 + 合成 QQ 输入 + 确定性认知 + 假调度', {auth: 1, testDir: 1, writesRepo: 1}, 'boundary'],
  'chatbot/tests/acceptance/run-model.mjs': ['遗留验收', '真实主模型 + 有界工具循环；合成 QQ 身份，无 QQ 传输', {auth: 1, model: 1, testDir: 1}, 'boundary'],
  'chatbot/tests/acceptance/run-real-cron.mjs': ['遗留验收', '隔离 Gateway 的真实 Cron 存储与确认钩子；确定性认知，无模型、无 QQ 网络', {auth: 1, task: 1, testDir: 1}, 'boundary'],
  'chatbot/tests/acceptance/run-reminder-expiry.mjs': ['遗留验收', '真实主模型有界循环 + 提醒提案工具 + 隔离库；非生产 Agent/QQ 验收', {auth: 1, model: 1, task: 1, testDir: 1}, 'boundary'],
  'chatbot/tests/acceptance/run-retrieval-t2.mjs': ['遗留验收', '真实 Tavily API（生产凭据）；无模型、无 Host、无 QQ 投递、不写生产库', {auth: 1, externalApi: 1}, 'boundary'],
  'chatbot/tests/acceptance/run-retrieval-t3.mjs': ['遗留验收', '真实模型 + 真实 Tavily + 真实 HTTP；无 Host、无 QQ 投递、不改生产配置', {auth: 1, model: 1, externalApi: 1}, 'boundary'],
  'chatbot/tests/acceptance/run-retrieval-host.mjs': ['遗留验收', '全新 Host 状态 + 原生工具 + 真实 API；无 QQ 发送、不碰生产库', {auth: 1, model: 1, externalApi: 1, testDir: 1}, 'boundary'],
  'chatbot/tests/acceptance/run-fallback-failover.mjs': ['遗留验收', '主模型指向必然失败地址、fallback 用真实 deepseek', {auth: 1, model: 1, testDir: 1}, 'header'],
  'chatbot/tests/acceptance/run-profile-geo.mjs': ['遗留验收', '真实 GeoAPI + 隔离 Profile 库；无生产确认、无 QQ 投递', {auth: 1, externalApi: 1, testDir: 1}, 'header'],
  'chatbot/tests/acceptance/probe-profile-geo.py': ['遗留验收', 'GeoAPI provider 探测', {auth: 1, externalApi: 1, writesRepo: 1}, 'code'],
  'chatbot/tests/acceptance/run-retrieval-smoke.mjs': ['遗留验收', '检索注册冒烟：不启动 Gateway/频道，凭据为合成值', {auth: 1, externalApi: 1, testDir: 1}, 'header'],
  'chatbot/tests/acceptance/verify-restart.mjs': ['遗留验收', '在新进程里重开测试目录并验证幂等；不重启任何服务', {readonly: 1, testDir: 1}, 'header'],
};

function discover() {
  const out = [];
  const skipDir = new Set(['node_modules', 'dist']);
  const walk = (dir, filter) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (skipDir.has(entry.name)) continue;
        walk(abs, filter);
      } else if (filter(entry.name)) out.push(path.relative(ROOT, abs));
    }
  };
  // Whole scripts/fusion tree (including lib/, launchers/, test/, fixtures/).
  walk(path.join(ROOT, 'scripts/fusion'), (n) => /\.(mjs|sh|py)$/.test(n));
  // Legacy acceptance harness.
  walk(path.join(ROOT, 'chatbot/tests/acceptance'), (n) => /\.(mjs|py)$/.test(n));
  // Plugin and package tests, both the JS test dirs and the TypeScript sources.
  for (const parent of ['chatbot/plugins', 'chatbot/packages']) {
    for (const dir of fs.readdirSync(path.join(ROOT, parent))) {
      const testDir = path.join(ROOT, parent, dir, 'test');
      if (fs.existsSync(testDir)) {
        for (const f of fs.readdirSync(testDir, {withFileTypes: true})) {
          if (f.isFile() && /\.test\.js$/.test(f.name)) out.push(`${parent}/${dir}/test/${f.name}`);
        }
      }
      const srcDir = path.join(ROOT, parent, dir, 'src');
      if (fs.existsSync(srcDir)) {
        for (const f of fs.readdirSync(srcDir, {withFileTypes: true})) {
          if (f.isFile() && /\.test\.ts$/.test(f.name)) out.push(`${parent}/${dir}/src/${f.name}`);
        }
      }
    }
  }
  return [...new Set(out)].sort();
}

/** First contiguous comment block at the top of a file (// or # style). */
function firstHeader(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!out.length && !t) continue;
    if (!t) break;
    const m = /^(?:\/\/|#)\s?(.*)$/.exec(t);
    if (!m || m[1].startsWith('!')) break;
    out.push(m[1].trim());
  }
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

/** Machine-readable declaration some acceptance scripts carry. */
function boundaryOf(text) {
  const m = /boundary:\s*["'`]([^"'`]{0,400})/.exec(text);
  return m ? m[1].replace(/\s+/g, ' ').trim() : '';
}

function evidence(text) {
  return [...new Set([...text.matchAll(/docs\/verification\/[A-Za-z0-9_\-./\u4e00-\u9fff]*/g)].map((m) => m[0]))].sort();
}

/**
 * Fail when a row contradicts the script's own boundary declaration. This is the check that would
 * have caught the R02 mislabels (run.mjs claimed model+QQ+restart while declaring none of them).
 */
function contradictions(rel, flags, boundary) {
  if (!boundary) return [];
  const bad = [];
  const says = (re) => re.test(boundary);
  const noModel = says(/no model|no model provider|model provider\.|deterministic cognition/i) && !says(/real (configured )?model|real-model/i);
  const noQQ = says(/no QQ network|no QQ send|no QQ delivery|no QQ output|not.*QQ transport/i);
  if (noModel && flags.model) bad.push('声明无模型，但表中标了真实模型');
  if (noQQ && flags.qq) bad.push('声明无 QQ 网络/发送，但表中标了真实 QQ 外发');
  return bad;
}

const files = discover();
const missing = files.filter((f) => !TABLE[f]);
const stale = Object.keys(TABLE).filter((f) => !files.includes(f));
if (missing.length || stale.length) {
  console.error('index is out of date:');
  for (const f of missing) console.error('  unclassified file:', f);
  for (const f of stale) console.error('  row without file:', f);
  process.exit(1);
}

const rows = files.map((rel) => {
  const [group, purpose, flags, basis] = TABLE[rel];
  const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const boundary = boundaryOf(text);
  const bad = contradictions(rel, flags, boundary);
  return {path: rel, group, ...flags, purpose, basis, boundary, header: firstHeader(text), evidence: evidence(text), lines: text.split('\n').length, contradictions: bad};
});

const problems = rows.filter((r) => r.contradictions.length);
if (problems.length) {
  console.error('classification contradicts the script\'s own boundary declaration:');
  for (const r of problems) console.error(`  ${r.path}: ${r.contradictions.join('；')}\n      boundary: ${r.boundary}`);
  process.exit(1);
}

const EFFECT_LABEL = {
  model: '真实模型',
  externalApi: '真实外部API',
  qq: '真实QQ外发',
  task: '建/改任务或提醒',
  restart: '重启或停服务',
  writesState: '写运行状态',
  writesRepo: '写仓库内文件',
  testDir: '写临时测试目录',
  readonly: '只读',
};
const effectsOf = (r) => Object.entries(EFFECT_LABEL).filter(([k]) => r[k]).map(([, v]) => v).join('、') || '无（离线）';

if (process.argv.includes('--json')) console.log(JSON.stringify(rows, null, 2));
else if (process.argv.includes('--markdown')) {
  console.log('| 脚本 | 分组 | 用途 | 副作用 | 需要授权 | 分类依据 | 证据位置 |');
  console.log('| --- | --- | --- | --- | --- | --- | --- |');
  const groups = [...new Set(rows.map((r) => r.group))];
  for (const g of groups) {
    for (const r of rows.filter((x) => x.group === g)) {
      console.log(`| \`${r.path}\` | ${r.group} | ${r.purpose} | ${effectsOf(r)} | ${r.auth ? '是' : '否'} | ${r.basis} | ${r.evidence.length ? r.evidence.map((e) => `\`${e}\``).join('<br>') : '—'} |`);
    }
  }
} else {
  const byGroup = {};
  for (const r of rows) (byGroup[r.group] ??= []).push(r);
  for (const [g, list] of Object.entries(byGroup)) {
    console.log(`\n## ${g} (${list.length})`);
    for (const r of list) console.log(`- ${r.path}\n    用途: ${r.purpose}\n    副作用: ${effectsOf(r)}${r.auth ? '（需授权）' : ''}\n    依据: ${r.basis}${r.boundary ? ` — boundary: ${r.boundary.slice(0, 120)}` : ''}`);
  }
  const byBasis = {};
  for (const r of rows) byBasis[r.basis] = (byBasis[r.basis] ?? 0) + 1;
  console.log(`\ntotal ${rows.length}: 需授权 ${rows.filter((r) => r.auth).length}，可离线/只读 ${rows.filter((r) => !r.auth).length}`);
  console.log(`依据分布: ${Object.entries(byBasis).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  console.log(`boundary 声明交叉校验: ${rows.filter((r) => r.boundary).length} 个脚本有声明，全部与分类一致`);
}
