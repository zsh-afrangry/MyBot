// docs/22: real isolated OpenClaw + configured chat model, synthetic attachment I/O and translator.
// Explicit new --out under docs/verification/paper-translation-2026-10-17/file-ingress-2026-10-19/.
// No production writes, translation API calls, QQ/mail delivery, or production testIngress change.
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {randomBytes} from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {WebSocketServer} from 'ws';
import {compileAccessConfig} from '../../packages/access-control/config.js';
import {Documents, sha256} from '../../packages/documents/index.js';
import {ownerPolicy, memberRow, OWNER, MEMBER} from '../access-control/fixtures.mjs';
import {pdf} from './fixtures.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const outIndex = process.argv.indexOf('--out'), out = outIndex < 0 ? undefined : process.argv[outIndex + 1];
if (!out || !path.isAbsolute(out) || fs.existsSync(out)) throw Error('Explicit absolute, new --out required');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kurumi-file-host-'));
const token = randomBytes(24).toString('hex'), bot = '123456789';
const report = {at: new Date().toISOString(), boundary: 'Real isolated OpenClaw and configured chat model; actual attachment handler, PDF catalog, tools and job service. Synthetic attachment download, fixture translator and mock OneBot. No production state writes, real translation API, QQ or SMTP delivery.', cases: []};
const policy = ownerPolicy(); policy.subjects.push(memberRow());
const cfg = compileAccessConfig(JSON.parse(fs.readFileSync(path.join(repo, 'config/runtime.config.json'))), policy); delete cfg._managed;
const documents = new Documents(path.join(root, 'documents'));
const oldDocument = await documents.add(pdf('Historical paper fixture'), {filename: '历史验收论文.pdf'}, {inspect: async () => ({pages: 1})});
const uploads = [];
const server = http.createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) {res.writeHead(401); res.end(); return;}
  let raw = ''; for await (const part of req) raw += part;
  const args = raw ? JSON.parse(raw) : {};
  let data = req.url === '/get_login_info' ? {user_id: Number(bot)} : {online: true, good: true};
  if (req.url === '/upload_private_file') {
    assert([OWNER, MEMBER].includes(String(args.user_id))); assert(fs.existsSync(args.file));
    uploads.push({to: String(args.user_id), filename: args.name, sha256: sha256(fs.readFileSync(args.file))}); data = {file_id: 'synthetic-' + uploads.length};
  }
  if (req.url === '/send_private_msg') throw Error('All chat replies must be captured, never transmitted');
  res.writeHead(200, {'Content-Type': 'application/json'}); res.end(JSON.stringify({status: 'ok', retcode: 0, data}));
});
server.listen(0, '127.0.0.1'); await once(server, 'listening'); const ws = new WebSocketServer({server});
const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening'); const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));

const fixture = path.join(root, 'paper-plugin'); fs.mkdirSync(fixture);
fs.copyFileSync(path.join(repo, 'chatbot/plugins/kurumi-papers/openclaw.plugin.json'), path.join(fixture, 'openclaw.plugin.json'));
fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({name: 'kurumi-papers', type: 'module', openclaw: {extensions: ['./index.js']}}));
const source = name => JSON.stringify(pathToFileURL(path.join(repo, name)).href);
fs.writeFileSync(path.join(fixture, 'index.js'), `
import fs from 'node:fs'; import path from 'node:path';
import {createPaperPlugin} from ${source('chatbot/plugins/kurumi-papers/index.js')};
import {PaperService} from ${source('chatbot/plugins/kurumi-papers/service.js')};
import {handleInbound} from ${source('chatbot/plugins/kurumi-qq/src/inbound.js')};
import {stagePdf} from ${source('chatbot/plugins/kurumi-qq/src/files.js')};
import {pdf} from ${source('chatbot/tests/papers/fixtures.mjs')};
const actual=createPaperPlugin({serviceFactory:(config,deps)=>new PaperService(config,{...deps,runner:async({work,outputKind})=>{
 const result={usage:{requests:0,fixture:true}};
 for(const kind of outputKind==='both'?['dual','mono']:[outputKind]){result[kind]=path.join(work,kind+'.pdf');fs.writeFileSync(result[kind],pdf('Synthetic translated '+kind+' '+path.basename(work)));}
 return result;
}})});
export default {...actual,register(api){actual.register(api);
 api.registerGatewayMethod('paper-fixture.inbound',async({params,respond})=>{
  try{
   const captured=[];
   const result=await handleInbound({cfg:api.config,runtime:api.runtime,event:params.event,selfId:${JSON.stringify(bot)},
    deliverOverride:async p=>captured.push({to:p.to,text:p.text,mediaUrl:p.mediaUrl}),
    stageFile:(segment,cfg,options)=>stagePdf(segment,cfg,{...options,
     apiCall:async()=>{if(segment.data.file_id==='unavailable')throw Error('Synthetic file download failure');return {url:'https://multimedia.nt.qq.com/synthetic'};},
     fetcher:async()=>new Response(segment.data.file_id==='invalid'?Buffer.from('not a PDF'):pdf('Current input '+segment.data.file_id)),
    }),
   });respond(true,{...result,captured});
  }catch{respond(false,undefined,{code:'FIXTURE_FAILED',message:'Isolated attachment fixture failed'});}
 },{scope:'operator.admin'});
}};
`);

cfg.gateway = {mode: 'local', port, bind: 'loopback', auth: {mode: 'token', token}, controlUi: {enabled: false}};
cfg.agents.defaults.workspace = path.join(root, 'workspace');
const tools = {profile: 'messaging', alsoAllow: ['kurumi_document', 'kurumi_translate', 'kurumi_document_send'],
  deny: ['read', 'write', 'edit', 'exec', 'process', 'message', 'sessions_spawn', 'automations']};
cfg.agents.entries = Object.fromEntries(['main', 'qq-user-' + MEMBER].map(id => [id, {...cfg.agents.entries[id], tools,
  workspace: id === 'main' ? path.join(root, 'workspace') : path.join(root, 'users', MEMBER, 'workspace')}]));
for (const [id, agent] of Object.entries(cfg.agents.entries)) {
  fs.mkdirSync(agent.workspace, {recursive: true});
  fs.copyFileSync(path.join(repo, 'scripts/fusion/templates', id === 'main' ? 'AGENTS.md' : 'MEMBER_AGENTS.md'), path.join(agent.workspace, 'AGENTS.md'));
  fs.copyFileSync(path.join(repo, 'roles/小鲸鱼.md'), path.join(agent.workspace, 'SOUL.md'));
}
cfg.plugins = {allow: ['kurumi-qq', 'kurumi-papers'], load: {paths: [path.join(repo, 'chatbot/plugins/kurumi-qq'), fixture]},
  entries: {'kurumi-qq': {enabled: true}, 'kurumi-papers': {enabled: true, config: {root: documents.root, python: '/unused', credentialsFile: '/unused', liveTranslationEnabled: true}}}, slots: {memory: 'none'}};
cfg.tools = {deny: cfg.tools.deny, fs: cfg.tools.fs, web: {search: {enabled: false}, fetch: {enabled: false}}};
cfg.cron = {enabled: false}; cfg.logging.file = path.join(root, 'runtime.log');
cfg.channels['kurumi-qq'] = {...cfg.channels['kurumi-qq'], httpUrl: `http://127.0.0.1:${server.address().port}`, wsUrl: `ws://127.0.0.1:${server.address().port}`,
  httpTokenFile: path.join(root, 'token'), wsTokenFile: path.join(root, 'token'), stateDir: path.join(root, 'channel'), mediaRoot: path.join(root, 'media'), testIngress: false};
for (const dir of ['channel', 'media']) fs.mkdirSync(path.join(root, dir));
fs.writeFileSync(path.join(root, 'token'), token, {mode: 0o600});
fs.writeFileSync(path.join(root, 'openclaw.json'), JSON.stringify(cfg), {mode: 0o600});
const secrets = JSON.parse(fs.readFileSync('/home/afrangry/.openclaw-fusion/runtime-env.json'));
const fd = fs.openSync(path.join(root, 'gateway.log'), 'w', 0o600);
const child = spawn(process.execPath, [path.join(repo, 'node_modules/openclaw/openclaw.mjs'), 'gateway', 'run', '--port', String(port), '--bind', 'loopback', '--auth', 'token', '--tailscale', 'off'],
  {cwd: repo, env: {...process.env, ...secrets, OPENCLAW_GATEWAY_TOKEN: token, OPENCLAW_STATE_DIR: root, OPENCLAW_CONFIG_PATH: path.join(root, 'openclaw.json'), OPENCLAW_AGENT_DIR: path.join(root, 'agents/main/agent')}, stdio: ['ignore', fd, fd], detached: true});
fs.closeSync(fd);
const {callGatewayFromCli} = await import('openclaw/plugin-sdk/gateway-runtime');
const call = (method, params = {}, timeout = 180000) => callGatewayFromCli(method, {url: `ws://127.0.0.1:${port}`, token, timeout: String(timeout), json: true}, params);
let sequence = 0;
const text = content => ({type: 'text', data: {text: content}});
const file = (name, id = name) => ({type: 'file', data: {name, file_id: id}});
const jobs = () => fs.readdirSync(path.join(documents.root, 'jobs')).map(name => JSON.parse(fs.readFileSync(path.join(documents.root, 'jobs', name))));
async function turn(label, message, sender = OWNER, event) {
  const result = await call('paper-fixture.inbound', {event: event ?? {post_type: 'message', message_type: 'private', self_id: Number(bot), user_id: Number(sender), message_id: -800000 - ++sequence, time: Math.floor(Date.now() / 1000), message}});
  assert(result.ok || result.duplicate, label + ' rejected'); report.cases.push({label, result}); return result;
}
async function waitForJob(count) {
  for (let n = 0; n < 100; n++) {
    const list = jobs(); const latest = list.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (list.length === count && latest?.status === 'succeeded' && latest?.delivery?.status === 'platform_accepted') return latest;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error('Fixture job did not complete as expected');
}
function assertDelivered(job, index) {
  const owner = job.requester.subjectId === OWNER;
  const catalog = owner ? documents : new Documents(path.join(documents.root, 'subjects', job.requester.subjectId));
  const artifact = catalog.describe(job.artifacts.dual);
  assert.equal(artifact.source.inputId, job.documentId);
  assert.equal(uploads[index].sha256, artifact.sha256);
  assert.equal(uploads[index].to, job.requester.subjectId);
}
try {
  let ready = false;
  for (let n = 0; n < 80; n++) {try {await call('health', {}, 1000); ready = true; break;} catch {if (child.exitCode !== null) throw Error('Isolated Gateway exited'); await new Promise(resolve => setTimeout(resolve, 500));}}
  assert(ready, 'Isolated Gateway not ready');
  await turn('establish-historical-translation', [text('请把已登记的“历史验收论文.pdf”翻译成中文，用默认配置，只要双语PDF，完成后发我。')]);
  const old = await waitForJob(1); assert.equal(old.documentId, oldDocument.id); assert.equal(uploads.length, 1); assertDelivered(old, 0);

  const mdEvent = {post_type: 'message', message_type: 'private', self_id: Number(bot), user_id: Number(OWNER), message_id: -899999, message: [file('SOUL.md')]};
  const md = await turn('md-with-existing-history', undefined, OWNER, mdEvent);
  assert.equal(md.modelDispatched, false); assert.match(JSON.stringify(md.captured), /SOUL\.md.*只接受PDF/);
  assert.equal((await turn('duplicate-md', undefined, OWNER, mdEvent)).duplicate, true);
  assert.equal(jobs().length, 1); assert.equal(uploads.length, 1);
  const memberMd = await turn('member-offline-md', undefined, MEMBER, {post_type: 'notice', notice_type: 'offline_file', self_id: Number(bot), user_id: Number(MEMBER), file: {id: 'member-md', name: 'notes.md'}});
  assert.equal(memberMd.modelDispatched, false); assert(memberMd.captured.every(x => x.to === 'user:' + MEMBER));
  for (const [id, expected] of [['unavailable', /下载失败/], ['invalid', /校验失败/]]) {
    const failed = await turn(id + '-pdf', [file('candidate.pdf', id)]);
    assert.equal(failed.modelDispatched, false); assert.match(JSON.stringify(failed.captured), expected);
    assert.equal(jobs().length, 1); assert.equal(uploads.length, 1);
  }
  await turn('md-text-request-read', [text('请读取这份MD并总结内容。'), file('notes.md')]);
  assert.equal(jobs().length, 1); assert.equal(uploads.length, 1);
  await turn('md-text-explicit-resend-old-artifact', [text('这个MD先不用管。请把之前那份已经生成的双语译稿再发我一次，不要重新翻译。'), file('notes.md')]);
  assert.equal(jobs().length, 1); assert.equal(uploads.length, 2); assert.equal(uploads[1].to, OWNER);
  assertDelivered(old, 1);
  await turn('current-pdf-with-explicit-translation', [text('请翻译这次上传的“本次验收论文.pdf”，默认配置，只要双语PDF，做好发我。'), file('本次验收论文.pdf', 'current')]);
  const current = await waitForJob(2); assert.notEqual(current.documentId, oldDocument.id); assert.equal(uploads.length, 3);
  assertDelivered(current, 2); assert.notEqual(uploads[2].sha256, uploads[0].sha256);
  await turn('pdf-without-purpose', [file('仅供查看.pdf', 'no-purpose')]);
  assert.equal(jobs().length, 2); assert.equal(uploads.length, 3);
  await turn('establish-pending-translation', [text('接下来我会再上传一份新论文，请等文件上传后按默认配置翻译，只要双语PDF并发给我。现在先等我上传。')]);
  assert.equal(jobs().length, 2); assert.equal(uploads.length, 3);
  await turn('pending-translation-current-pdf-only', [file('待续论文.pdf', 'pending')]);
  const pending = await waitForJob(3); assert.notEqual(pending.documentId, current.documentId); assert.notEqual(pending.documentId, oldDocument.id);
  assertDelivered(pending, 3); assert.notEqual(uploads[3].sha256, uploads[2].sha256);
  await turn('member-own-current-pdf', [text('请把这份PDF翻译成中文，只要双语PDF，默认配置，完成后发我。'), file('成员论文.pdf', 'member-current')], MEMBER);
  const member = await waitForJob(4); assert.equal(member.requester.subjectId, MEMBER); assert.equal(uploads.at(-1).to, MEMBER);
  assertDelivered(member, 4);
  report.passed = true; report.jobs = jobs().map(j => ({documentId: j.documentId, artifactId: j.artifacts.dual, requester: j.requester.subjectId, status: j.status, deliveryKind: j.deliveryKind, delivery: j.delivery.status, fixtureRequests: j.usage.requests}));
} catch (error) {report.passed = false; report.error = error.message; report.diagnosticsRoot = root; process.exitCode = 1;}
finally {
  child.kill('SIGTERM');
  if (child.exitCode === null) {let timer; await Promise.race([once(child, 'exit'), new Promise(resolve => {timer = setTimeout(() => {try {process.kill(-child.pid, 'SIGKILL');} catch {} resolve();}, 35000);})]); clearTimeout(timer);}
  for (const client of ws.clients) client.terminate(); await new Promise(resolve => ws.close(resolve)); await new Promise(resolve => server.close(resolve));
  report.childStopped = child.exitCode !== null || child.signalCode !== null; report.mockUploads = uploads;
  fs.mkdirSync(path.dirname(out), {recursive: true}); fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  if (report.passed) fs.rmSync(root, {recursive: true, force: true});
  console.log(JSON.stringify({passed: report.passed, cases: report.cases.length, error: report.error, evidence: out}));
}
