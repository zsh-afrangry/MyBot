// Explicit --live: one actual DSH task and verified cancellation through the product handler.
// Temporary synthetic project/heartbeat only. No QQ, production configuration, shared DSH service stop or arbitrary PID kill.
// Evidence: docs/verification/coding-delegation-plan-2026-10-28/product-pilot-2026-10-29/README.md.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {fixture} from './fixtures.mjs';
import {AcpClient, sameProcess} from '../../packages/coding-runtime/acp-client.js';
import {targetState} from '../../plugins/kurumi-coding/workspaces.js';
if (!process.argv.includes('--live')) throw Error('Explicit --live required: one real model turn. No QQ messages are sent.');
const output = process.argv.find(a => a.startsWith('--output='))?.slice('--output='.length);
if (!output || !path.isAbsolute(output) || fs.existsSync(output)) throw Error('New absolute --output= report path required');
const f = await fixture(null, {clientFactory: args => new AcpClient(args), configure(config) {
  config.dsh = {command: '/opt/deepseek-harness/node_modules/.bin/dsh', home: '/var/lib/dsh/.dsh', model: ['deepseek-official', 'deepseek-flash']};
}});
const report = {at: new Date().toISOString(), actualDsh: true, actualQq: false, prompts: 1, privateArtifacts: f.root, productionChanged: false};
try {
  const original = targetState({root: f.source});
  const task = await f.run({action: 'start', projectId: 'fixture', task: '这是一次取消流程实验。请在当前工作树直接运行这个前台命令（不要放后台，不要写脚本，不要先改代码）：node -e "setInterval(()=>require(\'fs\').appendFileSync(\'heartbeat.txt\',\'x\'),200)"。该命令预期会一直等待；宿主会随后发送取消请求。不要提交或编辑其他目录。'});
  const marker = path.join(task.cwd, 'heartbeat.txt');
  // Observation deadline for this test, not a task duration policy.
  for (let i = 0; i < 180 && !fs.existsSync(marker) && f.service.active.has(task.id); i++) await delay(500);
  assert.ok(fs.existsSync(marker), 'No live heartbeat observed; see private task record');
  const before = fs.statSync(marker).size; await delay(600); assert.ok(fs.statSync(marker).size > before);
  const runtimeIdentity = f.service.store.get(task.id).runtimeIdentity;
  const cancelled = await f.run({action: 'cancel', taskId: task.id}); assert.equal(cancelled.state, 'cancelled');
  assert.equal(sameProcess(runtimeIdentity), false);
  const size = fs.statSync(marker).size; await delay(1200); assert.equal(fs.statSync(marker).size, size);
  assert.deepEqual(targetState({root: f.source}), original);
  Object.assign(report, {ok: true, taskId: task.id, externalSessionId: cancelled.externalSessionId, state: cancelled.state, heartbeatStopped: true, ownRuntimeStopped: true, originalUnchanged: true});
} catch (error) {report.ok = false; report.error = {code: error.code ?? error.name, message: error.code ?? String(error.message).slice(0, 200)}; process.exitCode = 1;}
finally {
  for (const s of f.services.toReversed()) await s.stop();
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', {flag: 'wx'}); console.log(JSON.stringify({ok: report.ok, actualQq: false, report: output, privateArtifacts: f.root, error: report.error}));
}
