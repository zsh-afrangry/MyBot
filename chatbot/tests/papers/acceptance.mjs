// Authorized acceptance: real translation model/API and runtime job state; optional real QQ/mail.
// Flags --send-qq / --send-mail opt in to actual owner-only delivery. No other recipients.
// Confirmation is recorded programmatically for the explicitly authorized SMTP test, not a QQ round trip.
// Development owner: docs/22_论文PDF翻译与文件投递.md; evidence: docs/verification/paper-translation-2026-10-17/.
import fs from 'node:fs';
import path from 'node:path';
import {PaperService} from '../../plugins/kurumi-papers/service.js';
import {sendDocument,stagePdf} from '../../plugins/kurumi-qq/src/files.js';
import {sendPayload} from '../../plugins/kurumi-qq/src/transport.js';
import {createMailApplication,readMailConfig} from '../../plugins/kurumi-mail/application.js';
import {scopeFromInboundEvent} from '../../plugins/kurumi-mail/scope.js';
const arg=(name,fallback)=>{const i=process.argv.indexOf('--'+name);return i<0?fallback:process.argv[i+1];};
const state='/home/afrangry/.openclaw-fusion';
const input=arg('input'), out=arg('out');
if(!input||!out||!path.isAbsolute(input)||!path.isAbsolute(out))throw Error('Absolute --input and --out are required');
if(fs.existsSync(path.join(out,'acceptance.json')))throw Error('Evidence exists; use a new --out directory');
const at=new Date().toISOString(), tag=Date.now().toString(36);
const root=arg('root',path.join(state,'paper-acceptance','gpt-default'));
if(!path.isAbsolute(root)||!root.startsWith(path.join(state,'paper-acceptance')+path.sep))throw Error('Acceptance root must be inside private paper-acceptance state');
const config={root,python:path.join(state,'venvs/paper-translation/bin/python'),credentialsFile:path.join(state,'paper-credentials.json'),maxPages:30,maxRequests:300,maxReportedTokens:200000,timeoutSeconds:1800,apiConcurrency:Number(arg('concurrency',1)),apiQps:Number(arg('qps',1)),liveTranslationEnabled:true};
const cfg=JSON.parse(fs.readFileSync(path.join(state,'openclaw.json')));
cfg.plugins.entries['kurumi-papers']={enabled:true,config};
let sends=0;
const service=new PaperService(config,{sendFile:async(id,key,signal)=>{sends++;return sendDocument({cfg,to:'user:'+cfg.channels['kurumi-qq'].ownerId,documentId:id,key,signal});}});
const report={startedAt:at,boundary:'Real translation model/API; private runtime acceptance state. Actual QQ/SMTP only when explicitly flagged; programmatic approval is not QQ confirmation or inbox proof.',source:input,config:{...config,credentialsFile:'[private credential file]'},sendQQ:process.argv.includes('--send-qq'),sendMail:process.argv.includes('--send-mail')};
fs.mkdirSync(out,{recursive:true});
const save=()=>fs.writeFileSync(path.join(out,'acceptance.json'),JSON.stringify(report,null,2));
try{
 // Reusing an artifact must not restart/mark interrupted another running acceptance job.
 if(!arg('reuse-job'))service.start();
 const doc=await service.documents.add(fs.readFileSync(input),{filename:path.basename(input),source:{type:'operator-acceptance'}});
 const reuse=arg('reuse-job');report.reusedJob=Boolean(reuse);
 const profile=Object.fromEntries(['provider','channel','model','effort'].filter(name=>arg(name)!=null).map(name=>[name,arg(name)]));
 const job=reuse?service.get(reuse):service.submit({...profile,documentId:doc.id,pages:arg('pages'),output:arg('output','dual'),delivery:'none'},{key:'acceptance:'+tag});
 if(job.documentId!==doc.id)throw Error('source_document_mismatch');
 report.document=doc;report.jobId=job.id;save();
 let last='';
 while(true){const state=service.get(job.id);const status=state.status+':'+(state.delivery?.status??'');if(status!==last){console.log(JSON.stringify({jobId:job.id,status:state.status,delivery:state.delivery?.status}));last=status;}
  if(!['queued','running'].includes(state.status)&&!service.active){report.job=state;break;}await new Promise(r=>setTimeout(r,1000));}
 report.sends=sends;
 if(report.job.status!=='succeeded')throw Error(report.job.error??'translation_failed');
 report.artifacts=Object.fromEntries(Object.entries(report.job.artifacts).map(([kind,id])=>[kind,service.documents.describe(id)]));
 if(report.sendQQ){
  report.qqNotice=await sendPayload({cfg,to:'user:'+cfg.channels['kurumi-qq'].ownerId,key:'paper-acceptance-notice:'+job.id,text:'[论文翻译验收] 接下来发送 '+path.basename(input)+(job.pages?' 的页码 '+job.pages+' 双语样稿，不是整篇译稿。':' 的双语译稿。')+'这是本人授权的文件投递测试；当前引擎可能合并作者/单位区域，翻译和排版尚不能视为人工校对通过。'});
  report.qq=await service.sendFile(report.job.artifacts.dual,'acceptance:'+job.id+':dual');
  // This checks retrieval of the bot's outbound file, not a real owner-upload event.
  if(report.qq.fileId){
   try{
    const artifact=report.artifacts.dual;
    const returned=await stagePdf({data:{file_id:report.qq.fileId,name:artifact.filename,size:artifact.bytes}},cfg);
    report.qqRoundTrip={ok:returned.sha256===artifact.sha256,document:returned,boundary:'Actual outbound file URL retrieval/download/PDF validation; not an owner inbound event or receipt confirmation.'};
   }catch{report.qqRoundTrip={ok:false,code:'outbound_file_retrieval_failed',boundary:'Upload receipt remains authoritative; not proof of an owner inbound event.'};}
  }
 }
 report.sends=sends;
 if(report.sendMail){
  const env=JSON.parse(fs.readFileSync(path.join(state,'runtime-env.json'))),mailConfig=readMailConfig(env);
  const allowed=cfg.plugins.entries['kurumi-mail'].config.allowedRecipients;
  const recipient='365999865@qq.com';if(!allowed.includes(recipient))throw Error('Authorized test recipient is not allowlisted');
  const app=createMailApplication({resolveAttachment:id=>service.documents.get(id)}),store=app.openStore({stateDirectory:path.join(root,'mail'),allowedRecipients:allowed});
  try{
   const owner=cfg.channels['kurumi-qq'].ownerId;
   const event={channel:'kurumi-qq',accountId:'default',conversationId:'user:'+owner,senderId:owner,senderIsOwner:true,isGroup:false,sessionKey:`agent:main:kurumi-qq:direct:${owner}`,messageId:'paper-acceptance-'+tag,timestamp:Date.now()};
   const scope=scopeFromInboundEvent(event);
   const draft=app.directives.createDraft(store,{to:recipient,subject:'[论文翻译验收] '+path.basename(input)+(job.pages?'（仅页码 '+job.pages+'）':''),text:'本邮件用于本人授权的论文翻译附件验收；附件为本次实际生成的双语 PDF。'+(job.pages?'本次只包含页码 '+job.pages+'，不是整篇译稿。':'')+'当前排版引擎可能合并作者/单位区域，不能把本邮件视为本人已经确认翻译与排版质量。',attachments:[{documentId:report.job.artifacts.dual}]},scope,allowed);
   if(!draft.ok)throw Error('Attachment draft failed');
   report.mailDraft={draftId:draft.draftId,attachments:draft.attachments,recipient};
   if(!store.recordInboundConfirmation({...event,content:draft.confirmationInstruction},draft.draftId))throw Error('Programmatic test approval failed');
   report.mail=await app.directives.sendDraft(store,{draftId:draft.draftId},{scope,config:mailConfig,allowedRecipients:allowed});
   if(!report.mail.ok)throw Error('SMTP attachment delivery failed');
  }finally{store.close();}
 }
 report.ok=true;
}catch(e){report.ok=false;report.error=/^[a-zA-Z0-9_]+$/.test(e.message)?e.message:'acceptance_failed';process.exitCode=1;}
finally{await service.stop();report.finishedAt=new Date().toISOString();report.elapsedSeconds=(Date.parse(report.finishedAt)-Date.parse(at))/1000;save();console.log(JSON.stringify({ok:report.ok,error:report.error,report:path.join(out,'acceptance.json')}));}
