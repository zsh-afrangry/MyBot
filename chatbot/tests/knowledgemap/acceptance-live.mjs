#!/usr/bin/env node
// 对应文档：docs/23_KnowledgeMap业务能力桥接.md「测试计划」。
// Real model/production API/MySQL/browser + one owner QQ digest. Explicit --live --qq required.
// Briefly enables synthetic owner ingress, restarts Fusion and restores the disabled ingress.
// Deletes only exact marked test business rows via website API; keeps request/delivery receipts.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {join,resolve} from 'node:path';
import {tmpdir,homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {rpc,ready} from '../../../scripts/fusion/rpc.mjs';
import {KnowledgeMapClient} from '../../packages/knowledgemap-client/client.js';
import {account} from '../../plugins/kurumi-qq/src/config.js';
import {onebot} from '../../plugins/kurumi-qq/src/transport.js';
import {ListControlStore,runRemoteDigest} from '../../plugins/personal-reminder-list/remote.js';
import {localTime} from '../../plugins/personal-reminder-list/time.js';
import {buildJob} from '../../plugins/personal-reminder-list/scheduler.js';

assert.ok(process.argv.includes('--live')&&process.argv.includes('--qq'),'--live --qq acknowledges production writes/model/restarts and owner-only QQ delivery');
const repo=resolve(fileURLToPath(new URL('../../../',import.meta.url))),state='/home/afrangry/.openclaw-fusion';
const configFile=join(repo,'config/runtime.config.json'),original=fs.readFileSync(configFile,'utf8'),cfg=JSON.parse(original);
const owner=cfg.channels['kurumi-qq'].ownerId;assert.equal(owner,'365999865');assert.equal(cfg.channels['kurumi-qq'].testIngress,false);
const bridge=cfg.plugins.entries['kurumi-knowledgemap'].config,client=new KnowledgeMapClient({...bridge,trace(){}});
const marker='[doc23-'+Date.now().toString(36)+']',billIds=new Set(),taskIds=new Set(),started=Date.now();
const out=join(repo,'docs/verification/knowledgemap-bridge-2026-10-17/live.json');
const report={at:new Date().toISOString(),boundary:'Real configured model and production OpenClaw/API/MySQL + actual website/browser; synthetic owner inbound, one native QQ digest to owner only; no human sent these test inputs',marker,cases:[]};
let browser,jobId,control,temporary,ingressChanged=false,messageId=-Date.now();
const website=async(route,method='GET',body)=>{
 const r=await fetch('http://127.0.0.1:3000/api/'+route,{method,headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
 assert.ok(r.ok,`website ${route} HTTP${r.status}`);return r.status===204?null:r.json();
};
function restart(){const r=spawnSync('systemctl',['--user','restart','kurumi-fusion.service'],{timeout:20000,encoding:'utf8'});assert.equal(r.status,0,'Fusion restart failed');}
function setIngress(enabled){
 const current=fs.readFileSync(configFile,'utf8');const next=current.replace(/("testIngress"\s*:\s*)(true|false)/,'$1'+enabled);
 assert.notEqual(current,next,'Unexpected ingress state');if(enabled)ingressChanged=true;fs.writeFileSync(configFile,next);
 const r=spawnSync(process.execPath,['scripts/fusion/sync-config.mjs','--apply'],{cwd:repo,encoding:'utf8',timeout:10000});assert.equal(r.status,0,'config sync failed');
 ingressChanged=enabled;restart();
}
async function turn(label,text,verify){
 const result=await rpc('kurumi-qq.testInbound',{capture:true,event:{post_type:'message',message_type:'private',self_id:Number(login.user_id),user_id:Number(owner),message_id:--messageId,time:Math.floor(Date.now()/1000),message:[{type:'text',data:{text:'【文档23架构验证】'+text}}]}},150000);
 assert.ok(result.ok,`${label}: inbound failed`);await verify(result);report.cases.push({label,ok:true});console.log(JSON.stringify({case:label,ok:true}));
}
let login;
const signalCleanup=()=>{try{if(ingressChanged)setIngress(false);}finally{process.exit(130);}};
process.once('SIGINT',signalCleanup);process.once('SIGTERM',signalCleanup);
try{
 await ready();login=await onebot(account(JSON.parse(fs.readFileSync(state+'/openclaw.json'))),'get_login_info',{});
 assert.ok((await client.request('/api/assistant/status')).ok);await website('dashboard/pending/');
 setIngress(true);await ready();
 await turn('model-bill-to-website',`这是本次测试的明确记账请求：今天午饭花14元。备注必须包含${marker}assistant。直接保存一笔，不改其他账单。`,async()=>{
  const rows=(await client.request('/api/assistant/bills',{query:{limit:200}})).items.filter(r=>r.note?.includes(marker));
  for(const r of rows)billIds.add(r.id);assert.equal(rows.length,1);assert.equal(rows[0].amount,'14.00');
  assert.ok((await website('bills/?limit=200')).items.some(r=>r.id===rows[0].id));
 });
 const webBill=await website('bills/','POST',{expense_date:localTime(Date.now()).slice(0,10),amount:'3.50',note:marker+'website'});billIds.add(webBill.id);
 await turn('website-bill-to-model','查询今天的实际账单，把刚才14元和网站入口新记的3.50元两笔核对一下，告诉我两笔金额。',async r=>{assert.match(JSON.stringify(r.captured),/14/);assert.match(JSON.stringify(r.captured),/3\.5/);});
 const title=marker+'收晾好的衣服';
 await turn('model-null-DDL-to-website',`在提醒列表添加一项，标题原样为“${title}”，无DDL，备注“活动结束后越快越好”。`,async()=>{
  const rows=(await client.allTasks()).filter(r=>r.title.includes(marker));for(const r of rows)taskIds.add(r.id);
  assert.equal(rows.length,1);assert.equal(rows[0].event_date,null);assert.match(rows[0].note,/活动结束后/);
 });
 const require=createRequire(import.meta.url),{chromium}=require(process.env.PLAYWRIGHT_MODULE||join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
 browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),pageErrors=[];page.on('pageerror',e=>pageErrors.push(e.message));page.setDefaultTimeout(12000);
 await page.goto('http://127.0.0.1:3000/bills');await page.getByText(marker+'assistant',{exact:false}).first().waitFor();
 await page.goto('http://127.0.0.1:3000/');await page.keyboard.press('Control+k');
 const row=page.locator('.drawer-item').filter({hasText:title});await row.getByText('无 DDL',{exact:true}).waitFor();
 await row.getByRole('button',{name:`修改「${title}」`,exact:true}).click();
 await page.getByLabel('事项备注',{exact:true}).fill(marker+'网站修改：越快越好');await page.getByRole('button',{name:'保存',exact:true}).click();
 await page.getByText('备注：'+marker+'网站修改：越快越好',{exact:true}).waitFor();
 assert.ok((await client.allTasks()).some(r=>taskIds.has(r.id)&&r.note===marker+'网站修改：越快越好'));assert.deepEqual(pageErrors,[]);
 report.cases.push({label:'actual-browser-bill-and-task-shared-edit',ok:true});
 await browser.close();browser=undefined;
 await turn('model-semantic-void',`测试中标题以${marker}开头的衣服已经晾好了，提醒列表里可以去掉这条。`,async()=>assert.ok(!(await client.allTasks()).some(r=>taskIds.has(r.id))));
 await turn('model-weather-via-shared-API','用天气工具查广州当前天气和接下来几小时趋势，说明观测时间。不要修改我的默认城市。',async r=>{
  const text=JSON.stringify(r.captured);assert.match(text,/广州/);assert.match(text,/℃|°C|度/);assert.match(text,/观测|更新|数据时间/);
 });
 // Disable test ingress before scheduling a real delivery. Do not change owner's daily schedule.
 setIngress(false);await ready();report.testIngressRestored=true;
 temporary=fs.mkdtempSync(join(tmpdir(),'km-live-digest-'));
 const scheduledAt=Math.ceil((Date.now()+30000)/60000)*60000,time=localTime(scheduledAt).slice(11,16);
 control=new ListControlStore({root:temporary,ownerId:owner,defaultTimes:[time]});
 const command=join(temporary,'digest.mjs');
 fs.writeFileSync(command,`import {runRemoteDigest} from ${JSON.stringify(join(repo,'chatbot/plugins/personal-reminder-list/remote.js'))};\nimport {KnowledgeMapClient} from ${JSON.stringify(join(repo,'chatbot/packages/knowledgemap-client/client.js'))};\nawait runRemoteDigest({root:${JSON.stringify(temporary)},ownerId:${JSON.stringify(owner)}},new KnowledgeMapClient(${JSON.stringify(bridge)}),${JSON.stringify(time)},text=>process.stdout.write('【文档23架构验证】共享待做播报\\n'+text));\n`);
 const spec={...buildJob(time,{root:temporary,ownerId:owner,repo:join(repo,'chatbot'),dataSource:'knowledgemap',bridgeBaseUrl:bridge.baseUrl,bridgeTokenFile:bridge.tokenFile}),name:'kurumi.knowledgemap.acceptance.'+marker,declarationKey:'kurumi.knowledgemap.acceptance:'+marker,schedule:{kind:'at',at:new Date(scheduledAt).toISOString()}};
 spec.payload.argv=[process.execPath,command];const added=await rpc('cron.add',spec);jobId=added.id??added.job?.id;assert.ok(jobId);report.jobId=jobId;
 let runs=[];
 for(let i=0;i<48;i++){runs=(await rpc('cron.runs',{id:jobId,limit:10})).entries;if(runs.length)break;await new Promise(r=>setTimeout(r,2500));}
 assert.ok(runs.some(r=>r.status==='ok'&&(r.delivered===true||r.deliveryStatus==='delivered')),'Native owner QQ delivery missing');
 control.observeDeliveries({id:jobId,time},runs);const receipt=control.db.prepare('SELECT * FROM deliveries').get();assert.equal(receipt.status,'delivered');
 const expected=(await client.allTasks()).map(r=>'km:'+r.id);assert.deepEqual(JSON.parse(receipt.item_ids_json),expected);
 let duplicate='';await runRemoteDigest({root:temporary,ownerId:owner,now:()=>scheduledAt+1000},client,time,x=>duplicate+=x);assert.equal(duplicate,'');
 const channel=new DatabaseSync(state+'/channel/channel.sqlite',{readOnly:true});const sent=channel.prepare("SELECT message_id FROM outbound WHERE at>=? AND status='sent'").all(started);channel.close();
 const readbacks=[];
 for(const receipt of sent){const msg=await onebot(account(JSON.parse(fs.readFileSync(state+'/openclaw.json'))),'get_msg',{message_id:Number(receipt.message_id)});const text=(msg.message??[]).filter(s=>s.type==='text').map(s=>s.data.text).join('');if(text.includes('【文档23架构验证】共享待做播报'))readbacks.push({messageId:receipt.message_id,allActiveTitlesPresent:(await client.allTasks()).every(i=>text.includes(i.title))});}
 assert.equal(readbacks.length,1);assert.ok(readbacks[0].allActiveTitlesPresent);report.qq={owner,readbacks,digestCount:expected.length,duplicateSilent:true};report.cases.push({label:'native-Cron-shared-API-owner-QQ-readback',ok:true});
 report.ok=true;
}catch(error){report.ok=false;report.error=String(error.message).slice(0,250);process.exitCode=1;}
finally{
 if(ingressChanged){try{setIngress(false);await ready();report.testIngressRestored=true;}catch{report.testIngressRestored=false;report.ok=false;process.exitCode=1;}}
 if(jobId){try{await rpc('cron.remove',{id:jobId});report.testJobRemoved=!(await rpc('cron.list',{includeDisabled:true,limit:100})).jobs.some(j=>j.id===jobId);}catch{report.testJobRemoved=false;report.ok=false;process.exitCode=1;}}
 if(browser)await browser.close();
 // Discover creations even when a verification failed after a successful commit.
 try{
  for(const r of (await client.request('/api/assistant/bills',{query:{limit:200}})).items)if(r.note?.includes(marker))billIds.add(r.id);
  for(const r of await client.allTasks({history:true}))if(r.title.includes(marker))taskIds.add(r.id);
  for(const id of billIds){const rows=(await website('bills/?limit=200')).items;const row=rows.find(r=>r.id===id);assert.ok(row?.note?.includes(marker));await website('bills/'+id+'?expected_version='+row.version,'DELETE');}
  for(const id of taskIds){const r=(await client.allTasks({history:true})).find(r=>r.id===id);assert.ok(r?.title.includes(marker));await website('calendar-events/'+id,'DELETE');}
  report.cleanedTestRows={bills:billIds.size,tasks:taskIds.size,receiptsKept:true};
 }catch{report.cleanupFailed=true;report.ok=false;process.exitCode=1;}
 control?.close();if(temporary)fs.rmSync(temporary,{recursive:true,force:true});
 process.removeListener('SIGINT',signalCleanup);process.removeListener('SIGTERM',signalCleanup);
 fs.writeFileSync(out,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}
