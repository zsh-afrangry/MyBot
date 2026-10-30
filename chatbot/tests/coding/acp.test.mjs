// Real local subprocess/stdio and cancellation checks. Offline fixture, no model or service calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {AcpClient, processIdentity, sameProcess} from '../../packages/coding-runtime/acp-client.js';
import {runChecks} from '../../plugins/kurumi-coding/workspaces.js';
import {confinedProcess, probeWriteFence} from '../../packages/coding-runtime/write-fence.js';
import {spawnSync} from 'node:child_process';
function fixture(t, permission) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kurumi-acp-'));
  const marker = path.join(root, 'heartbeat');
  const client = new AcpClient({command: process.execPath, args: [fileURLToPath(new URL('./acp-peer.mjs', import.meta.url))], cwd: root,
    env: {...process.env, FIXTURE_HEARTBEAT: marker}, stderrFile: path.join(root, 'stderr'), permission});
  t.after(async () => {await client.stop(); fs.rmSync(root, {recursive: true, force: true});});
  return {root, marker, client};
}
test('stdio correlates permission requests by prior tool call and returns exact single-use decisions', async t => {
  let calls = 0;
  const f = fixture(t, async (params, call) => {calls++; assert.equal(call.toolCallId, params.toolCallId); return calls === 1;});
  await f.client.initialize(); await f.client.open(f.root, {model: ['fixture', 'fixture']});
  assert.equal((await f.client.prompt('PERMISSION')).stopReason, 'end_turn');
  assert.equal((await f.client.prompt('PERMISSION')).stopReason, 'cancelled'); assert.equal(calls, 2);
});

test('the write fence allows its folder and denies outside create, overwrite, truncate, delete, rename and symlink writes', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kurumi-write-fence-')), root = path.join(base, 'allowed'), outside = path.join(base, 'outside');
  t.after(() => fs.rmSync(base, {recursive: true, force: true})); fs.mkdirSync(root); fs.mkdirSync(outside);
  const sentinel = path.join(outside, 'sentinel'); fs.writeFileSync(sentinel, 'retain'); fs.symlinkSync(outside, path.join(root, 'escape'));
  const boundary = {root, launcher: '/opt/deepseek-harness/node_modules/@deepseek-ai/node-addon-system-linux-x64/bin/landlock-run'};
  assert.equal(probeWriteFence(boundary).backend, 'landlock');
  const code = `const fs=require('fs'),assert=require('assert/strict'),path=require('path'); const [root,out]=process.argv.slice(1);
fs.writeFileSync(path.join(root,'allowed'),'yes'); const file=path.join(out,'sentinel'); assert.equal(fs.readFileSync(file,'utf8'),'retain');
for(const f of [()=>fs.writeFileSync(path.join(out,'new'),'x'),()=>fs.writeFileSync(file,'x'),()=>fs.truncateSync(file),()=>fs.unlinkSync(file),()=>fs.renameSync(file,path.join(root,'moved')),()=>fs.writeFileSync(path.join(root,'escape','new'),'x')]) assert.throws(f,e=>['EACCES','EPERM','EXDEV'].includes(e.code));`;
  const c = confinedProcess(boundary, process.execPath, ['-e', code, root, outside], root);
  const r = spawnSync(c.command, c.args, {cwd: root, env: {...process.env, ...c.env}, encoding: 'utf8'});
  assert.equal(r.status, 0, r.stderr); assert.equal(fs.readFileSync(sentinel, 'utf8'), 'retain');
  assert.equal(fs.readFileSync(path.join(root, 'allowed'), 'utf8'), 'yes'); assert.equal(fs.existsSync(path.join(outside, 'new')), false);
});

test('registered checks inherit the same write boundary', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kurumi-check-fence-')), root = path.join(base, 'allowed'); fs.mkdirSync(root);
  t.after(() => fs.rmSync(base, {recursive: true, force: true}));
  const boundary = {root, launcher: '/opt/deepseek-harness/node_modules/@deepseek-ai/node-addon-system-linux-x64/bin/landlock-run'};
  const outside = path.join(base, 'must-not-exist');
  const checks = await runChecks({checks: [{name: 'outside write', argv: [process.execPath, '-e', 'require("fs").writeFileSync(process.argv[1],"x")', outside]}]}, root, path.join(root, 'check.log'), undefined, boundary);
  assert.equal(checks.ok, false); assert.equal(fs.existsSync(outside), false);
});
test('cancel verifies its own child heartbeat stopped and does not signal the test runner', async t => {
  const f = fixture(t); await f.client.initialize(); await f.client.open(f.root);
  const notified = once(f.client, 'notification'), prompt = f.client.prompt('WAIT'); await notified;
  for (let i = 0; i < 80 && !fs.existsSync(f.marker); i++) await delay(25);
  assert.ok(fs.existsSync(f.marker));
  const parent = processIdentity(process.pid); f.client.cancel(); assert.equal((await prompt).stopReason, 'cancelled');
  assert.equal(await f.client.cancellationStopped(), true);
  const size = fs.statSync(f.marker).size; await delay(100); assert.equal(fs.statSync(f.marker).size, size); assert.equal(sameProcess(parent), true);
});
test('cancellation of a registered check terminates its own process tree', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kurumi-check-stop-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const marker = path.join(root, 'heartbeat'), controller = new AbortController();
  const code = "const{spawn}=require('child_process');spawn(process.execPath,['-e',`setInterval(()=>require('fs').appendFileSync(process.argv[1],'x'),20)`,process.argv[1]],{stdio:'inherit'});setInterval(()=>{},1000)";
  const checking = runChecks({checks: [{name: 'owned check', argv: [process.execPath, '-e', code, marker]}]}, root, path.join(root, 'check.log'), controller.signal);
  for (let i = 0; i < 100 && !fs.existsSync(marker); i++) await delay(20);
  assert.ok(fs.existsSync(marker)); controller.abort(); await assert.rejects(checking, {name: 'AbortError'});
  const size = fs.statSync(marker).size; await delay(100); assert.equal(fs.statSync(marker).size, size);
});
