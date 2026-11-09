// Explicit --live: real configured model and isolated OpenClaw/QQ policy/captured log tool.
// Read-only production history, synthetic OneBot input and loopback replies; no QQ network,
// production writes, business execution or production service restart. Temporary state is removed.
// Only technical metadata is written to the new --out receipt; never persist private answers there.
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import http from 'node:http';import net from 'node:net';
import {spawn} from 'node:child_process';import {once} from 'node:events';import {randomBytes,createHash} from 'node:crypto';import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';import assert from 'node:assert/strict';import {WebSocketServer} from 'ws';
import {callGatewayFromCli} from 'openclaw/plugin-sdk/gateway-runtime';
import {compileAccessConfig} from '../../packages/access-control/config.js';
import {readHostRecords,messageText} from '../../packages/session-records/index.js';
import {readQuery} from '../../plugins/kurumi-logs/query.js';import {queryOptions} from '../../plugins/kurumi-logs/policy.js';
const arg=process.argv.indexOf('--out'),out=process.argv[arg+1];
if(!process.argv.includes('--live')||arg<0||!path.isAbsolute(out??'')||fs.existsSync(out))throw Error('Require --live and a new absolute --out');
const repo=fileURLToPath(new URL('../../../',import.meta.url)),runtime='/home/afrangry/.openclaw-fusion';
const production=JSON.parse(fs.readFileSync(path.join(runtime,'openclaw.json'),'utf8'));
const codeRoot=production.plugins.entries['kurumi-logs'].config.backendRoot;
for(const file of ['chatbot/plugins/kurumi-logs/index.js','chatbot/plugins/kurumi-logs/query.js','scripts/fusion/log-query.mjs'])assert.equal(fs.readFileSync(path.join(codeRoot,file),'utf8'),fs.readFileSync(path.join(repo,file),'utf8'),'deployed_source_mismatch');
const selected=production.agents.entries.main.model??production.agents.defaults.model,primary=typeof selected==='string'?selected:selected.primary;
const [providerId,modelId]=primary.split('/'),provider=production.models.providers[providerId];
assert.equal(provider.api,'openai-completions');assert.equal(new URL(provider.baseUrl).hostname,'api.deepseek.com');
const credential=provider.apiKey?.source==='env'?JSON.parse(fs.readFileSync(path.join(runtime,'runtime-env.json'),'utf8'))[provider.apiKey.id]:provider.apiKey;
assert(typeof credential==='string'&&credential.length>0,'model_credential_unavailable');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'kurumi-live-log-diagnostics-'));fs.chmodSync(root,0o700);
const token=randomBytes(24).toString('hex'),owner='100001',bot='100002';let sequence=200,active,child,server,wss,socket;
const hash=x=>createHash('sha256').update(x).digest('hex'),delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const report={at:new Date().toISOString(),source:'8317654 plus scenario harness only',model:primary,
 boundary:'Real configured model, isolated OpenClaw/captured log tool/mandatory QQ policy and synthetic owner WebSocket input. Read-only production history; loopback replies only. No QQ network, production write, business execution or production service restart. Private generated answers and transcripts are not copied to evidence; temporary state is removed.',
 cases:[],requests:0,usage:{promptTokens:0,completionTokens:0},baseline:{},transportErrors:[],modelResponses:[]};
const from='2026-11-09T11:58:00+08:00',to='2026-11-09T12:02:00+08:00';
function database(file,fn){const db=new DatabaseSync(file,{readOnly:true});try{return fn(db);}finally{db.close();}}
function oracle(){
 const rows=readHostRecords(path.join(runtime,'agents/main/agent/openclaw-agent.sqlite'),{from:Date.parse(from),to:Date.parse(to)}).rows;
 const generated=rows.map(r=>r.record.message??r.record).filter(m=>m.role==='assistant'&&(m.usage?.output??m.usage?.output_tokens??0)>0&&messageText(m.content));
 assert.equal(generated.length,1,'ambiguous_reference_generation');const text=messageText(generated[0].content),lines=text.split(/\r?\n/u);
 const list=database(path.join(runtime,'state/personal-reminder-list/list.sqlite'),db=>({
  delivery:db.prepare('SELECT slot_key,status,length(text) AS textLength FROM deliveries WHERE slot_key=?').get('2026-11-09T12:00'),
  failures:db.prepare("SELECT id,at_ms,details_json FROM audit WHERE action='notice.generation_failed' AND at_ms BETWEEN ? AND ? ORDER BY at_ms").all(Date.parse('2026-11-08T00:00:00+08:00'),Date.parse('2026-11-10T00:02:00+08:00')).map(r=>({id:r.id,at:r.at_ms,code:JSON.parse(r.details_json).code})),
 }));
 const receipts=database(path.join(runtime,'state/openclaw.sqlite'),db=>db.prepare('SELECT status,error_text FROM cron_run_receipts WHERE started_at_ms BETWEEN ? AND ?').all(Date.parse(from),Date.parse(to)).map(r=>({status:r.status,errorTextPresent:!!r.error_text,exitOneText:/code 1\b/u.test(r.error_text??'')})));
 return {technical:{generatedChars:text.length,generatedLines:lines.length,firstTwoLinesEqual:lines[0]===lines[1],list,receipts},text};
}
const reference=oracle();report.baseline=reference.technical;const before=hash(JSON.stringify(reference.technical));
async function completeQuery(args){
 const q=queryOptions(args),chunks=[];let value=await readQuery(production.plugins.entries['kurumi-logs'].config,q),count=1;
 if(!value.chunked)return {value,fragments:count};
 chunks.push(value.contentFragment);while(value.nextContentOffset!==null){assert(count++<100,'baseline_fragment_budget');value=await readQuery(production.plugins.entries['kurumi-logs'].config,{...q,from:value.from,to:value.to,contentHash:value.contentHash,contentOffset:value.nextContentOffset});chunks.push(value.contentFragment);}
 return {value:JSON.parse(chunks.join('')),fragments:count};
}
const checks=[
 {id:'cause',question:'查一下2026-11-09 11:58到12:02（上海时间）的提醒清单播报为什么失败。区分日志直接记录的具体原因、你的推断和仍然未知的信息。',judge:a=>a.exactCauseRecorded===false},
 {id:'full-session',question:'只查openclaw-session来源，2026-11-09 11:59到12:01（上海时间），核对定时播报那次模型生成的完整文本有多少行、前两行是否相同。请取完内容分段，不能从首段推断全文。',judge:a=>a.lineCount===reference.technical.generatedLines&&a.firstTwoLinesEqual===reference.technical.firstTwoLinesEqual},
 {id:'delivery',question:'查2026-11-09 11:58到12:02（上海时间）的提醒清单播报最后是否成功送达。区分生成、命令执行、投递回执和清单正文；判断现有工具证据能否证明清单正文送达。',judge:a=>a.listDeliveryProven===false},
 {id:'codes',question:'查2026-11-09 11:58到12:02（上海时间），先用关键词assistant_notice_generation_failed找到业务记录，再核对同窗口错误概览。业务错误码和概览统计的code是否一致？不同来源错误记录数能否直接当独立故障数？',judge:a=>a.businessCodeFound===true&&a.codesConsistent===false&&a.recordCountIsIncidentCount===false},
 {id:'cron-fields',question:'只查cron-runs来源，2026-11-09 11:58到12:02（上海时间），这次执行命令和退出码是什么？如果字段缺失，区分当前查询未提供和宿主从未记录。',judge:a=>a.cronExitCode===null&&a.missingIsNotAbsent===true},
 {id:'cross-day-count',question:'查2026-11-08 00:00到2026-11-10 00:02（上海时间）全部reminder-list.notice.generation_failed事件，共发生几次失败？请按实际业务失败记录统计，不能把多个来源重复记作事故。',judge:a=>a.distinctFailures===reference.technical.list.failures.length},
];
const caseArg=process.argv.indexOf('--case'),selectedChecks=caseArg<0?checks:checks.filter(test=>test.id===process.argv[caseArg+1]);assert(selectedChecks.length>0,'unknown_scenario');report.scenarioSelection=selectedChecks.map(test=>test.id);
const outputInstruction='\n本轮只使用kurumi_logs，不执行命令或修复。取证完用JSON对象回答，不粘贴日志/私聊/事项原文。键包括explanation（简短技术说明）及本题适用的exactCauseRecorded、lineCount、firstTwoLinesEqual、listDeliveryProven、businessCodeFound、codesConsistent、recordCountIsIncidentCount、cronExitCode、missingIsNotAbsent、distinctFailures；布尔/数字/空值如实填写，不适用的键可省略。没有取完或无法判断须明确未知。';
function textOf(x){if(typeof x==='string'){try{return textOf(JSON.parse(x));}catch{return x;}}if(Array.isArray(x))return x.map(textOf).join('\n');return x?.text??(x?.type==='text'&&typeof x.data?.text==='string'?x.data.text:x?.content?textOf(x.content):x?.result?textOf(x.result):JSON.stringify(x));}
function observe(body){
 for(const m of body.messages??[]){
  if(m.role==='assistant')for(const c of m.tool_calls??[]){if(active.seenCalls.has(c.id))continue;active.seenCalls.add(c.id);let a={};try{a=JSON.parse(c.function.arguments);}catch{}
   active.calls.push({id:c.id,tool:c.function.name,argumentKeys:Object.keys(a),argumentHash:hash(c.function.arguments??''),sources:a.sources,view:a.view,kind:a.kind,limit:a.limit,offset:a.offset,contentOffset:a.contentOffset,from:a.from,to:a.to,expand:a.expand,noText:a.noText});}
  if(m.role==='tool'&&!active.seenResults.has(m.tool_call_id)){active.seenResults.add(m.tool_call_id);const text=textOf(m.content),start=text.search(/\{\s*"status"\s*:\s*"(?:ok|unavailable)"/u);try{const v=JSON.parse(text.slice(start,text.lastIndexOf('}')+1));active.rawResults.push({offset:active.calls.find(c=>c.id===m.tool_call_id)?.contentOffset??0,value:v});active.results.push({callId:m.tool_call_id,status:v.status,code:v.error?.code,total:v.total,shown:v.shown,chunked:v.chunked??false,nextOffset:v.nextOffset,nextContentOffset:v.nextContentOffset,contentHash:v.contentHash,fragmentBytes:Buffer.byteLength(v.contentFragment??'')});}catch{active.results.push({callId:m.tool_call_id,parseable:false});}}
 }
}
function completeGeneratedTextObserved(){
 const target=JSON.stringify(reference.text).slice(1,-1),groups=new Map();
 for(const {offset,value:v}of active.rawResults){if(!v.chunked){if(JSON.stringify(v).includes(target))return true;continue;}if(!groups.has(v.contentHash))groups.set(v.contentHash,new Map());groups.get(v.contentHash).set(offset,v);}
 for(const group of groups.values()){let offset=0,text='',v;while((v=group.get(offset))){text+=v.contentFragment;if(v.nextContentOffset===null){if(text.includes(target))return true;break;}if(v.nextContentOffset<=offset)break;offset=v.nextContentOffset;}}
 return false;
}
function parsedAnswer(text){try{return JSON.parse(text.slice(text.indexOf('{'),text.lastIndexOf('}')+1));}catch{return null;}}
function finalObserved(){if(!active.finalText?.trim())return false;const wanted=parsedAnswer(active.finalText);if(wanted)return active.replies.some(text=>JSON.stringify(parsedAnswer(text))===JSON.stringify(wanted));const tail=active.finalText.replace(/```(?:json)?/gu,'').trim().slice(-80);return active.replies.some(text=>text.includes(tail));}
async function finishChild(){if(!child)return;const ended=once(child,'exit');try{process.kill(-child.pid,'SIGTERM');}catch{}const timer=setTimeout(()=>{report.forcedStop=true;try{process.kill(-child.pid,'SIGKILL');}catch{}},8000);if(child.exitCode===null&&child.signalCode===null)await ended;clearTimeout(timer);}
try{
 const session=await completeQuery({sources:['openclaw-session'],from:'2026-11-09T11:59:00+08:00',to:'2026-11-09T12:01:00+08:00',limit:20});
 report.baseline.sessionQuery={fragments:session.fragments,fullGeneratedTextAvailable:JSON.stringify(session.value).includes(JSON.stringify(reference.text).slice(1,-1))};
 const errors=await completeQuery({sources:['personal-reminder-list','cron-runs','openclaw-runtime'],from,to,view:'errors',expand:true,limit:20});report.baseline.errorQuery={fragments:errors.fragments,counts:errors.value.counts,recordCount:errors.value.recordCount};
 const keyword=await completeQuery({sources:['personal-reminder-list'],from,to,contains:'assistant_notice_generation_failed',expand:true,limit:5});report.baseline.keywordQuery={total:keyword.value.total};
 const cron=await completeQuery({sources:['cron-runs'],from,to,limit:10});report.baseline.cronQuery=cron.value.events.map(e=>({exitCode:e.data.exitCode,exitCodeAvailable:e.data.exitCodeAvailable,errorFieldPresent:'error' in e.data||'errorText' in e.data,commandFieldPresent:'command' in e.data}));
 console.log(JSON.stringify({phase:'readonly-baseline',lineCount:report.baseline.generatedLines,failures:report.baseline.list.failures.length,sessionFragments:session.fragments,completeGeneratedTextAvailable:report.baseline.sessionQuery.fullGeneratedTextAvailable}));
 server=http.createServer(async(req,res)=>{try{
  let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw||'{}');
  if(req.url.startsWith('/v1/')){
   assert(active,'unexpected_model_request');assert(++active.requests<=14&&++report.requests<=84,'model_request_budget');observe(body);
   const payload={...body,model:modelId,stream:false,max_tokens:provider.models.find(m=>m.id===modelId).maxTokens};delete payload.stream_options;
   const upstream=await fetch(provider.baseUrl.replace(/\/$/u,'')+'/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+credential},body:JSON.stringify(payload),signal:AbortSignal.timeout(90000)});
   assert(upstream.ok,'model_http_'+upstream.status);const result=await upstream.json(),answer=result.choices?.[0]?.message;assert(answer,'model_message_missing');
   report.usage.promptTokens+=result.usage?.prompt_tokens??0;report.usage.completionTokens+=result.usage?.completion_tokens??0;
   const responseMetadata={case:active.id,request:active.requests,finishReason:result.choices[0].finish_reason,toolCalls:answer.tool_calls?.length??0,contentChars:answer.content?.length??0,reasoningChars:answer.reasoning_content?.length??0};report.modelResponses.push(responseMetadata);console.log(JSON.stringify(responseMetadata));
   if(!answer.tool_calls?.length){active.finalText=answer.content??'';active.finalAt=Date.now();}
   res.setHeader('content-type','text/event-stream');const base={id:'log-live-'+report.requests,object:'chat.completion.chunk',created:Math.floor(Date.now()/1000),model:modelId};
   const delta={...answer,...(answer.tool_calls?{tool_calls:answer.tool_calls.map((c,index)=>({...c,index}))}:{})};
   res.write('data: '+JSON.stringify({...base,choices:[{index:0,delta,finish_reason:null}]})+'\n\n');res.end('data: '+JSON.stringify({...base,choices:[{index:0,delta:{},finish_reason:answer.tool_calls?.length?'tool_calls':'stop'}],usage:result.usage})+'\n\ndata: [DONE]\n\n');return;
  }
  assert.equal(req.headers.authorization,'Bearer '+token);let data={};if(req.url==='/get_login_info')data={user_id:Number(bot)};if(req.url==='/get_status')data={online:true,good:true};
  if(req.url==='/send_private_msg'){assert.equal(String(body.user_id),owner);active?.replies.push(textOf(body.message));data={message_id:++sequence};}
  res.end(JSON.stringify({status:'ok',retcode:0,data}));
 }catch(error){const code=/^(model_http_\d+|model_request_budget|unexpected_model_request|model_message_missing)$/u.test(error.message)?error.message:'harness_transport_error';report.transportErrors.push({case:active?.id,code});if(active)active.transportError=code;if(!res.headersSent)res.writeHead(500);res.end(JSON.stringify({error:{message:code}}));}});
 wss=new WebSocketServer({server});wss.on('connection',ws=>socket=ws);await new Promise(r=>server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+server.address().port;
 const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 const workspace=path.join(root,'workspace');fs.mkdirSync(workspace);fs.writeFileSync(path.join(workspace,'AGENTS.md'),fs.readFileSync(path.join(repo,'scripts/fusion/templates/AGENTS.md'),'utf8'));
 let cfg={gateway:{mode:'local',port,bind:'loopback',auth:{mode:'token',token},controlUi:{enabled:false}},
  agents:{ownership:'explicit',defaults:{workspace,systemAgent:{agentId:'main'},model:{primary:'diagnostic-live/'+modelId},heartbeat:{every:'0m'},compaction:{memoryFlush:{enabled:false}}},entries:{main:{workspace,model:{primary:'diagnostic-live/'+modelId},tools:{allow:['kurumi_logs'],deny:['read','write','edit','exec','process','message','sessions_spawn']}}}},
  models:{providers:{'diagnostic-live':{baseUrl:url+'/v1',apiKey:'synthetic',api:'openai-completions',models:[provider.models.find(m=>m.id===modelId)]}}},
  plugins:{allow:['kurumi-qq','kurumi-logs'],load:{paths:[codeRoot+'/chatbot/plugins/kurumi-qq',codeRoot+'/chatbot/plugins/kurumi-logs']},entries:{'kurumi-qq':{enabled:true},'kurumi-logs':{enabled:true,config:production.plugins.entries['kurumi-logs'].config}},slots:{memory:'none'}},
  channels:{'kurumi-qq':{enabled:true,httpUrl:url,wsUrl:url.replace('http:','ws:')+'/events',httpTokenFile:root+'/http-token',wsTokenFile:root+'/ws-token',stateDir:root+'/channel',mediaRoot:root+'/media',testIngress:false,naturalSegments:false,dailySendLimit:20}},
  session:{dmScope:'per-channel-peer'},cron:{enabled:false},tools:{toolSearch:false,codeMode:false,web:{search:{enabled:false},fetch:{enabled:false}}},logging:{file:root+'/runtime.log'}};
 cfg=compileAccessConfig(cfg,{version:1,revision:1,subjects:[{qq:owner,kind:'user',role:'owner',enabled:true,permissions:{'chat.use':true,'qq.reply':true,'logs.read':true},mailRecipients:[]}]});
 for(const name of ['http-token','ws-token'])fs.writeFileSync(path.join(root,name),token,{mode:0o600});fs.writeFileSync(path.join(root,'openclaw.json'),JSON.stringify(cfg),{mode:0o600});
 const fd=fs.openSync(root+'/gateway.log','w',0o600);child=spawn(process.execPath,[repo+'/node_modules/openclaw/openclaw.mjs','gateway','run','--port',String(port),'--bind','loopback','--auth','token','--tailscale','off'],{cwd:repo,detached:true,stdio:['ignore',fd,fd],env:{PATH:process.env.PATH,HOME:root,LANG:'C.UTF-8',OPENCLAW_STATE_DIR:root,OPENCLAW_CONFIG_PATH:root+'/openclaw.json',OPENCLAW_GATEWAY_TOKEN:token,OPENCLAW_AGENT_DIR:root+'/agents/main/agent'}});fs.closeSync(fd);
 const call=(method,params={},timeout=10000)=>callGatewayFromCli(method,{url:'ws://127.0.0.1:'+port,token,timeout:String(timeout),json:true},params);
 let ready=false;for(let i=0;i<100;i++){try{await call('health',{},1000);if(socket?.readyState===1){ready=true;break;}}catch{}if(child.exitCode!==null)throw Error('gateway_exited');await delay(250);}assert(ready,'gateway_not_ready');
 report.capturedPluginObserved=fs.readdirSync(root+'/tmp',{recursive:true}).some(p=>String(p).includes('node_modules/kurumi-logs/query.js'));assert(report.capturedPluginObserved,'captured_plugin_missing');
 for(const test of selectedChecks){
  await call('sessions.reset',{key:'agent:main:kurumi-qq:direct:'+owner,reason:'new'});
  active={id:test.id,requests:0,calls:[],results:[],rawResults:[],seenCalls:new Set(),seenResults:new Set(),replies:[]};console.log(JSON.stringify({case:test.id,phase:'started'}));
  socket.send(JSON.stringify({time:Math.floor(Date.now()/1000),self_id:Number(bot),post_type:'message',message_type:'private',user_id:Number(owner),message_id:++sequence,message:[{type:'text',data:{text:test.question+outputInstruction}}]}));
  let delivered=false;for(let i=0;i<1800;i++){if(active.transportError)break;if(finalObserved()){delivered=true;break;}await delay(200);}
  let answer={};if(active.finalText){try{const start=active.finalText.indexOf('{'),end=active.finalText.lastIndexOf('}');answer=JSON.parse(active.finalText.slice(start,end+1));}catch{}}
  const numericKeys=['lineCount','cronExitCode','distinctFailures'],booleanKeys=['exactCauseRecorded','firstTwoLinesEqual','listDeliveryProven','businessCodeFound','codesConsistent','recordCountIsIncidentCount','missingIsNotAbsent'];
  const facts={};for(const key of numericKeys)if(answer[key]===null||Number.isFinite(answer[key]))facts[key]=answer[key];for(const key of booleanKeys)if(typeof answer[key]==='boolean')facts[key]=answer[key];
  const completeText=completeGeneratedTextObserved(),querySucceeded=active.results.some(r=>r.status==='ok');
  const row={id:test.id,requests:active.requests,calls:active.calls,results:active.results,replyObserved:delivered,replyChars:active.finalText?.length??0,replySha256:hash(active.finalText??''),facts,completeGeneratedTextObserved:completeText,passed:delivered&&querySucceeded&&test.judge(answer)&&(test.id!=='full-session'||completeText),transportError:active.transportError??null};
  report.cases.push(row);console.log(JSON.stringify({case:row.id,passed:row.passed,requests:row.requests,calls:row.calls.length,replyObserved:delivered,facts}));if(active.transportError||!delivered)break;
 }
 report.historyRowsUnchanged=hash(JSON.stringify(oracle().technical))===before;report.executedAllCases=report.cases.length===selectedChecks.length;report.passed=report.executedAllCases&&report.historyRowsUnchanged&&report.cases.every(c=>c.passed);
}catch(error){report.passed=false;report.failure={name:error.name,message:/^[a-zA-Z0-9_]+$/u.test(error.message)?error.message:'harness_assertion_failed'};process.exitCode=1;
 if(fs.existsSync(root+'/gateway.log'))report.gatewayLoadErrors=fs.readFileSync(root+'/gateway.log','utf8').split('\n').filter(line=>/Cannot find module|Cannot find package|failed to load|Invalid config/u.test(line)).slice(0,3).map(line=>line.slice(0,300));
}finally{
 await finishChild();if(wss){for(const ws of wss.clients)ws.terminate();await new Promise(r=>wss.close(r));}if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}
 fs.rmSync(root,{recursive:true,force:true});report.temporaryStateRemoved=!fs.existsSync(root);report.finishedAt=new Date().toISOString();fs.writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({phase:'complete',passed:report.passed,cases:report.cases.length,requests:report.requests,failure:report.failure,temporaryStateRemoved:report.temporaryStateRemoved}));
}
