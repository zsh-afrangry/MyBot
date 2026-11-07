// Real isolated OpenClaw native exec, local deterministic model and synthetic OneBot.
// Creates only disposable fixtures and the explicit new --out file; no production/QQ/provider/DSH I/O.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {callGatewayFromCli} from 'openclaw/plugin-sdk/gateway-runtime';
import {compileAccessConfig} from '../../packages/access-control/config.js';
import {ownerPolicy,memberRow,OWNER,MEMBER} from '../access-control/fixtures.mjs';
import {probeWriteFence} from '../../packages/coding-runtime/write-fence.js';
const {WebSocketServer} = createRequire(new URL('../../plugins/kurumi-qq/package.json', import.meta.url))('ws');

const arg = process.argv.indexOf('--out'), out = arg < 0 ? undefined : process.argv[arg + 1];
if (!out || !path.isAbsolute(out) || fs.existsSync(out)) throw Error('Require a new absolute --out');
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kurumi-native-exec-host-'));
const allowed = path.join(root, 'approved'), source = path.join(allowed, 'source'), worktree = path.join(allowed, 'worktrees', 'fixture');
fs.mkdirSync(source, {recursive: true}); fs.mkdirSync(worktree, {recursive: true});
fs.writeFileSync(path.join(source, 'DIRECT_SOURCE_SENTINEL.txt'), 'fixture');
fs.writeFileSync(path.join(worktree, 'DIRECT_WORKTREE_SENTINEL.py'), 'fixture');
const canary = path.join(root, 'outside-write'), token = randomBytes(24).toString('hex'), bot = '900001';
const q = s => "'" + s.replaceAll("'", "'\\''") + "'";
const plans = Object.fromEntries(Object.entries({
  source: {command: 'pwd; ls -1', timeoutSeconds: 10},
  worktree: {command: 'pwd; ls -1', workdir: worktree},
  host: {command: "free -h; printf 'CREDENTIAL=%s\\n' \"${PROVIDER_CREDENTIAL_FIXTURE-unset}\""},
  write: {command: "printf 'inside' > inside.txt"},
  outside: {command: `printf 'escape' > ${q(canary)}`},
  env: {command: `touch ${q(canary)}`, env: {BASH_ENV: '/outside-startup'}},
  elevated: {command: `touch ${q(canary)}`, elevated: true},
  cwd: {command: `touch ${q(canary)}`, workdir: root},
  node: {command: `touch ${q(canary)}`, host: 'node', node: 'unapproved'},
  timeout: {command: 'sleep 5; touch late.txt', timeoutSeconds: 1},
  member: {command: 'touch member-ran.txt'},
}).map(([name,params])=>[name,{title:'Native exec fixture '+name,...params}]));
const report = {at: new Date().toISOString(), boundary: 'Real isolated Gateway/QQ plugin/native exec with local deterministic model and synthetic OneBot. No model provider, external API, QQ network or production write; DSH is not launched. Ordinary-file write confinement only.', cases: []};
let modelRequests = 0;
const model = http.createServer(async (req, res) => {
  try {
    let raw = ''; for await (const part of req) raw += part;
    const body = JSON.parse(raw), messages = body.messages ?? [];
    const userIndex = messages.findLastIndex(m => m.role === 'user' && JSON.stringify(m.content).includes('EXEC_CASE:'));
    const match = /EXEC_CASE:(\w+)/.exec(JSON.stringify(messages[userIndex]?.content));
    const after = messages.slice(userIndex + 1), toolMessage = after.findLast(m => m.role === 'tool');
    const nameOf = m => m?.name ?? after.flatMap(x => x.tool_calls ?? []).find(x => x.id === m?.tool_call_id)?.function?.name;
    const completed = toolMessage && !['tool_search','tool_describe'].includes(nameOf(toolMessage));
    let tool = !completed && match ? ['exec', plans[match[1]]] : undefined;
    const available = (body.tools ?? []).map(t => t.function?.name);
    if (tool && !available.includes('exec') && available.includes('tool_search')) tool = after.some(m => m.role === 'tool' && nameOf(m) === 'tool_search')
      ? ['dispatch_action', {id:'exec', args:tool[1]}] : ['tool_search', {query:'exec', limit:1}];
    const message = tool ? {role:'assistant',content:null,tool_calls:[{id:'call_'+randomBytes(8).toString('hex'),type:'function',function:{name:tool[0],arguments:JSON.stringify(tool[1])}}]}
      : {role:'assistant',content:'EXEC_RESULT '+(typeof toolMessage?.content === 'string' ? toolMessage.content : JSON.stringify(toolMessage?.content ?? 'none'))};
    modelRequests++;
    res.setHeader('content-type', body.stream ? 'text/event-stream' : 'application/json');
    if (body.stream) {
      const chunk = {id:'chatcmpl-fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta:tool ? {...message,tool_calls:message.tool_calls.map((x,index)=>({...x,index}))} : message,finish_reason:null}]};
      res.write('data: '+JSON.stringify(chunk)+'\n\n');
      res.write('data: '+JSON.stringify({...chunk,choices:[{index:0,delta:{},finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}})+'\n\n');
      res.end('data: [DONE]\n\n');
    } else res.end(JSON.stringify({id:'fixture',object:'chat.completion',created:1,model:'fixture',choices:[{index:0,message,finish_reason:tool?'tool_calls':'stop'}]}));
  } catch {res.writeHead(500); res.end();}
});
model.listen(0,'127.0.0.1'); await once(model,'listening');
const onebot = http.createServer(async (req,res) => {
  if (req.headers.authorization !== `Bearer ${token}`) {res.writeHead(401); res.end(); return;}
  for await (const _ of req) {}
  res.end(JSON.stringify({status:'ok',retcode:0,data:req.url === '/get_login_info' ? {user_id:Number(bot)} : {message_id:1}}));
});
onebot.listen(0,'127.0.0.1'); await once(onebot,'listening'); const ws = new WebSocketServer({server:onebot});
const socket = net.createServer(); socket.listen(0,'127.0.0.1'); await once(socket,'listening'); const port = socket.address().port; await new Promise(r=>socket.close(r));
const boundary = {root:allowed,launcher:'/home/afrangry/.openclaw-fusion/tools/node-addon-system-linux-x64/bin/landlock-run'};
report.fence = probeWriteFence(boundary);
const policy = ownerPolicy(); policy.subjects.push(memberRow());
let config = {
  gateway:{mode:'local',port,bind:'loopback',auth:{mode:'token',token},controlUi:{enabled:false}},
  agents:{ownership:'explicit',defaults:{workspace:path.join(root,'workspace'),model:{primary:'fixture/fixture'},systemAgent:{agentId:'main'},heartbeat:{every:'0m'}},
    entries:{main:{workspace:path.join(root,'workspace'),tools:{profile:'messaging',alsoAllow:['exec'],deny:['read','write','edit','apply_patch','process','message','sessions_spawn'],exec:{host:'gateway',mode:'full',timeoutSeconds:60,notifyOnExit:false},elevated:{enabled:false}}}}},
  models:{providers:{fixture:{baseUrl:`http://127.0.0.1:${model.address().port}/v1`,apiKey:'fixture',api:'openai-completions',models:[{id:'fixture',name:'fixture',reasoning:false,input:['text'],contextWindow:64000,maxTokens:3000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]}}},
  plugins:{allow:['kurumi-qq'],load:{paths:[path.join(repo,'chatbot/plugins/kurumi-qq')]},entries:{'kurumi-qq':{enabled:true,config:{exec:{writeBoundary:boundary,workdir:source,timeoutSeconds:60}}}},slots:{memory:'none'}},
  channels:{'kurumi-qq':{enabled:true,httpUrl:`http://127.0.0.1:${onebot.address().port}`,wsUrl:`ws://127.0.0.1:${onebot.address().port}`,httpTokenFile:path.join(root,'channel-token'),wsTokenFile:path.join(root,'channel-token'),stateDir:path.join(root,'channel'),mediaRoot:path.join(root,'media'),testIngress:true}},
  session:{dmScope:'per-channel-peer'},cron:{enabled:false},tools:{deny:['process','message','sessions_spawn'],web:{search:{enabled:false},fetch:{enabled:false}}},logging:{file:path.join(root,'runtime.log')},
};
config = compileAccessConfig(config,policy);
// Deliberately expose the native surface to the synthetic member to test the mandatory gate as well as catalog policy.
config.agents.entries['qq-user-'+MEMBER].tools.allow.push('exec');
config.agents.entries['qq-user-'+MEMBER].tools.deny = config.agents.entries['qq-user-'+MEMBER].tools.deny.filter(name=>name!=='exec');
for (const row of policy.subjects) {
  const directory = config.agents.entries[row.role==='owner'?'main':'qq-user-'+row.qq].workspace;
  fs.mkdirSync(directory,{recursive:true});
  fs.writeFileSync(path.join(directory,'AGENTS.md'), row.role==='owner' ? '# Synthetic exec fixture\n' : '# kurumi-isolated-member-v1\n');
}
fs.writeFileSync(path.join(root,'channel-token'),token,{mode:0o600});
fs.writeFileSync(path.join(root,'openclaw.json'),JSON.stringify(config),{mode:0o600});
const fd = fs.openSync(path.join(root,'gateway.log'),'w',0o600);
const child = spawn(process.execPath,[path.join(repo,'node_modules/openclaw/openclaw.mjs'),'gateway','run','--port',String(port),'--bind','loopback','--auth','token','--tailscale','off'],{
  cwd:repo,detached:true,stdio:['ignore',fd,fd],env:{PATH:process.env.PATH,HOME:process.env.HOME,LANG:'C.UTF-8',OPENCLAW_EXEC_SHELL_SNAPSHOT:'0',
    PROVIDER_CREDENTIAL_FIXTURE:'not-a-real-secret',OPENCLAW_STATE_DIR:root,OPENCLAW_CONFIG_PATH:path.join(root,'openclaw.json'),OPENCLAW_GATEWAY_TOKEN:token,OPENCLAW_AGENT_DIR:path.join(root,'agents/main/agent')},
}); fs.closeSync(fd);
const call = (method,params={},timeout=45000) => callGatewayFromCli(method,{url:`ws://127.0.0.1:${port}`,token,timeout:String(timeout),json:true},params);
let seq = 100;
const turn = async (name,id=OWNER) => {
  const r = await call('kurumi-qq.testInbound',{capture:true,event:{post_type:'message',message_type:'private',self_id:Number(bot),user_id:Number(id),message_id:++seq,time:Math.floor(Date.now()/1000),message:[{type:'text',data:{text:'EXEC_CASE:'+name}}]}});
  assert(r.ok); return JSON.stringify(r.captured);
};
async function check(label, fn) {await fn(); report.cases.push({label,passed:true});}
try {
  let ready = false;
  for (let i=0;i<100;i++) {try {await call('health',{},1000); ready=true; break;} catch {if (child.exitCode!==null) throw Error('isolated_gateway_exited'); await new Promise(r=>setTimeout(r,300));}}
  assert(ready,'isolated_gateway_not_ready');
  await check('native exec accepts display title and default-directory query returns actual output without DSH',async()=>{const r=await turn('source');assert(r.includes('DIRECT_SOURCE_SENTINEL.txt'),r);assert(r.includes(source));});
  await check('native exec selects the requested task worktree rather than confusing it with source',async()=>{const r=await turn('worktree');assert(r.includes('DIRECT_WORKTREE_SENTINEL.py'),r);assert(!r.includes('DIRECT_SOURCE_SENTINEL.txt'));});
  await check('host memory query works and payload does not inherit provider environment',async()=>{const r=await turn('host');assert(r.includes('Mem:'),r);assert(r.includes('CREDENTIAL=unset'));assert(!r.includes('not-a-real-secret'));});
  await check('ordinary writes inside the approved directory work',async()=>{await turn('write');assert.equal(fs.readFileSync(path.join(source,'inside.txt'),'utf8'),'inside');});
  await check('actual native execution cannot write an outside file',async()=>{const r=await turn('outside');assert(!fs.existsSync(canary));assert(/denied|permitted/i.test(r),r);});
  for (const [name,code] of [['env','owner_exec_environment_not_allowed'],['elevated','owner_exec_mode_not_allowed'],['cwd','owner_exec_workdir_outside_boundary'],['node','owner_exec_host_not_allowed']]) {
    await check('mandatory gate blocks '+name+' before native launch',async()=>{const r=await turn(name);assert(r.includes(code)||(name==='node'&&r.includes('Validation failed')&&r.includes('host: must be equal')),r);assert(!fs.existsSync(canary));});
  }
  await check('native process timeout terminates the payload before a later write',async()=>{const r=await turn('timeout');assert(!fs.existsSync(path.join(source,'late.txt')));assert(/time|signal|terminated/i.test(r),r);});
  await check('exposed synthetic member native exec still fails owner permission',async()=>{const r=await turn('member',MEMBER);assert(r.includes('capability_not_allowed'),r);assert(!fs.existsSync(path.join(source,'member-ran.txt')));});
  const audit = fs.readFileSync(path.join(root,'channel/access-events.jsonl'),'utf8').trim().split('\n').map(JSON.parse).filter(x=>x.data.tool==='exec');
  await check('audit records final allow/deny and scope without raw command or provider credentials',async()=>{
    assert(audit.some(x=>x.data.decision==='allow'&&x.data.execution?.writeRoot===allowed));
    assert(audit.some(x=>x.data.code==='capability_not_allowed'));
    assert(!JSON.stringify(audit).includes('CREDENTIAL=')&&!JSON.stringify(audit).includes('not-a-real-secret'));
  });
  report.nativeExecAudit = {allowed:audit.filter(x=>x.data.decision==='allow').length,denied:audit.filter(x=>x.data.decision==='deny').length};
  report.passed = true;
} catch (error) {report.passed=false;report.error=error.message;report.diagnosticDirectory=root;process.exitCode=1;}
finally {
  try {process.kill(-child.pid,'SIGTERM');} catch {}
  if (child.exitCode===null&&child.signalCode===null) {let timer;await Promise.race([once(child,'exit'),new Promise(resolve=>timer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}resolve();},8000))]);clearTimeout(timer);}
  for (const client of ws.clients) client.terminate();
  await new Promise(r=>ws.close(r)); await new Promise(r=>onebot.close(r)); await new Promise(r=>model.close(r));
  report.modelRequests=modelRequests;report.finishedAt=new Date().toISOString();report.childStopped=child.exitCode!==null||child.signalCode!==null;
  fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  if (report.passed) fs.rmSync(root,{recursive:true,force:true});
  console.log(JSON.stringify({passed:report.passed,cases:report.cases.length,error:report.error,evidence:out}));
}
