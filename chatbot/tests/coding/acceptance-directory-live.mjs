// Explicit live DSH/model call; synthetic non-Git directory within the already approved pilot only. No QQ.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fixture, liveConfig} from './fixtures.mjs';
import {AcpClient} from '../../packages/coding-runtime/acp-client.js';
import {directoryState} from '../../plugins/kurumi-coding/directory-workspaces.js';
if (!process.argv.includes('--live')) throw Error('Explicit --live required');
const output = process.argv.find(v => v.startsWith('--output='))?.slice(9);
if (!output || !path.isAbsolute(output) || fs.existsSync(output)) throw Error('New absolute report path required');
const live = liveConfig(), f = await fixture(null, {parent: live.parent, directoryProject: true, clientFactory: args => new AcpClient(args),
  sourceSetup(source) {fs.writeFileSync(path.join(source, '原稿.txt'), 'exact ordinary text\n');}, configure(config) {config.dsh = live.dsh;}});
const report = {schemaVersion: 1, at: new Date().toISOString(), actualDsh: true, actualQq: false, ownerConfirmation: 'synthetic-local-fixture-only', privateArtifacts: f.root, cases: []};
try {
  const before = directoryState(f.source), task = await f.run({action: 'start', projectId: 'fixture', task: '这是私人实验目录的任务副本。把 value.mjs 中导出值改为 5。使用终端将普通文件“原稿.txt”改名为“结果.md”，只改名称和后缀，逐字保留内容。用终端验证改名及 value 值并输出 DIRECTORY_EXPERIMENT_VERIFIED。不要提交、合入或编辑副本之外，由宿主完成固定检查。'});
  const ready = await f.settle(task.id); assert.equal(ready.state, 'ready'); assert.deepEqual(directoryState(f.source), before);
  assert.match((await f.run({action: 'result', taskId: task.id})).result.page.text, /DIRECTORY_EXPERIMENT_VERIFIED/);
  const preview = await f.run({action: 'preview', taskId: task.id});
  await assert.rejects(f.run({action: 'merge', taskId: task.id, proposalId: preview.proposalId}), /approval_required/);
  assert.deepEqual(directoryState(f.source), before); f.approve(preview);
  const result = await f.run({action: 'merge', taskId: task.id, proposalId: preview.proposalId}); assert.equal(result.state, 'written_back');
  assert.equal(fs.existsSync(path.join(f.source, '.git')), false); assert.equal(fs.existsSync(path.join(f.source, '原稿.txt')), false);
  assert.equal(fs.readFileSync(path.join(f.source, '结果.md'), 'utf8'), 'exact ordinary text\n');
  assert.equal((await import(path.join(f.source, 'value.mjs'))).value, 5);
  report.cases = [{name: 'actual_dsh_private_directory_and_terminal', ok: true, state: ready.state, checks: ready.checks},
    {name: 'confirmation_required_original_unchanged', ok: true}, {name: 'confirmed_fenced_writeback_no_original_git', ok: true, state: result.state}];
  report.ok = true;
} catch (error) {report.ok = false; report.failure = {code: error.code ?? error.name, message: error.name === 'AssertionError' ? error.message.slice(0, 200) : error.code ?? 'see private artifacts'}; process.exitCode = 1;}
finally {for (const service of f.services.toReversed()) await service.stop(); fs.mkdirSync(path.dirname(output), {recursive: true}); fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', {flag: 'wx'}); console.log(JSON.stringify({ok: report.ok, report: output, privateArtifacts: f.root}));}
