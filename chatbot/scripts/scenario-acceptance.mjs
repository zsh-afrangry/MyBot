// Isolated defaults use only loopback fixtures; production runs read-only service checks.
// --model on isolated confirmation calls the configured paid model with synthetic conversations.
import {execFileSync, spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {accessSync, closeSync, constants, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const repo = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/u, '');
const localDependencies = {
  Landlock: '/home/afrangry/.openclaw-fusion/tools/node-addon-system-linux-x64/bin/landlock-run',
  Git: '/usr/bin/git',
  Poppler: '/usr/bin/pdfinfo',
  Bubblewrap: '/usr/bin/bwrap',
};
const admin = (category, workload, requires = []) => ({
  target: 'isolated', file: 'access-control/acceptance-member-admin-host.mjs',
  args: ['--category', category], workload, requires, timeoutMs: 180000,
});
const scenarios = {
  confirmation: {target: 'isolated', file: 'backend-boundaries/acceptance-natural-confirmation-host.mjs',
    workload: '确认、提醒写入、拒收和到点回执（--model 仅测对话与确认）', timeoutMs: 420000, modelTimeoutMs: 360000},
  coding: {target: 'isolated', file: 'coding/acceptance-host.mjs', workload: '编码启动、续接、失败回传',
    requires: ['Landlock', 'Git'], timeoutMs: 120000},
  'coding-recovery': {target: 'isolated', file: 'acceptance/test-evidence.mjs',
    args: ['chatbot/tests/coding/acp.test.mjs', 'chatbot/tests/coding/reconciliation.test.mjs', 'chatbot/tests/coding/flow.test.mjs', 'chatbot/tests/coding/archive.test.mjs'],
    workload: '编码服务取消、等待超时、重启核对与档案聚合', requires: ['Landlock', 'Git'], timeoutMs: 120000},
  'coding-extensions': {target: 'isolated', file: 'coding/acceptance-extensions-host.mjs',
    workload: '外部真实 Git 仓库、自维护禁区闸门与可扩展 CLI 适配器', requires: ['Landlock', 'Git'], timeoutMs: 120000},
  'access-member': admin('member', '成员确认新增、隔离会话和撤权'),
  'access-mail': admin('mail_recipient', '收件人同步及旧草稿拒绝'),
  'access-mail-sender': admin('mail_sender', '发件人白名单登记、同步与撤权'),
  'knowledge-bills-access': admin('owner_tool', 'KnowledgeMap 查账与主人工具白名单同步、撤权', ['KnowledgeMap FastAPI/SQLite test server']),
  'bills-feedback': {target:'isolated',file:'acceptance/test-evidence.mjs',
    args:['chatbot/tests/knowledgemap/bills.test.mjs'],workload:'账单提交、丢失响应后只读回执与删除后回查',
    requires:['KnowledgeMap FastAPI/SQLite test server'],timeoutMs:60000},
  'bills-import': {target:'isolated',file:'knowledgemap/acceptance-bill-import-host.mjs',
    workload:'表格预览、动态建标签、自然语言确认导入与幂等防重',
    requires:['Landlock','KnowledgeMap FastAPI/SQLite test server'],timeoutMs:120000},
  'monthly-bill-e2e': {target:'isolated',file:'knowledgemap/acceptance-monthly-bill-e2e-host.mjs',
    workload:'收件箱收信保存xlsx→预览→确认导入→重叠表防重→移动归档与全链路日志',
    requires:['Landlock','KnowledgeMap FastAPI/SQLite test server'],timeoutMs:150000},
  'mail-inbox': {target:'isolated',file:'mail/acceptance-inbox-host.mjs',
    workload:'回环TLS收件箱读取、陌生发件人单封确认放行、附件落地与无EXPUNGE整理',
    requires:['Landlock'],timeoutMs:120000},
  'reminder-list-feedback': {target:'isolated',file:'acceptance/test-evidence.mjs',
    args:['chatbot/tests/knowledgemap/http.test.mjs'],workload:'同一请求的逐项成功、冲突及反馈查询',
    requires:['KnowledgeMap FastAPI/SQLite test server'],timeoutMs:60000},
  'mail-feedback': {target:'isolated',file:'acceptance/test-evidence.mjs',
    args:['chatbot/plugins/kurumi-mail/test/tool.test.js'],
    workload:'邮件确认与逐封 SMTP 回执、响应丢失和重开后回查',timeoutMs:60000},
  'paper-feedback': {target:'isolated',file:'acceptance/test-evidence.mjs',
    args:['chatbot/tests/papers/feedback.test.mjs'],
    workload:'译稿逐份回查、QQ 回执丢失与冻结邮件附件',timeoutMs:60000},
  'access-exec': admin('exec_root', '普通目录写入范围同步与撤权', ['Landlock']),
  'access-project': admin('coding_project', '项目准入、检查预设与历史任务', ['Landlock', 'Git']),
  'host-admin': {target: 'isolated', file: 'host-admin/acceptance-host.mjs',
    workload: '受控系统操作确认、拒绝、防重放、exec隔离与状态核验', requires: ['Landlock'], timeoutMs: 120000},
  'host-files': {target: 'isolated', file: 'files/acceptance-host.mjs',
    workload: '分级文件工具、自动快照恢复、exec边界迁移与有界任务租约', requires: ['Landlock'], timeoutMs: 120000},
  'office-files': {target: 'isolated', file: 'files/acceptance-office-host.mjs',
    workload: '多格式办公文档读取与主人 QQ 非 PDF 文件落地工作区', requires: ['Landlock'], timeoutMs: 120000},
  'qq-feedback': {target:'isolated', file:'acceptance/acceptance-qq-feedback-host.mjs', workload:'QQ 私聊分段受理、引用回认和主人查询', timeoutMs:90000},
  'qq-evidence-gaps': {target:'isolated',file:'acceptance/test-evidence.mjs',
    args:['chatbot/tests/log-query/qq-evidence.test.mjs'],workload:'QQ 业务证据的缺失、故障、时间范围和相邻告警',timeoutMs:30000},
  'daily-feedback': {target:'isolated', file:'acceptance/acceptance-daily-feedback-host.mjs',
    workload:'空清单跳过、天气取数失败后 QQ 受理与计划时刻回查',
    requires:['KnowledgeMap FastAPI/SQLite test server'], timeoutMs:160000},
  'e7-image-feedback': {target: 'isolated', file: 'acceptance/acceptance-business-feedback-host.mjs',
    args: ['image'], workload: 'E7 零命中、真实渲染、QQ 图片受理和原请求回查', requires: ['Bubblewrap'], timeoutMs: 100000},
  'profile-planning-feedback': {target: 'isolated', file: 'acceptance/acceptance-business-feedback-host.mjs',
    args: ['profile-planning'], workload: '所在地与行程确认、按提案回查及历史所在地核对', timeoutMs: 100000},
  'shared-city': {target:'isolated', file:'acceptance/acceptance-shared-city-host.mjs',
    workload:'真实隔离网关与鉴权网站读取已确认所在地；网页选点独立',
    requires:['KnowledgeMap FastAPI test environment'], timeoutMs:90000},
  media: {target: 'isolated', file: 'acceptance/acceptance-media-host.mjs',
    workload: '引用、图片、PDF 和单次回传', requires: ['Poppler', 'Bubblewrap'], timeoutMs: 90000},
  'scope-proof': {target: 'isolated', file: 'acceptance/acceptance-scope-host.mjs', workload: '同进程作用域技术验证', timeoutMs: 90000},
  deployment: {target: 'production', workload: '在用进程、工具目录、健康和配置对齐'},
};
const usage = `node chatbot/scripts/scenario-acceptance.mjs --list
node chatbot/scripts/scenario-acceptance.mjs --target isolated [--scenario ID] [--model] [--out PATH]
node chatbot/scripts/scenario-acceptance.mjs --target production [--scenario deployment] [--out PATH]

--out 须位于仓库的 test-output/ 内，是尚不存在的报告文件。
--model 仅用于独立实例的 confirmation，调用已配置的真实模型。
--diagnostic-fault 用于复现独立场景的受控失败：confirmation 可用 gateway-start 或 reminder-lookup，bills-feedback 可用 bills-assertion。
生产目标目前只覆盖只读部署核验。`;

function options(args) {
  const result = {}, valueFlags = new Set(['target', 'scenario', 'out','diagnostic-fault']);
  for (let i = 0; i < args.length; i++) {
    const flag = args[i], key = flag.slice(2);
    if (!flag.startsWith('--') || Object.hasOwn(result, key)) throw Error('Unknown or duplicate option: ' + flag);
    if (['list', 'help', 'model'].includes(key)) result[key] = true;
    else if (valueFlags.has(key) && args[i + 1] && !args[i + 1].startsWith('--')) result[key] = args[++i];
    else throw Error('Unknown option or missing value: ' + flag);
  }
  if ((result.list || result.help) && Object.keys(result).length > 1) throw Error('Choose --list or --help by itself');
  if (result.help || result.list) return result;
  if (!['isolated', 'production'].includes(result.target)) throw Error('Select --target isolated or production');
  if (result.scenario && (!Object.hasOwn(scenarios, result.scenario) || scenarios[result.scenario].target !== result.target)) {
    throw Error('Unknown scenario for ' + result.target);
  }
  if (result.model && (result.target !== 'isolated' || result.scenario !== 'confirmation')) {
    throw Error('--model requires --target isolated --scenario confirmation');
  }
  const faultScenario = {'gateway-start':'confirmation','reminder-lookup':'confirmation','bills-assertion':'bills-feedback'};
  if (result['diagnostic-fault'] && (result.target!=='isolated' || result.model ||
    !Object.hasOwn(faultScenario,result['diagnostic-fault']) || result.scenario!==faultScenario[result['diagnostic-fault']])) {
    throw Error('Invalid isolated diagnostic failure sample');
  }
  return result;
}

function reserveOutput(requested) {
  const root = join(repo, 'test-output'), defaultDir = join(root, 'scenario-acceptance');
  const output = requested ? resolve(requested) : join(defaultDir, 'run-' + new Date().toISOString().replaceAll(':', '-') + '-' + process.pid + '.json');
  if (!output.startsWith(root + '/') || !output.endsWith('.json')) throw Error('--out must be a JSON file under test-output/');
  mkdirSync(root, {recursive: true, mode: 0o700});
  // Refuse symlinked output directories before creating any children.
  if (realpathSync(root) !== root) throw Error('test-output must be a real directory inside the workspace');
  let parent = root;
  for (const part of output.slice(root.length + 1).split('/').slice(0, -1)) {
    parent = join(parent, part);
    try {mkdirSync(parent, {mode: 0o700});}
    catch (error) {if (error.code !== 'EEXIST') throw error;}
    const entry = lstatSync(parent);
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw Error('Output directory must not be a symlink');
  }
  const fd = openSync(output, 'wx', 0o600);
  try {return {output, evidence: mkdtempSync(output.slice(0, -5) + '-evidence-'), fd};}
  catch (error) {closeSync(fd); throw error;}
}

function revision() {
  const git = (...args) => execFileSync('/usr/bin/git', ['-C', repo, ...args], {maxBuffer: 8 * 1024 * 1024});
  const hash = createHash('sha256');
  const diff = git('diff', '--no-ext-diff', '--no-textconv', '--binary', 'HEAD');
  const untracked = git('ls-files', '--others', '--exclude-standard', '-z').toString().split('\0').filter(Boolean);
  hash.update(diff);
  for (const file of untracked) {
    hash.update('\0' + file + '\0');
    const absolute = join(repo, file);
    const entry = lstatSync(absolute);
    if (entry.isFile()) hash.update(readFileSync(absolute));
    else hash.update(String(entry.mode));
  }
  return {commit: git('rev-parse', 'HEAD').toString().trim(), dirty: diff.length > 0 || untracked.length > 0, diffSha256: hash.digest('hex')};
}

async function runIsolated(id, model, directory, signal, diagnosticFault) {
  const evidence = join(directory, id + '.json');
  const scenario = scenarios[id];
  const timeoutMs = model ? scenario.modelTimeoutMs : scenario.timeoutMs;
  const info = {name: id, timeoutMs, requires: scenario.requires ?? []};
  const executable = name => {
    try {accessSync(localDependencies[name], constants.X_OK); return true;}
    catch {return false;}
  };
  const missing = info.requires.filter(name => Object.hasOwn(localDependencies, name) && !executable(name));
  if (missing.length) return {...info, status: 'blocked', reason: 'missing_dependencies', missing,
    failure:{phase:'environment',step:'dependencies',category:'blocked'}};
  const argv = [join(repo, 'chatbot/tests', scenario.file), '--out', evidence, ...(scenario.args ?? []), ...(model ? ['--model'] : []),
    ...(diagnosticFault ? ['--diagnostic-fault',diagnosticFault] : [])];
  let current, lastPassed, firstFailed, stoppedAt;
  const start = performance.now();
  const result = await new Promise(resolveResult => {
    if (signal.aborted) return resolveResult({reason: 'interrupted'});
    const child = spawn(process.execPath, argv, {cwd: repo, detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc']});
    child.on('message', message => {
      if (message?.type!=='scenario-progress' || typeof message.step!=='string' || message.step.length>240
        || !['environment','check','cleanup'].includes(message.phase)) return;
      const step = {phase:message.phase,step:message.step};
      if (message.state==='started') current=step;
      if (message.state==='failed') firstFailed??=step;
      if (message.state==='passed') {
        if (message.phase==='check') lastPassed=message.step;
        if (current?.step===message.step) current=undefined;
      }
    });
    let reason, forced;
    const stop = why => {
      if (reason) return;
      reason = why;
      stoppedAt = current;
      if (child.connected) child.disconnect();
      // The fixture closes its gateway/API first. Bound the wait for an
      // unresponsive runner too, without treating it as verified cleanup.
      forced = setTimeout(() => child.kill('SIGKILL'), 12000);
    };
    const interrupt = () => stop('interrupted');
    const deadline = setTimeout(() => stop('scenario_timeout'), timeoutMs);
    signal.addEventListener('abort', interrupt, {once: true});
    const finish = (code, exitSignal) => {
      clearTimeout(deadline);
      clearTimeout(forced);
      signal.removeEventListener('abort', interrupt);
      resolveResult({code, exitSignal, reason});
    };
    child.once('error', () => {
      if (!reason) {reason = 'scenario_could_not_start'; finish(null, null);}
    });
    child.once('exit', finish);
  });
  info.durationMs = Math.round(performance.now() - start);
  const failure = (reason, blocked = false, data) => {
    const stage = stoppedAt ?? firstFailed ?? current ?? (blocked ? {phase:'environment',step:'runner-start'} : {phase:'scenario'});
    const category = reason==='scenario_timeout' ? 'timeout' : reason==='interrupted' ? 'interrupted'
      : blocked ? 'blocked' : reason==='scenario_finished_without_evidence' ? 'missing_report'
        : stage.phase==='check' ? 'check_failed' : 'scenario_failed';
    const previous = lastPassed ?? (Array.isArray(data?.cases)
      ? data.cases.filter(row=>row?.passed===true||row?.status==='passed').at(-1)?.label : undefined);
    const observed = data?.failureDetails ?? (Array.isArray(data?.cases)
      ? data.cases.find(row=>row.status==='failed' && row.label===stage.step)?.diagnostic : undefined);
    const reference = data?.failureReference ?? (observed?.assertion
      ? {status:'available',kind:'assertion',...observed.assertion}
      : {status:'unavailable',reason:'reference_not_reported'});
    return {...stage,category,...(previous&&{lastPassed:previous}),
      ...(observed && {diagnostic:observed}),reference,
      remainingChecks:blocked&&stage.phase==='environment' ? 'not_started'
        : firstFailed?.phase==='check' && id==='confirmation' ? 'stopped' : 'unverified'};
  };
  try {
    const data = JSON.parse(readFileSync(evidence, 'utf8'));
    const status = result.reason ? 'failed' : result.code === 0 && data.passed === true ? 'passed' : data.blocked ? 'blocked' : 'failed';
    return {...info, status,
      ...(result.reason && {reason: result.reason}),
      ...(status!=='passed' && {failure:failure(result.reason,status==='blocked',data)}),
      cases: data.cases?.length ?? data.stages?.length ?? 0,
      ...(typeof data.configSha256 === 'string' && {configSha256: data.configSha256}),
      ...(typeof data.primaryModel === 'string' && {primaryModel: data.primaryModel}),
      cleanupVerified: data.fixtureCleaned ?? data.fixtureRemoved ?? null, evidence};
  } catch {
    const blocked = result.reason==='scenario_could_not_start', reason = result.reason ?? 'scenario_finished_without_evidence';
    return {...info, status:blocked?'blocked':'failed',reason,failure:failure(reason,blocked),exitCode: result.code,
      signal: result.exitSignal, cleanupVerified: null};
  }
}

try {
  const args = options(process.argv.length > 2 ? process.argv.slice(2) : ['--help']);
  if (args.help) console.log(usage);
  else if (args.list) for (const [id, scenario] of Object.entries(scenarios)) console.log(scenario.target + '\t' + id + '\t' + scenario.workload);
  else {
    const before = revision();
    let openclaw;
    try {openclaw = JSON.parse(readFileSync(join(repo, 'node_modules/openclaw/package.json'), 'utf8')).version;} catch {}
    const {output, evidence, fd} = reserveOutput(args.out);
    const report = {at: new Date().toISOString(), target: args.target, source: before, scenarios: [], openclaw,
      model: args.target === 'production' ? 'no model calls' : args.model ? 'configured-provider' : 'deterministic fixture'};
    try {
      if (args.target === 'production') {
        const {verifyProductionDeployment} = await import('../tests/acceptance/production-target.mjs');
        const data = await verifyProductionDeployment({repo});
        const file = join(evidence, 'deployment.json');
        writeFileSync(file, JSON.stringify(data, null, 2) + '\n', {mode: 0o600, flag: 'wx'});
        report.scenarios.push({name: 'deployment', status: data.passed ? 'passed' : data.blocked ? 'blocked' : 'failed',
          cases: data.checks.length, evidence: file});
        report.uncovered = data.uncovered;
      } else {
        const controller = new AbortController();
        const stop = () => controller.abort();
        process.on('SIGINT', stop);
        process.on('SIGTERM', stop);
        try {
          for (const id of args.scenario ? [args.scenario] : Object.keys(scenarios).filter(id => scenarios[id].target === 'isolated')) {
            if (controller.signal.aborted) break;
            report.scenarios.push(await runIsolated(id, args.model, evidence, controller.signal,args['diagnostic-fault']));
          }
          if (controller.signal.aborted) report.reason = 'interrupted';
        } finally {
          process.removeListener('SIGINT', stop);
          process.removeListener('SIGTERM', stop);
        }
        report.uncovered = ['real QQ delivery', 'production interaction', 'real DSH/Codex backend and production MySQL',
          ...(args.model ? ['native reminder due-time delivery in the real-model run'] : ['real-model behavior']),
          'unregistered domain scenarios'];
      }
      const after = revision();
      report.sourceStable = before.diffSha256 === after.diffSha256 && before.commit === after.commit;
      report.status = report.reason === 'interrupted' || !report.sourceStable || report.scenarios.some(row => row.status === 'failed') ? 'failed'
        : report.scenarios.some(row => row.status === 'blocked') ? 'blocked' : 'passed';
    } catch {
      report.status = 'blocked';
      report.reason = 'evidence_or_environment_unavailable';
    }
    report.finishedAt = new Date().toISOString();
    try {writeFileSync(fd, JSON.stringify(report, null, 2) + '\n');} finally {closeSync(fd);}
    console.log(JSON.stringify({target: report.target, status: report.status, report: output, scenarios: report.scenarios}));
    if (report.status !== 'passed') process.exitCode = 1;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
