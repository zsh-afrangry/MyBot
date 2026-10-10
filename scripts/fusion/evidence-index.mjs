// Build the verified script/evidence index required by 清单 C05.
//
// Design: the classification below is an explicit, reviewable table; the generator
//   - verifies every discovered script has a row and every row matches a real file (fail loudly otherwise),
//   - extracts the one-line purpose from each script's own header comment,
//   - extracts concrete docs/verification evidence paths found in the source.
// No runtime state is touched; the script only reads the repository.
//
// Usage:
//   node scripts/fusion/evidence-index.mjs            # human summary
//   node scripts/fusion/evidence-index.mjs --json     # full records
//   node scripts/fusion/evidence-index.mjs --markdown # table for docs/verification/SCRIPTS.md
import fs from 'node:fs';
import path from 'node:path';
import {REPO_ROOT} from './lib/legacy-source.mjs';

const ROOT = REPO_ROOT;

// model / qq / task / restart / state / readonly describe side effects; 'auth' means the operator must
// authorize a run (real outbound, service stop, ledger writes, legacy restore).
// purpose is a short Chinese label; the English header comment is quoted separately when present.
const TABLE = {
  // ---- 离线：进程内测试，可随时运行 ----
  'chatbot/plugins/kurumi-qq/test/channel.test.js': ['离线', {readonly: 1}, 'QQ 频道分段、配额、账本与幂等'],
  'chatbot/plugins/kurumi-qq/test/presentation.test.js': ['离线', {readonly: 1}, 'QQ 呈现与分段节奏'],
  'chatbot/plugins/kurumi-qq/test/stickers.test.js': ['离线', {readonly: 1}, '表情目录与发送边界'],
  'chatbot/plugins/kurumi-memory/test/memory.test.js': ['离线', {readonly: 1}, '长期记忆读写、版本与损坏拒绝'],
  'chatbot/plugins/kurumi-tasks/test/task.test.js': ['离线', {readonly: 1}, '后台任务工具的所有权与绑定'],
  'chatbot/plugins/kurumi-tasks/test/git.test.js': ['离线', {readonly: 1}, '副本内受限 Git 提交范围'],
  'chatbot/plugins/kurumi-tasks/test/sandbox.test.js': ['离线', {readonly: 1}, 'Bubblewrap 隔离边界与进程树终止'],
  'chatbot/plugins/kurumi-research/test/papers.test.js': ['离线', {readonly: 1}, '论文来源校验与拒绝规则'],
  'scripts/fusion/test/recovery.test.mjs': ['离线', {readonly: 1}, '备份/恢复工具单元与集成回归'],

  // ---- 只读运维工具：不写状态、不外发 ----
  'scripts/fusion/health.mjs': ['只读运维', {readonly: 1}, '服务、QQ、频道、Cron、数据库健康'],
  'scripts/fusion/probe-final.mjs': ['只读运维', {readonly: 1}, 'health.mjs 的兼容入口'],
  'scripts/fusion/stack-summary.mjs': ['只读运维', {readonly: 1}, '启停输出压缩显示'],
  'scripts/fusion/verify-dependencies.mjs': ['只读运维', {readonly: 1}, '依赖自持、无归档树逃逸、锁文件一致'],
  'scripts/fusion/sync-config.mjs': ['只读运维', {readonly: 1, writesState: 1}, '默认只报告配置漂移；--apply 才写 openclaw.json'],
  'scripts/fusion/sync-persona.mjs': ['只读运维', {readonly: 1, writesState: 1}, '默认只报告人格漂移；--apply 才写 workspace 四份文件'],
  'scripts/fusion/evidence-index.mjs': ['只读运维', {readonly: 1}, '生成本脚本与证据索引'],
  'scripts/fusion/evidence-coverage.mjs': ['只读运维', {readonly: 1}, '校验证据目录分类覆盖，未分类即非零退出'],
  'scripts/fusion/inspect-receipts.mjs': ['只读运维', {readonly: 1}, '查看验收回执'],
  'scripts/fusion/rpc.mjs': ['只读运维', {readonly: 1}, 'Gateway RPC 客户端库（被其他脚本导入）'],
  'scripts/fusion/lib/fresh-id.mjs': ['库', {readonly: 1}, '生成不重复的 message id'],
  'scripts/fusion/lib/plugins.mjs': ['库', {readonly: 1}, '第三方插件声明（纯数据）'],
  'scripts/fusion/lib/recovery-isolation.mjs': ['库', {readonly: 1}, '隔离恢复的路径与凭据改写'],
  'scripts/fusion/lib/working-tree-backup.mjs': ['库', {readonly: 1}, '已跟踪修改的 Git 补丁归档'],
  'scripts/fusion/lib/backup-service.mjs': ['库', {restart: 1}, '备份期间停写并恢复服务'],
  'scripts/fusion/lib/legacy-source.mjs': ['库', {readonly: 1}, '解析旧 OpenClaw 源树路径（仅迁移脚本用）'],

  // ---- 写运行状态的运维工具：需要操作者明确执行 ----
  'scripts/fusion/backup-state.mjs': ['运维写状态', {auth: 1, writesState: 1, restart: 1}, '制作备份；--quiesce 会短暂停写并恢复服务'],
  'scripts/fusion/restore-verify.mjs': ['运维写状态', {auth: 1, writesState: 1, restart: 1}, '隔离恢复演练（只写新建 /tmp 目标）'],
  'scripts/fusion/restore-legacy.sh': ['运维写状态', {auth: 1, writesState: 1, restart: 1}, '按 A/B 方案把旧系统复制回原路径（不自动启动）'],
  'scripts/fusion/recovery-probe.mjs': ['运维写状态', {auth: 1, writesState: 1}, '仅供 restore-verify 在沙箱内启动 Gateway'],
  'scripts/fusion/install-service.mjs': ['运维写状态', {auth: 1, writesState: 1, restart: 1}, '首次切换 systemd 单元到融合服务'],
  'scripts/fusion/install-plugins.mjs': ['运维写状态', {auth: 1, writesState: 1}, '按锁文件安装受控第三方插件'],
  'scripts/fusion/link-dependencies.mjs': ['运维写状态', {auth: 1, writesState: 1}, '固定并链接本地 SDK 只读依赖'],
  'scripts/fusion/run-gateway.mjs': ['运维写状态', {auth: 1, writesState: 1, restart: 1, model: 1}, '前台生产入口；日常只由 systemd 启动'],
  'scripts/fusion/stop-gateway.mjs': ['运维写状态', {auth: 1, writesState: 1, restart: 1}, '按环境证明停止隔离 Gateway'],
  'scripts/fusion/close-acceptance.mjs': ['运维写状态', {auth: 1, writesState: 1, task: 1}, '验收结束后关闭 testIngress，不重置发送账本'],
  'scripts/fusion/copy-domain-state.py': ['运维写状态', {auth: 1, writesState: 1}, '迁移领域状态库（迁移工具，不是日常命令）'],

  // ---- 一次性迁移工具：只在明确迁移/重建时使用 ----
  'scripts/fusion/prepare.mjs': ['迁移工具', {auth: 1, writesState: 1}, '首次引导隔离运行目录，拒绝覆盖已写内容'],
  'scripts/fusion/configure-deepseek-persona.mjs': ['迁移工具', {auth: 1, writesState: 1, model: 1}, '一次性切到 DeepSeek+小鲸鱼；日常禁用作人格入口'],
  'scripts/fusion/configure-domains.mjs': ['迁移工具', {auth: 1, writesState: 1}, '启用主人绑定领域插件'],
  'scripts/fusion/configure-fulltext-research.mjs': ['迁移工具', {auth: 1, writesState: 1}, '研究会话、笔记工作区与来源缓存'],
  'scripts/fusion/configure-interaction.mjs': ['迁移工具', {auth: 1, writesState: 1}, '复制表情目录并设定迁移/每日发送预算'],
  'scripts/fusion/configure-persona-memory.mjs': ['迁移工具', {auth: 1, writesState: 1}, '只导入稳定的主人字段进私有记忆'],
  'scripts/fusion/configure-production.mjs': ['迁移工具', {auth: 1, writesState: 1}, '关闭仅验收能力，保留历史；需先审阅活动任务'],
  'scripts/fusion/configure-projects.mjs': ['迁移工具', {auth: 1, writesState: 1}, '注册独立副本、agent 与固定检查'],
  'scripts/fusion/configure-research.mjs': ['迁移工具', {auth: 1, writesState: 1}, '配置检索 provider 与抓取路径'],
  'scripts/fusion/configure-worker.mjs': ['迁移工具', {auth: 1, writesState: 1}, '显式配置隔离代码 worker'],

  // ---- 整套启停：会停 dsh-web，需要 sudo 与时机 ----
  'scripts/fusion/launchers/Start-DSH.sh': ['启停脚本', {auth: 1, restart: 1}, '启动 DSH Web + 融合栈，停旧消费者'],
  'scripts/fusion/launchers/Stop-DSH.sh': ['启停脚本', {auth: 1, restart: 1}, '按消费者优先顺序停止整套栈'],

  // ---- 验收脚本：可能真实外发/建任务/重启，必须授权并单独记录 ----
  'scripts/fusion/test-background-code.mjs': ['验收', {auth: 1, model: 1, qq: 1, task: 1, writesState: 1}, '后台代码任务登记检查与终态'],
  'scripts/fusion/test-domain-read.mjs': ['验收', {auth: 1, model: 1, writesState: 1}, '领域只读自然语言验收，不发 QQ'],
  'scripts/fusion/test-domain-due.mjs': ['验收', {auth: 1, model: 1, qq: 1, task: 1, writesState: 1, restart: 1}, '提醒到点投递（跨重启）'],
  'scripts/fusion/test-domain-planning.mjs': ['验收', {auth: 1, model: 1, writesState: 1}, '行程提案与确认写入'],
  'scripts/fusion/test-domain-reminder.mjs': ['验收', {auth: 1, model: 1, task: 1, writesState: 1}, '提醒 CRUD 与确认口令'],
  'scripts/fusion/test-fulltext-research.mjs': ['验收', {auth: 1, model: 1, task: 1, writesState: 1}, '论文全文研究任务'],
  'scripts/fusion/test-live-inbound.mjs': ['验收', {auth: 1, model: 1, qq: 1, writesState: 1}, '合成入站 → 真实模型 → 本人 QQ 外发'],
  'scripts/fusion/test-live-media.mjs': ['验收', {auth: 1, model: 1, qq: 1, writesState: 1}, '合成图片入站与真实外发'],
  'scripts/fusion/test-memory.mjs': ['验收', {auth: 1, model: 1, writesState: 1}, '真实模型记忆 CRUD（合成事实）'],
  'scripts/fusion/test-native-concurrency.mjs': ['验收', {auth: 1, model: 1, writesState: 1}, '两个原生会话并发，不发 QQ'],
  'scripts/fusion/test-native-cron.mjs': ['验收', {auth: 1, qq: 1, task: 1, restart: 1}, '原生 Cron CRUD 与频道投递'],
  'scripts/fusion/test-profile-confirmation.mjs': ['验收', {auth: 1, model: 1, writesState: 1}, 'Profile 变更确认后恢复原值'],
  'scripts/fusion/test-project-maintenance.mjs': ['验收', {auth: 1, model: 1, qq: 1, task: 1, writesState: 1}, '真实 QQ → 项目 worker → 隔离检查 → 本地提交'],
  'scripts/fusion/test-project-scoped-commit.mjs': ['验收', {auth: 1, model: 1, qq: 1, task: 1, writesState: 1}, '提交范围只含指定文件'],
  'scripts/fusion/test-qq-interaction.mjs': ['验收', {auth: 1, qq: 1, writesState: 1}, '仅本人 QQ 的分段与表情外发'],
  'scripts/fusion/test-recurring-weather.mjs': ['验收', {auth: 1, model: 1, qq: 1, task: 1, writesState: 1}, '周期天气 automations'],
  'scripts/fusion/test-reminder-delivery.mjs': ['验收', {auth: 1, model: 1, qq: 1, task: 1, writesState: 1}, '自然语言 → automations → 到点外发'],
  'scripts/fusion/test-reminder-tool.mjs': ['验收', {auth: 1, model: 1, qq: 1, task: 1, writesState: 1}, '提醒工具 CRUD（须先取消未来任务）'],
  'scripts/fusion/test-research-cancel.mjs': ['验收', {auth: 1, model: 1, task: 1, writesState: 1}, '研究任务查询与取消'],
  'scripts/fusion/test-research.mjs': ['验收', {auth: 1, model: 1, writesState: 1}, '公开论文检索，无 QQ 输出'],
  'scripts/fusion/test-service-recovery.mjs': ['验收', {auth: 1, restart: 1, writesState: 1}, '服务故障注入与恢复；不发 QQ、不调模型'],
  'scripts/fusion/test-task-control.mjs': ['验收', {auth: 1, model: 1, task: 1, writesState: 1}, '任务查询与取消'],

  // ---- 融合前遗留验收 harness：适用范围与 C05 的旧频道验收提醒 ----
  'chatbot/tests/acceptance/run.mjs': ['遗留验收', {auth: 1, model: 1, qq: 1, task: 1, restart: 1}, '旧 harness 总入口'],
  'chatbot/tests/acceptance/run-model.mjs': ['遗留验收', {auth: 1, model: 1}, '旧 harness 单模型调用'],
  'chatbot/tests/acceptance/model-driver.mjs': ['遗留验收', {auth: 1, model: 1}, '旧 harness 模型驱动（读取遗留 AGENTS）'],
  'chatbot/tests/acceptance/host-driver.mjs': ['遗留验收', {auth: 1, model: 1, writesState: 1}, '旧 harness Host 驱动'],
  'chatbot/tests/acceptance/domain-fixture.mjs': ['遗留验收', {readonly: 1}, '旧验收领域夹具与工具定义'],
  'chatbot/tests/acceptance/retrieval-config.mjs': ['遗留验收', {readonly: 1}, '旧验收检索 provider 配置读取'],
  'chatbot/tests/acceptance/call-analysis.mjs': ['遗留验收', {readonly: 1}, '旧验收工具调用分析'],
  'chatbot/tests/acceptance/call-analysis.test.mjs': ['遗留验收', {readonly: 1}, '调用分析离线断言'],
  'chatbot/tests/acceptance/run-retrieval-smoke.mjs': ['遗留验收', {auth: 1, model: 1}, '旧检索冒烟'],
  'chatbot/tests/acceptance/run-retrieval-t2.mjs': ['遗留验收', {auth: 1, model: 1, qq: 1}, '旧检索 T2'],
  'chatbot/tests/acceptance/run-retrieval-t3.mjs': ['遗留验收', {auth: 1, model: 1, qq: 1}, '旧检索 T3'],
  'chatbot/tests/acceptance/run-retrieval-host.mjs': ['遗留验收', {auth: 1, model: 1, qq: 1}, '旧检索 Host 路径'],
  'chatbot/tests/acceptance/run-fallback-failover.mjs': ['遗留验收', {auth: 1, model: 1}, '旧模型 fallback 切换'],
  'chatbot/tests/acceptance/run-profile-geo.mjs': ['遗留验收', {auth: 1, model: 1, writesState: 1}, 'Profile 地理编码（隔离库，不发 QQ）'],
  'chatbot/tests/acceptance/probe-profile-geo.py': ['遗留验收', {auth: 1, model: 1, writesState: 1}, 'GeoAPI provider 探测'],
  'chatbot/tests/acceptance/run-real-cron.mjs': ['遗留验收', {auth: 1, task: 1}, '旧原生 Cron 验收'],
  'chatbot/tests/acceptance/run-reminder-expiry.mjs': ['遗留验收', {auth: 1, model: 1, task: 1}, '提醒过期语义'],
  'chatbot/tests/acceptance/verify-restart.mjs': ['遗留验收', {auth: 1, restart: 1}, '重启后状态核对'],
};

function discover() {
  const out = [];
  const walk = (dir, filter) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(ROOT, abs);
      if (entry.isDirectory()) {
        if (['node_modules', 'fixtures', 'dist'].includes(entry.name)) continue;
        walk(abs, filter);
      } else if (filter(rel)) out.push(rel);
    }
  };
  walk(path.join(ROOT, 'scripts/fusion'), (rel) => /\.(mjs|sh|py)$/.test(rel));
  walk(path.join(ROOT, 'chatbot/tests/acceptance'), (rel) => /\.(mjs|py|sh)$/.test(rel));
  for (const dir of fs.readdirSync(path.join(ROOT, 'chatbot/plugins'))) {
    const testDir = path.join(ROOT, 'chatbot/plugins', dir, 'test');
    if (!fs.existsSync(testDir)) continue;
    for (const f of fs.readdirSync(testDir, {withFileTypes: true}).filter((e) => e.isFile())) {
      out.push(`chatbot/plugins/${dir}/test/${f.name}`);
    }
  }
  return out.sort();
}

function firstHeader(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!out.length && !t) continue;
    if (!t) break;
    const m = /^(?:\/\/|#)\s?(.*)$/.exec(t);
    if (!m || /^!/.test(m[1])) break;
    out.push(m[1].trim());
  }
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

function evidence(text) {
  return [...new Set([...text.matchAll(/docs\/verification\/[A-Za-z0-9_\-./\u4e00-\u9fff]*/g)].map((m) => m[0]))].sort();
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
  const [group, flags, purpose] = TABLE[rel];
  const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  return {path: rel, group, ...flags, purpose, header: firstHeader(text), evidence: evidence(text), lines: text.split('\n').length};
});

const EFFECT_LABEL = {model: '真实模型', qq: '真实QQ外发', task: '建/改任务或提醒', restart: '重启或停服务', writesState: '写运行状态', readonly: '只读'};
const effectsOf = (r) => Object.entries(EFFECT_LABEL).filter(([k]) => r[k]).map(([, v]) => v).join('、') || '无（离线）';

if (process.argv.includes('--json')) console.log(JSON.stringify(rows, null, 2));
else if (process.argv.includes('--markdown')) {
  const groups = [...new Set(rows.map((r) => r.group))];
  console.log('| 脚本 | 分组 | 用途 | 副作用 | 需要授权 | 证据位置 |');
  console.log('| --- | --- | --- | --- | --- | --- |');
  for (const g of groups) for (const r of rows.filter((x) => x.group === g)) {
    console.log(`| \`${r.path}\` | ${r.group} | ${r.purpose} | ${effectsOf(r)} | ${r.auth ? '是' : '否'} | ${r.evidence.length ? r.evidence.map((e) => `\`${e}\``).join('<br>') : '—'} |`);
  }
} else {
  const byGroup = {};
  for (const r of rows) (byGroup[r.group] ??= []).push(r);
  for (const [g, list] of Object.entries(byGroup)) {
    console.log(`\n## ${g} (${list.length})`);
    for (const r of list) console.log(`- ${r.path}\n    用途: ${r.purpose}\n    副作用: ${effectsOf(r)}${r.auth ? '（需授权）' : ''}${r.evidence.length ? `\n    证据: ${r.evidence.join(', ')}` : ''}`);
  }
  console.log(`\ntotal ${rows.length}: 需授权 ${rows.filter((r) => r.auth).length}，可离线/只读 ${rows.filter((r) => !r.auth).length}`);
}