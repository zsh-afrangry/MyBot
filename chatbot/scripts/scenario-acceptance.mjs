// Isolated defaults use only loopback fixtures; production runs read-only service checks.
// --model on isolated confirmation calls the configured paid model with synthetic conversations.
import {execFileSync, spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {closeSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const repo = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/u, '');
const scenarios = {
  confirmation: {target: 'isolated', file: 'backend-boundaries/acceptance-natural-confirmation-host.mjs',
    workload: '确认、提醒写入、拒收和到点回执（--model 仅测对话与确认）'},
  coding: {target: 'isolated', file: 'coding/acceptance-host.mjs', workload: '编码启动、续接、失败回传'},
  'knowledge-bills-access': {target: 'isolated', file: 'access-control/acceptance-member-admin-host.mjs',
    argv: ['--category', 'owner_tool'], workload: 'KnowledgeMap 查账与主人工具白名单同步、撤权'},
  'scope-proof': {target: 'isolated', file: 'acceptance/acceptance-scope-host.mjs', workload: '同进程作用域技术验证'},
  deployment: {target: 'production', workload: '在用进程、工具目录、健康和配置对齐'},
};
const usage = `node chatbot/scripts/scenario-acceptance.mjs --list
node chatbot/scripts/scenario-acceptance.mjs --target isolated [--scenario ID] [--model] [--out PATH]
node chatbot/scripts/scenario-acceptance.mjs --target production [--scenario deployment] [--out PATH]

--out 须位于仓库的 test-output/ 内，是尚不存在的报告文件。
--model 仅用于独立实例的 confirmation，调用已配置的真实模型。
生产目标目前只覆盖只读部署核验。`;

function options(args) {
  const result = {}, valueFlags = new Set(['target', 'scenario', 'out']);
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

async function runIsolated(id, model, directory) {
  const evidence = join(directory, id + '.json');
  const scenario = scenarios[id];
  const argv = [join(repo, 'chatbot/tests', scenario.file), '--out', evidence, ...(scenario.argv ?? []), ...(model ? ['--model'] : [])];
  // Each child owns the timeout and cleanup for its temporary gateway and peer.
  const result = await new Promise(resolveResult => {
    const child = spawn(process.execPath, argv, {cwd: repo, stdio: 'ignore'});
    child.once('error', () => resolveResult(null));
    child.once('close', (code, signal) => resolveResult({code, signal}));
  });
  if (!result) return {name: id, status: 'blocked', reason: 'scenario_could_not_start'};
  try {
    const data = JSON.parse(readFileSync(evidence, 'utf8'));
    return {name: id, status: result.code === 0 && data.passed === true ? 'passed' : data.blocked ? 'blocked' : 'failed',
      cases: data.cases?.length ?? data.stages?.length ?? 0,
      ...(typeof data.configSha256 === 'string' && {configSha256: data.configSha256}),
      ...(typeof data.primaryModel === 'string' && {primaryModel: data.primaryModel}), evidence};
  } catch {
    return {name: id, status: result.signal ? 'failed' : 'blocked', reason: 'scenario_finished_without_evidence',
      exitCode: result.code, signal: result.signal};
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
        for (const id of args.scenario ? [args.scenario] : Object.keys(scenarios).filter(id => scenarios[id].target === 'isolated')) {
          report.scenarios.push(await runIsolated(id, args.model, evidence));
        }
        report.uncovered = ['real QQ delivery', 'production interaction',
          ...(args.model ? ['native reminder due-time delivery in the real-model run'] : ['real-model behavior']),
          'unregistered domain scenarios'];
      }
      const after = revision();
      report.sourceStable = before.diffSha256 === after.diffSha256 && before.commit === after.commit;
      report.status = !report.sourceStable || report.scenarios.some(row => row.status === 'failed') ? 'failed'
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
