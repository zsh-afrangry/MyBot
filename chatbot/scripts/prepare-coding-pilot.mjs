// Prepare a NEW synthetic Git project and a reviewable configuration draft only.
// No runtime config apply, Gateway restart, model/QQ calls, remote Git operation or production data write.
// Docs: docs/28_本机编码工具委托与实验任务.md; evidence coding-delegation-plan-2026-10-28/product-pilot-2026-10-29/.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {git} from '../plugins/kurumi-coding/workspaces.js';
const index = process.argv.indexOf('--root'), root = process.argv[index + 1];
if (index < 0 || !root || !path.isAbsolute(root) || path.resolve(root) !== root || fs.existsSync(root)
  || !fs.existsSync(path.dirname(root)) || fs.realpathSync(path.dirname(root)) !== path.dirname(root)) throw Error('Require --root with a new absolute directory under an existing canonical parent');
const repo = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
fs.mkdirSync(root, {mode: 0o700});
const source = path.join(root, 'source'); fs.mkdirSync(source);
fs.writeFileSync(path.join(source, 'math.mjs'), 'export const sum = (a, b) => a + b;\n');
fs.writeFileSync(path.join(source, 'math.test.mjs'), `import test from 'node:test'; import assert from 'node:assert/strict'; import {sum} from './math.mjs';
test('sum integers',()=>assert.equal(sum(2,3),5)); test('sum negatives',()=>assert.equal(sum(-2,1),-1)); test('sum zero',()=>assert.equal(sum(0,0),0));\n`);
fs.writeFileSync(path.join(source, 'README.md'), '# Local coding pilot\nSynthetic repository. No remotes or production data. Keep existing tests.\n');
fs.writeFileSync(path.join(source, 'AGENTS.md'), '# Synthetic coding pilot\nWork only in your assigned task worktree. The host runs registered checks, commits and merges. Do not edit source/other worktrees, commit, merge, push, use network services, install software or operate production services. Keep existing tests. Extra backend permission requests will be rejected in this pilot.\n');
git(source, 'init', '-b', 'main'); git(source, 'add', '.'); git(source, '-c', 'user.name=Kurumi Pilot', '-c', 'user.email=pilot@localhost', 'commit', '-m', 'Initialize synthetic coding pilot');
fs.writeFileSync(path.join(source, 'local-draft.txt'), 'Untracked operator draft: must remain untouched.\n');
const check = path.join(root, 'fixed-check.mjs');
fs.writeFileSync(check, `import assert from 'node:assert/strict'; import path from 'node:path'; import {pathToFileURL} from 'node:url';
const m = await import(pathToFileURL(path.join(process.env.CODING_WORKTREE,'math.mjs'))); assert.equal(m.sum(2,3),5); assert.equal(m.sum(-2,1),-1); assert.equal(m.sum(0,0),0);
if (typeof m.clamp === 'function') {for(const [x,a,b,w] of [[-2,0,10,0],[5,0,10,5],[15,0,10,10],[1.5,0,2,1.5],[2,2,2,2]]) assert.equal(m.clamp(x,a,b),w); assert.throws(()=>m.clamp(1,3,2),RangeError);} console.log('fixed pilot checks passed');\n`, {mode: 0o600});
const pluginConfig = {pilot: true, writeBoundary: {root, launcher: '/opt/deepseek-harness/node_modules/@deepseek-ai/node-addon-system-linux-x64/bin/landlock-run'}, root: path.join(root, 'state'), worktrees: path.join(root, 'worktrees'),
  dsh: {command: '/opt/deepseek-harness/node_modules/.bin/dsh', home: '/var/lib/dsh/.dsh', model: ['deepseek-official', 'deepseek-flash']},
  projects: [{id: 'dsh-pilot', root: source, branch: 'main', checks: [{name: 'fixed pilot assertions', argv: [process.execPath, check]}, {name: 'project node tests', argv: [process.execPath, '--test']},
    {name: 'independent python quicksort', argv: ['/usr/bin/python3', '-B', '/home/afrangry/kurumi-fusion/chatbot/scripts/check-coding-pilot-python.py'], skipExitCode: 77, timeoutMs: 15000}]}]};
const sourceConfig = JSON.parse(fs.readFileSync(path.join(repo, 'config/runtime.config.json')));
// Draft additions are intentionally separate from the source's managed configuration.
const pluginPath = '/home/afrangry/kurumi-fusion/chatbot/plugins/kurumi-coding';
const additions = {
  'agents.entries.main.tools.alsoAllow': {append: 'kurumi_code'},
  'plugins.allow': {append: 'kurumi-coding'}, 'plugins.load.paths': {append: pluginPath},
  'plugins.entries.kurumi-coding': {enabled: true, config: pluginConfig},
};
fs.writeFileSync(path.join(root, 'configuration-additions.json'), JSON.stringify(additions, null, 2) + '\n', {mode: 0o600});
sourceConfig.agents.entries.main.tools.alsoAllow.push('kurumi_code'); sourceConfig.plugins.allow.push('kurumi-coding');
sourceConfig.plugins.load.paths.push(pluginPath); sourceConfig.plugins.entries['kurumi-coding'] = {enabled: true, config: pluginConfig};
fs.writeFileSync(path.join(root, 'runtime.config.proposed.json'), JSON.stringify(sourceConfig, null, 2) + '\n', {mode: 0o600});
console.log(JSON.stringify({prepared: true, projectId: 'dsh-pilot', source, baseline: git(source, 'rev-parse', 'HEAD').trim(), review: path.join(root, 'configuration-additions.json'), runtimeApplied: false}));
