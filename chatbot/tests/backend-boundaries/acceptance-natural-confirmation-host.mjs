// Real isolated Gateway, typed hooks, deferred tools, SQLite, native Cron and loopback OneBot WebSocket/HTTP.
// Default cognition is deterministic. Explicit --model uses the configured official model; still no real QQ/SMTP or production writes.
// Requires a new absolute --out evidence file; failed fixtures stay in /tmp for diagnosis.
import {withHostControl} from '../access-control/host-config.mjs';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {compileAccessConfig} from '../../packages/access-control/config.js';
import {ownerPolicy} from '../access-control/fixtures.mjs';
import {createOneBotPeer, readOneBotLedger, textOfSend, waitForAcceptance, waitForOneBotTurn} from '../acceptance/onebot-peer.mjs';
import {startIsolatedGateway} from '../acceptance/isolated-gateway.mjs';
import assert from 'node:assert/strict';

const progress=process.argv.includes('--progress'),realModel=process.argv.includes('--model');
assert(!(progress&&realModel),'Choose deterministic --progress or explicit --model');
let upstream;
if(realModel){
 const source=JSON.parse(fs.readFileSync(new URL('../../../config/runtime.config.json',import.meta.url)));
 const primary=source.agents.entries.main.model?.primary??source.agents.defaults.model.primary;const [providerId,modelId]=primary.split('/'),provider=source.models.providers[providerId];
 const privateEnv=JSON.parse(fs.readFileSync('/home/afrangry/.openclaw-fusion/runtime-env.json'));
 assert.equal(new URL(provider.baseUrl).hostname,'api.deepseek.com');const key=privateEnv[provider.apiKey?.id];assert(key);
 upstream={modelId,primary,url:provider.baseUrl.replace(/\/$/,'')+'/chat/completions',key};
}
const out=process.argv[process.argv.indexOf('--out')+1];
if(!process.argv.includes('--out')||!path.isAbsolute(out??'')||fs.existsSync(out))throw Error('Require a new absolute --out');
const repo=fileURLToPath(new URL('../../../',import.meta.url)),root=fs.mkdtempSync(path.join(os.tmpdir(),'kurumi-natural-host-'));
const owner='100001',bot='100002',token=randomBytes(24).toString('hex');
const report={at:new Date().toISOString(),boundary:'Isolated OpenClaw, formal QQ ingress/debounce, domain hooks/tools/SQLite and loopback OneBot receipts. No QQ platform, SMTP, production state or restart.',
 cognition:realModel?'configured-provider':'deterministic fixture',ingress:'onebot-websocket',testIngress:false,
 nativeCron:!realModel,cases:[],requests:0};
if(realModel)report.primaryModel=upstream.primary;
const seenModelCalls=new Set();
let active,host,due;
const channelDir=path.join(root,'channel');
const futureDay=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',dateStyle:'short'}).format(Date.now()+2*86400000);
const localTime=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',dateStyle:'short',timeStyle:'short'});
const dbfile=path.join(root,'state/personal-reminders/reminders.sqlite');
function query(sql,...args){const db=new DatabaseSync(dbfile,{readOnly:true});try{return db.prepare(sql).all(...args);}finally{db.close();}}
const rows=()=>query('SELECT proposal_id,payload_hash FROM confirmation_proposals ORDER BY created_at_utc,rowid');
const select=(i=-1)=>{const r=rows().at(i);assert(r);return{domain:'personal_reminder',proposalId:r.proposal_id,payloadHash:r.payload_hash};};
const commit=(i=-1)=>{const r=select(i);return{proposal_id:r.proposalId,payload_hash:r.payloadHash};};
function decode(value){for(let i=0;i<7;i++){if(typeof value==='string'){try{value=JSON.parse(value);continue;}catch{break;}}if(Array.isArray(value)&&value.length===1){value=value[0].text;continue;}if(value?.result){value=value.result;continue;}if(value?.content?.length===1){value=value.content[0].text;continue;}break;}return value;}
const model=http.createServer(async(req,res)=>{
 try{
  assert(active);assert(++report.requests<=150,'request budget');
  let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);
  if(realModel){
   assert(report.requests<=50,'real model request budget');
   for(const m of body.messages??[])for(const c of m.tool_calls??[]){if(seenModelCalls.has(c.id))continue;seenModelCalls.add(c.id);let a;try{a=JSON.parse(c.function.arguments);}catch{a={};}report.modelCalls??=[];report.modelCalls.push({name:c.function.name,action:a.action??a.args?.action??null,domain:a.domain??a.args?.domain??null});}
   const response=await fetch(upstream.url,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+upstream.key},signal:AbortSignal.timeout(60000),body:JSON.stringify({...body,model:upstream.modelId,max_tokens:2000,temperature:0})});
   if(!response.ok)throw Error('Official model HTTP '+response.status);
   res.writeHead(200,{'Content-Type':response.headers.get('content-type')??'application/json'});for await(const chunk of response.body)res.write(chunk);res.end();return;
  }
  // Model fixture transcripts are synthetic, retained only on a failed local fixture.
  fs.appendFileSync(path.join(root,'model-fixture.jsonl'),JSON.stringify(body)+'\n',{mode:0o600});
  const user=body.messages.findLast(m=>m.role==='user'&&!String(m.content??'').startsWith('OpenClaw runtime context:'));
  if(JSON.stringify(user?.content??'').includes('这是已由本人确认且已到时间的一次性提醒')){
   assert(due);
   assert((body.tools??[]).every(t=>['tool_search','tool_describe','dispatch_action'].includes(t.function.name)),
    'Reminder notice exposed a business tool');
   const prompt=JSON.stringify(user.content);
   assert(prompt.includes(due.content));assert(prompt.includes(due.reminderId));
   assert(Date.now()>=due.at,'Reminder composition started before due');
   due.sendOffset=sends.length;
   due.noticeCalls++;
   return complete(res,body,{role:'assistant',content:'到点了，记得看看这条合成提醒。'});
  }
  const all=JSON.stringify(body.messages);assert(all.includes('KURUMI_CONFIRMATION_CURRENT_USER'),'missing trusted current user prompt');
  assert(all.includes('不要求用户抄确认码'),'missing authorized confirmation rules');
  if(active.fragments)assert(all.includes(JSON.stringify(active.fragments.join('\n')).slice(1,-1)),'message fragments did not arrive in one turn');
  const last=body.messages.findLast(m=>m.role==='tool');
  if(active.expected){const result=decode(last?.content);assert.equal(result.ok,active.expected.ok,JSON.stringify(result));if(active.expected.code)assert.equal(result.code,active.expected.code);active.expected=undefined;}
  const step=active.steps[active.next];let tool;
  if(step){if(!active.discovered){tool=['tool_search',{query:step[0],limit:1}];active.discovered=true;}
   else{tool=['dispatch_action',{id:step[0],args:typeof step[1]==='function'?step[1]():step[1]}];active.expected=step[2];active.next++;active.discovered=false;}}
  const message=tool?{role:'assistant',content:progress?'我先核对已有信息，再处理这一步。':null,tool_calls:[{id:'call_'+report.requests,type:'function',function:{name:tool[0],arguments:JSON.stringify(tool[1])}}]}:{role:'assistant',content:'模型自然说明：请核对这些信息，再告诉我是否确认。'};
  complete(res,body,message);
 }catch(error){report.modelError=error.message;console.error('FIXTURE_MODEL_ERROR',error.message);res.writeHead(400);res.end(JSON.stringify({error:{message:'isolated_confirmation_fixture_failed'}}));}
});
function complete(res,body,message){
 const reason=message.tool_calls?'tool_calls':'stop',usage={prompt_tokens:1,completion_tokens:1,total_tokens:2};
 res.setHeader('content-type',body.stream?'text/event-stream':'application/json');
 if(!body.stream){res.end(JSON.stringify({id:'chatcmpl-natural',object:'chat.completion',choices:[{index:0,message,finish_reason:reason}],usage}));return;}
 const base={id:'chatcmpl-natural',object:'chat.completion.chunk',created:1,model:'fixture'};
 const delta=message.tool_calls?{...message,tool_calls:message.tool_calls.map((c,index)=>({...c,index}))}:message;
 res.write('data: '+JSON.stringify({...base,choices:[{index:0,delta,finish_reason:null}]})+'\n\n');
 res.write('data: '+JSON.stringify({...base,choices:[{index:0,delta:{},finish_reason:reason}],usage})+'\n\n');res.end('data: [DONE]\n\n');
}
await new Promise(r=>model.listen(0,'127.0.0.1',r));
const onebot=await createOneBotPeer({token,botId:bot,subjects:[owner],
 reply:({message})=>JSON.stringify(message).includes('未投递测试项')?'reject':undefined});
const {sends}=onebot;
for(const dir of ['workspace','channel','media'])fs.mkdirSync(path.join(root,dir));
fs.writeFileSync(path.join(root,'workspace/AGENTS.md'),realModel?fs.readFileSync(path.join(repo,'scripts/fusion/templates/AGENTS.md'),'utf8'):'Use the registered typed business tools.');
for(const file of ['http-token','ws-token'])fs.writeFileSync(path.join(root,file),token,{mode:0o600});
const ids=['kurumi-qq','personal-reminders','personal-confirmation'];
const tools=['personal_confirmation','personal_reminder_propose','personal_reminder_commit','personal_reminder_state_get'];
const cfg=()=>withHostControl(compileAccessConfig({
 models:{catalogRefresh:{enabled:false},providers:{fixture:{baseUrl:`http://127.0.0.1:${model.address().port}/v1`,apiKey:'synthetic',api:'openai-completions',models:[{id:'fixture',name:'fixture',reasoning:false,input:['text'],contextWindow:64000,maxTokens:1200,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]}}},
 agents:{ownership:'explicit',defaults:{workspace:path.join(root,'workspace'),systemAgent:{agentId:'main'},model:{primary:'fixture/fixture'},heartbeat:{every:'0m'}},entries:{main:{workspace:path.join(root,'workspace'),model:{primary:'fixture/fixture'},tools:{profile:'full',allow:tools,deny:['read','write','edit','exec','process','message','sessions_spawn']}}}},
 channels:{'kurumi-qq':{enabled:true,httpUrl:onebot.httpUrl,wsUrl:onebot.wsUrl,httpTokenFile:path.join(root,'http-token'),wsTokenFile:path.join(root,'ws-token'),stateDir:channelDir,mediaRoot:path.join(root,'media'),testIngress:false,inboundDebounceMs:200,inboundDebounceMaxWaitMs:1000,dailySendLimit:100,segmentDelayMs:0}},
 plugins:{allow:ids,load:{paths:ids.map(id=>path.join(repo,'chatbot/plugins',id))},entries:Object.fromEntries(ids.map(id=>[id,{enabled:true,...(id==='personal-confirmation'?{hooks:{allowConversationAccess:true}}:{}),...(id==='personal-reminders'?{config:{reminderBackend:'native-service',reminderRunnerRoot:path.join(repo,'chatbot/plugins/personal-reminders')}}:{})}])),slots:{memory:'none'}},
 session:{dmScope:'per-channel-peer'},cron:{enabled:!realModel},update:{checkOnStart:false},logging:{file:path.join(root,'runtime.log')},tools:{...(realModel?{codeMode:false}:{}),deny:['exec','process','message','sessions_spawn'],web:{search:{enabled:false},fetch:{enabled:false}}},
},ownerPolicy(owner),repo),repo);
async function exchange(text,{status='completed'}={}){
 const ids=[],start=sends.length;
 for(const fragment of [text].flat())ids.push(await onebot.send(onebot.message(owner,fragment)));
 await waitForOneBotTurn(channelDir,ids,{status,timeoutMs:realModel?180000:20000,check(){
  onebot.check();assert(!report.modelError,report.modelError);
 }});
 const sent=sends.slice(start);
 for(const entry of sent.filter(s=>s.accepted)){
  const receipt=readOneBotLedger(channelDir,db=>db.prepare('SELECT status FROM outbound WHERE message_id=?').get(entry.messageId));
  assert.equal(receipt?.status,'sent','OneBot response was not recorded in the delivery ledger');
 }
 return sent;
}
async function turn(label,text,steps,verify,options){
 active={label,steps,next:0,discovered:false,fragments:Array.isArray(text)?text:undefined};
 const sent=await exchange(text,options);
 assert.equal(active.next,steps.length);assert(!active.expected,'last tool result was not observed');
 await verify?.(sent);report.cases.push({label,passed:true,toolCalls:steps.length,receiptCount:sent.filter(s=>s.accepted).length});console.log(JSON.stringify({case:label,passed:true}));
}
async function actualTurn(label,text,verify){
 active={label};const requests=report.requests,sent=await exchange(text);
 await verify(sent);report.cases.push({label,passed:true,requests:report.requests-requests,receiptCount:sent.filter(s=>s.accepted).length});console.log(JSON.stringify({case:label,passed:true}));}
const count=(table,where='1')=>query('SELECT COUNT(*) n FROM '+table+' WHERE '+where)[0].n;
async function actualCases(){
 await actualTurn('model-single-preview',`请帮我创建一个一次性提醒：${futureDay} 晚上八点，提醒我做合成验收甲。先给预览，不要直接提交。`,sent=>{assert.equal(count('confirmation_proposals'),1);assert.equal(count('approval_grants'),0);assert.equal(count('confirmation_previews','presented_at_utc IS NOT NULL'),1);assert(JSON.stringify(sent).includes('合成验收甲'));});
 await actualTurn('model-question-is-not-assent','你刚才说的确认是指什么？我只是问一下。',()=>{assert.equal(count('approval_grants'),0);assert.equal(count('confirmation_proposals',"status='committed'"),0);});
 await actualTurn('model-next-turn-single-assent','确认。',()=>{assert.equal(count('confirmation_proposals',"status='committed'"),1);assert.equal(count('approval_grants','consumed_at_utc IS NOT NULL'),1);});
 await actualTurn('model-two-previews',`再创建两个一次性提醒：${futureDay} 晚上九点做合成验收乙，晚上十点做合成验收丙。先给这两项的预览。`,sent=>{assert.equal(count('confirmation_proposals'),3);assert.equal(count('confirmation_proposals',"status='committed'"),1);assert(JSON.stringify(sent).includes('合成验收乙'));assert(JSON.stringify(sent).includes('合成验收丙'));});
 await actualTurn('model-ambiguous-assent','确认。',()=>{assert.equal(count('confirmation_proposals',"status='committed'"),1);assert.equal(count('approval_grants'),1);});
 await actualTurn('model-explicit-batch','刚才预览的合成验收乙和合成验收丙，这两项都确认。',()=>{assert.equal(count('confirmation_proposals',"status='committed'"),3);assert.equal(count('approval_grants','consumed_at_utc IS NOT NULL'),3);});
 await actualTurn('model-change-baseline',`创建一次性提醒：${futureDay} 晚上七点做合成验收丁，先给预览。`,()=>{assert.equal(count('confirmation_proposals'),4);assert.equal(count('confirmation_proposals',"status='committed'"),3);});
 await actualTurn('model-change-needs-new-preview','确认，不过把合成验收丁改到晚上七点半。',()=>{assert.equal(count('confirmation_proposals',"status='committed'"),3);assert.equal(count('approval_grants'),3);assert(count('confirmation_proposals')>=5);});
 await actualTurn('model-negative-is-not-assent','先别执行，我还没有确认。',()=>{assert.equal(count('confirmation_proposals',"status='committed'"),3);assert.equal(count('approval_grants'),3);});
}
const propose=(content,at=futureDay+'T20:00')=>['personal_reminder_propose',{schema_version:1,request:{kind:'reminder.create',content,schedule:{timezone:'Asia/Shanghai',local_date_time:at}}},{ok:true}];
const confirmation=(expected={ok:true},i=-1)=>['personal_confirmation',()=>({action:'confirm',...select(i)}),expected];

async function scheduleDueReminder(){
 const beforeReminders=count('reminders'),beforeGrants=count('approval_grants');
 const jobIds=async()=>(await host.call('cron.list',{includeDisabled:true})).jobs.map(job=>job.id).sort();
 const beforeJobs=await jobIds();
 // The domain enforces a full minute of lead time and minute-granular input.
 const at=Math.ceil((Date.now()+75000)/60000)*60000,content='合成验收：检查准时提醒';
 due={at,content,noticeCalls:0};
 const time=localTime.format(at);
 await turn('due-reminder-preview-does-not-schedule',`请在 ${time} 提醒我：${content}。先给预览。`,[propose(content,time.replace(' ','T'))],async sent=>{
  assert(sent.some(s=>s.accepted&&textOfSend(s).includes(content)));
  assert.equal(count('reminders'),beforeReminders);assert.equal(count('approval_grants'),beforeGrants);
  assert.deepEqual(await jobIds(),beforeJobs);
 });
 await turn('due-reminder-next-turn-registers-one-native-job','确认。',[
  ['personal_confirmation',{action:'list',domain:'personal_reminder'},{ok:true}],confirmation(),['personal_reminder_commit',()=>commit(),{ok:true}],
 ],async()=>{
  assert.equal(count('reminders'),beforeReminders+1);
  const reminders=query('SELECT reminder_id,cron_job_id,status,scheduled_at_utc FROM reminders WHERE content=?',content);
  assert.equal(reminders.length,1);
  const [row]=reminders;assert.equal(row.status,'scheduled');assert.equal(row.scheduled_at_utc*1000,at);
  assert.equal(count('approval_grants','consumed_at_utc IS NOT NULL'),beforeGrants+1);
  const jobs=(await host.call('cron.list',{includeDisabled:true})).jobs;
  assert.deepEqual(jobs.map(job=>job.id).sort(),[...beforeJobs,row.cron_job_id].sort());
  const job=jobs.find(job=>job.id===row.cron_job_id);
  assert.equal(job.delivery.to,'user:'+owner);assert.equal(job.delivery.channel,'kurumi-qq');
  assert.equal(Date.parse(job.schedule.at),at);
  Object.assign(due,{reminderId:row.reminder_id,jobId:row.cron_job_id});
 });
}

async function verifyDueReminder(){
 const history=()=>host.call('cron.runs',{id:due.jobId,limit:5},5000);
 const check=()=>{onebot.check();assert(!report.modelError,report.modelError);};
 const run=await waitForAcceptance(async()=>{check();return (await history()).entries[0];},'due reminder Cron run',{
  timeoutMs:Math.max(0,due.at-Date.now())+25000,pollMs:500,
 });
 assert.equal(run.status,'ok');assert.equal(run.delivered,true);assert.equal(run.deliveryStatus,'delivered');
 assert(run.runAtMs>=due.at,'Native Cron ran before the approved time');
 const notices=sends.slice(due.sendOffset),text=notices.map(textOfSend).join('\n');
 assert.equal(notices.filter(s=>textOfSend(s).includes('到点了，记得看看这条合成提醒。')).length,1,
  'Exactly one native reminder opening must reach OneBot');
 assert(text.includes(due.content));assert(text.includes(localTime.format(due.at)));
 const deliveryKeys=new Set();
 for(const notice of notices){
  assert(notice.accepted);assert.equal(String(notice.user_id),owner);
  const receipt=readOneBotLedger(channelDir,db=>db.prepare('SELECT id,status FROM outbound WHERE message_id=?').get(notice.messageId));
  assert.equal(receipt?.status,'sent');deliveryKeys.add(receipt.id.replace(/:\d+$/u,''));
 }
 assert.equal(deliveryKeys.size,1,'Notice segments must belong to one logical delivery');
 assert.equal(due.noticeCalls,1);
 await turn('deliver-and-reconcile-due-reminder','查一下现在还有哪些未到点的一次性提醒。',[
  ['personal_reminder_state_get',{},{ok:true}],
 ],async()=>{
  const [row]=query('SELECT status,delivered_at_utc FROM reminders WHERE reminder_id=?',due.reminderId);
  assert.equal(row.status,'delivered');assert(row.delivered_at_utc*1000>=due.at);
  assert.equal((await history()).entries.length,1);
  assert(!(await host.call('cron.list',{includeDisabled:true})).jobs.some(job=>job.id===due.jobId));
 });
 report.dueReminder={cronRuns:1,noticeCalls:due.noticeCalls,oneBotReceipts:notices.map(s=>s.messageId),scheduledAt:new Date(due.at).toISOString(),
  runAt:new Date(run.runAtMs).toISOString(),finalState:'delivered',cronRemovedAfterRun:true};
}
try{
 host=await startIsolatedGateway({repo,root,token,configure:cfg});
 await host.ready();
 await waitForAcceptance(onebot.connected,'OneBot socket');
 await assert.rejects(host.call('kurumi-qq.testInbound',{},3000),/unknown method|not found/iu);
 if(realModel){await actualCases();report.passed=true;}else{
 await turn('same-message-cannot-confirm','生成一个测试提醒并直接确认',[propose('宿主测试甲'),confirmation({ok:false,code:'proposal_not_presented'})],sent=>{
  assert(sent.length>0);assert(JSON.stringify(sent).includes('模型自然说明'));assert(query('SELECT presented_at_utc FROM confirmation_previews')[0].presented_at_utc);assert.equal(query('SELECT * FROM approval_grants').length,0);
 });
 await turn('next-message-bare-confirm-commits','确认',[
  ['personal_confirmation',{action:'list',domain:'personal_reminder'},{ok:true}],confirmation(),['personal_reminder_commit',()=>commit(),{ok:true}],
 ],()=>{assert.equal(query("SELECT * FROM confirmation_proposals WHERE status='committed'").length,1);assert.equal(query('SELECT * FROM approval_grants WHERE consumed_at_utc IS NOT NULL').length,1);});
 await turn('two-previews-in-one-batch',['再生成测试提醒乙。','还有测试提醒丙。'],[propose('宿主测试乙'),propose('宿主测试丙')],sent=>{assert(JSON.stringify(sent).includes('宿主测试乙'));assert(JSON.stringify(sent).includes('宿主测试丙'));});
 await turn('ambiguous-bare-confirm-rejected','确认',[confirmation({ok:false,code:'confirmation_target_ambiguous'})]);
 await turn('Q09-original-reference-confirms-only-second','只确认刚才两项中的第二项，第一项先不要动。',[confirmation(),['personal_reminder_commit',()=>commit(),{ok:true}]],()=>{assert.equal(query("SELECT * FROM confirmation_proposals WHERE status='committed'").length,2);});
 await turn('negative-does-not-authorize','先别执行，我不确认',[confirmation({ok:false,code:'confirmation_not_explicit'},1)]);
 await turn('change-needs-new-preview','确认，不过改成九点',[confirmation({ok:false,code:'confirmation_not_explicit'},1)]);
 await turn('Q10-two-more-previews','再生成两个测试提醒',[propose('宿主Q10甲'),propose('宿主Q10乙')]);
 const batchTargets=[select(-2),select(-1)];
 await turn('Q10-one-message-two-commits','这两个都确认。',[
  ['personal_confirmation',()=>({action:'confirm',domain:'personal_reminder',targets:batchTargets}),{ok:true}],
  ['personal_reminder_commit',()=>commit(-2),{ok:true}],['personal_reminder_commit',()=>commit(-1),{ok:true}],
 ],()=>{
  const grants=query('SELECT confirmation_message_id FROM approval_grants WHERE proposal_id IN (?,?)',...batchTargets.map(p=>p.proposalId));
  assert.equal(grants.length,2);assert.equal(new Set(grants.map(g=>g.confirmation_message_id)).size,1);
  assert.equal(query("SELECT * FROM confirmation_proposals WHERE status='committed'").length,4);
 });
 await turn('Q13-newer-preview','生成一个比宿主测试乙更新的提醒',[propose('宿主Q13新项')]);
 await turn('Q13-list-and-repreview-older','重新展示宿主测试乙的预览',[
  ['personal_confirmation',{action:'list',domain:'personal_reminder'},{ok:true}],
  ['personal_confirmation',()=>({action:'preview',...select(1)}),{ok:true}],
 ],sent=>{assert(JSON.stringify(sent).includes('宿主测试乙'));assert(JSON.stringify(sent).includes('模型自然说明'));});
 await turn('Q13-bare-assent-selects-represented-older','确认',[
  confirmation({ok:true},1),['personal_reminder_commit',()=>commit(1),{ok:true}],
 ],()=>{assert.equal(query('SELECT status FROM confirmation_proposals WHERE proposal_id=?',select(1).proposalId)[0].status,'committed');
  assert.equal(query('SELECT status FROM confirmation_proposals WHERE proposal_id=?',select(-1).proposalId)[0].status,'pending');});
 await turn('rejected-preview-never-records-receipt','预览这条专门模拟拒绝投递的提醒',[propose('未投递测试项')],sent=>{
  assert(sent.some(s=>!s.accepted));
  const [preview]=query('SELECT presented_at_utc FROM confirmation_previews WHERE proposal_id=?',select().proposalId);
  assert.equal(preview.presented_at_utc,null);
 },{status:'failed'});
 await turn('next-message-cannot-confirm-rejected-preview','确认',[confirmation({ok:false,code:'proposal_not_presented'})]);
 assert.equal(query('SELECT * FROM approval_grants').length,5);report.progressRequested=progress;report.progressObserved=sends.some(s=>JSON.stringify(s).includes('我先核对已有信息'));if(progress)assert(report.progressObserved,'Explicit assistant progress must be visible');
 // Earlier checks' jobs are far in the future. This reminder must execute
 // and be removed by native Cron before the temporary instance is cleaned up.
 await scheduleDueReminder();
 await verifyDueReminder();
 report.passed=true;
 }
}catch(error){report.passed=false;report.error=error.message;report.diagnosticsRoot=root;process.exitCode=1;}
finally{
 report.gracefulStop=await host?.close()??null;
 model.closeAllConnections();await Promise.all([onebot.close(),new Promise(r=>model.close(r))]);
 if(report.gracefulStop===false){report.passed=false;report.error??='Isolated Gateway did not stop gracefully';report.diagnosticsRoot=root;process.exitCode=1;}
 report.configSha256=host?.configSha256;
 if(report.passed){fs.rmSync(root,{recursive:true,force:true});report.fixtureRemoved=!fs.existsSync(root);}
 report.finishedAt=new Date().toISOString();fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
 console.log(JSON.stringify({passed:report.passed,cases:report.cases.length,requests:report.requests,error:report.error,evidence:out}));
}
