// Real kernel write-fence and trusted-identity regressions in disposable fixtures. No QQ/provider/production I/O.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {confineOwnerExec} from '../../packages/host-exec/index.js';
import qq from '../../plugins/kurumi-qq/index.js';
import {compileAccessConfig} from '../../packages/access-control/config.js';
import {toolPermission} from '../../packages/access-control/index.js';
import {withAccess, memberRow, context, OWNER} from '../access-control/fixtures.mjs';

const launcher = '/home/afrangry/.openclaw-fusion/tools/node-addon-system-linux-x64/bin/landlock-run';
const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kurumi-exec-'fixture-"));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const allowed = path.join(root, 'allowed'), source = path.join(allowed, 'source'); fs.mkdirSync(source, {recursive: true});
  const config = {writeBoundary: {root: allowed, launcher}, workdir: source, timeoutSeconds: 60};
  const run = (command, params = {}, env = {}) => {
    const result = confineOwnerExec({command, ...params}, config); assert(!result.block, result.blockReason);
    return spawnSync('/bin/bash', ['--noprofile', '--norc', '-c', result.params.command], {cwd: result.params.workdir,
      env: {...process.env, ...env}, encoding: 'utf8', timeout: 5000});
  };
  return {root, allowed, source, config, run};
}
test('native payload reads the requested directory and host status, with clean environment and bounded temporary files', t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.source, 'exists.txt'), 'fixture');
  const r = f.run("pwd; ls -1; test -z \"$PROVIDER_CREDENTIAL_FIXTURE\"; test -z \"$BASH_ENV\"; mktemp; free -h", {}, {PROVIDER_CREDENTIAL_FIXTURE: 'not-a-real-secret'});
  assert.equal(r.status, 0, r.stderr); assert(r.stdout.includes(f.source)); assert(r.stdout.includes('exists.txt'));
  assert(r.stdout.includes(path.join(f.allowed, 'state/tmp'))); assert(r.stdout.includes('Mem:'));
});
test('native display title remains metadata and does not prevent default-directory execution', t => {
  const f = fixture(t), title = "Fixture $(touch title-must-not-run) 'quoted'\nlist";
  fs.writeFileSync(path.join(f.source, 'title-fixture.txt'), 'fixture');
  const params = {title, timeoutSeconds: 10};
  const confined = confineOwnerExec({command: 'pwd; ls -1', ...params}, f.config);
  assert(!confined.block, confined.blockReason); assert.equal(confined.params.title, title);
  assert(!confined.params.command.includes(title));
  const r = f.run('pwd; ls -1', params);
  assert.equal(r.status, 0, r.stderr); assert(r.stdout.includes(f.source)); assert(r.stdout.includes('title-fixture.txt'));
  assert(!fs.existsSync(path.join(f.source, 'title-must-not-run')));
  for (const title of [null, 1, {}, [], 'x'.repeat(121), '\0']) {
    assert.equal(confineOwnerExec({command: 'true', title}, f.config).blockReason, 'invalid_owner_exec_parameters');
  }
  assert.equal(confineOwnerExec({command:'true', title:'Fixture', workdir:f.root},f.config).blockReason, 'owner_exec_workdir_outside_boundary');
});
test('ordinary file writes work inside the approved directory, while create/overwrite/truncate/delete/rename and symlink escape fail outside', t => {
  const f = fixture(t), outside = path.join(f.root, 'outside'); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'keep'), 'original'); fs.symlinkSync(outside, path.join(f.source, 'escape'));
  assert.equal(f.run("printf 'ok' > inside; mkdir nested; mv inside nested/moved; rm nested/moved").status, 0);
  const commands = [`touch ${quote(path.join(outside, 'created'))}`, `printf changed > ${quote(path.join(outside, 'keep'))}`,
    `truncate -s 0 ${quote(path.join(outside, 'keep'))}`, `rm ${quote(path.join(outside, 'keep'))}`,
    `mv ${quote(path.join(outside, 'keep'))} ${quote(path.join(outside, 'renamed'))}`, 'touch escape/symlink-created',
    `printf nested > nested/file; mv nested/file ${quote(path.join(outside, 'moved-in'))}`];
  for (const command of commands) {const r = f.run(command); assert.notEqual(r.status, 0, command);}
  assert.deepEqual(fs.readdirSync(outside), ['keep']); assert.equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'original');
});
test('shell chains, nested interpreters and quote/newline injection stay inside the same kernel fence', t => {
  const f = fixture(t), canary = path.join(f.root, 'escaped');
  for (const command of [`cd /; touch ${quote(canary)}`, `python3 -c ${quote(`open(${JSON.stringify(canary)}, 'w').write('escape')`)}`,
    `bash -c ${quote(`touch ${quote(canary)}`)}`, `'; touch ${quote(canary)}; #`, `printf '%s\\n' 'line one' 'line two';\ntouch ${quote(canary)}`]) {
    assert.notEqual(f.run(command).status, 0); assert(!fs.existsSync(canary));
  }
  assert.equal(f.run("printf '%s' \"single' double\\\" dollar\\$ backtick\\`\"").stdout, 'single\' double" dollar$ backtick`');
});
test('caller-selected hosts, environment startup injection, elevated/interactive/background modes and timeout bypass are denied before launch', t => {
  const {config} = fixture(t);
  for (const params of [{host:'node'}, {host:'sandbox'}, {node:'other'}, {env:{BASH_ENV:'/tmp/evil'}}, {env:{PATH:'/tmp'}},
    {elevated:true}, {pty:true}, {background:true}, {timeoutSeconds:0}, {timeoutSeconds:61}, {timeoutSeconds:-1}, {timeoutSeconds:'1'},
    {security:'full'}, {command:''}]) assert(confineOwnerExec({command:'true', ...params}, config).block, JSON.stringify(params));
  const good = confineOwnerExec({command:'true', timeoutSeconds:1}, config);
  assert.equal(good.params.timeoutSeconds, 1); assert.equal(good.params.host, 'gateway'); assert.equal(good.params.elevated, false);
});
test('outside, prefix-lookalike and symlink workdirs, missing configuration and unavailable fence fail closed', t => {
  const f = fixture(t); fs.mkdirSync(path.join(f.root,'allowed-extra')); fs.symlinkSync(f.root, path.join(f.source,'outside-link'));
  for (const workdir of ['../../', f.root, path.join(f.root,'allowed-extra'), 'outside-link']) assert(confineOwnerExec({command:'true', workdir}, f.config).block);
  assert.equal(confineOwnerExec({command:'true'}, undefined).blockReason, 'owner_exec_disabled');
  for (const launcher of ['/usr/bin/false', '/does-not-exist']) {
    assert.equal(confineOwnerExec({command:'true'}, {...f.config, writeBoundary:{...f.config.writeBoundary,launcher}}).blockReason, 'owner_exec_boundary_unavailable');
  }
});
test('runtime directory setup cannot create outside files through a replaced state symlink', t => {
  const f = fixture(t), outside = path.join(f.root,'outside-state'); fs.mkdirSync(outside);
  fs.symlinkSync(outside,path.join(f.allowed,'state'));
  assert(confineOwnerExec({command:'true'},f.config).block);
  assert.deepEqual(fs.readdirSync(outside),[]);
});
test('trusted QQ policy checks owner permission before exec, rejects member/forged/Cron/background callers, and audits no payload', t => {
  const f = fixture(t), cfg = withAccess({channels:{'kurumi-qq':{stateDir:path.join(f.root,'channel')}}});
  cfg.channels['kurumi-qq'].accessControl.subjects.push(memberRow()); let policy;
  qq.register({config:cfg, pluginConfig:{exec:f.config}, registerChannel(){}, registerTool(){}, registerTrustedToolPolicy(p){policy=p;}});
  const [owner,member] = cfg.channels['kurumi-qq'].accessControl.subjects;
  const ctx = row => {const c = context(row); return {agentId:c.agentId,sessionKey:c.sessionKey,runId:'fixture-run',toolCallId:'fixture-call',requester:{channel:c.messageChannel,accountId:'default',senderId:c.requesterSenderId,senderIsOwner:c.senderIsOwner}};};
  const event = {toolName:'exec',params:{command:'printf PRIVATE_COMMAND_SENTINEL',title:'PRIVATE_TITLE_SENTINEL'}};
  assert.equal(toolPermission('exec'), 'host.exec'); assert(policy.evaluate(event,ctx(owner)).params);
  for (const c of [ctx(member), {...ctx(member),requester:ctx(owner).requester}, {...ctx(owner),requester:undefined},
    {...ctx(owner),sessionKey:'agent:main:cron:12345678-1234-1234-1234-123456789abc'},
    {agentId:'researcher',sessionKey:'agent:researcher:kurumi-task-'+'a'.repeat(24)}]) assert(policy.evaluate(event,c).block);
  owner.permissions['host.exec']=false; assert.equal(policy.evaluate(event,ctx(owner)).blockReason,'capability_not_allowed');
  const audit = fs.readFileSync(path.join(f.root,'channel/access-events.jsonl'),'utf8');
  assert(!audit.includes('PRIVATE_COMMAND_SENTINEL')); assert(!audit.includes('PRIVATE_TITLE_SENTINEL')); assert(audit.includes('host.exec')); assert(audit.includes('writeRoot'));
  assert(audit.includes('"decision":"allow"')); assert(audit.includes('"decision":"deny"'));
});
test('source enables only owner native exec; member agents, background agents and all process tools remain restricted', () => {
  const root = fileURLToPath(new URL('../../../',import.meta.url));
  const source = JSON.parse(fs.readFileSync(path.join(root,'config/runtime.config.json')));
  const access = JSON.parse(fs.readFileSync(path.join(root,'config/access-control.json')));
  const config = compileAccessConfig(source,access), main = config.agents.entries.main.tools;
  assert(main.alsoAllow.includes('exec')); assert(!main.deny.includes('exec')); assert(!config.tools.deny.includes('exec'));
  assert(config.tools.deny.includes('process')); assert(main.deny.includes('process'));
  assert.equal(main.exec.host,'gateway'); assert.equal(main.exec.mode,'full');
  assert.equal(access.subjects.filter(row=>row.permissions['host.exec']===true).length,1);
  assert.equal(access.subjects.find(row=>row.permissions['host.exec']===true).role,'owner');
  for (const [id,agent] of Object.entries(config.agents.entries)) if (id!=='main') assert(agent.tools.deny?.includes('exec')||!agent.tools.allow?.includes('exec'),id);
  assert.equal(config.channels['kurumi-qq'].testIngress,false);
  assert.equal(config.plugins.entries['kurumi-qq'].config.exec.writeBoundary.root,config.plugins.entries['kurumi-coding'].config.writeBoundary.root);
});
