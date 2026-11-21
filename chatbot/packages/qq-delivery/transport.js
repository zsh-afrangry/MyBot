import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {account,ownerTarget,token} from './config.js';
import {Ledger} from './ledger.js';
import {setTimeout as pause} from 'node:timers/promises';
import {presentForQQ} from './presentation.js';
import {imageType, MAX_IMAGE_BYTES} from './image.js';
import {imageDeliveryPrefix, recordImageFeedback, subjectDeliveryPrefix, writeImageFeedback} from './image-feedback.js';
import {observeFeedback} from '../feedback-core/index.js';
export async function onebot(a,action,params,signal,{timeoutMs=15000}={}){
 const r=await fetch(new URL('/'+action,a.httpUrl),{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token(a,'http')}`},body:JSON.stringify(params),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]):AbortSignal.timeout(timeoutMs)});
 if(!r.ok)throw Error(`OneBot HTTP ${r.status}`);
 const data=await r.json();
 if(data?.status==='failed'&&Number.isInteger(data.retcode)&&data.retcode!==0)throw Object.assign(Error(`OneBot rejected action (${data.retcode})`),{rejected:true});
 if(data?.status!=='ok'||data.retcode!==0)throw Error('Invalid OneBot action receipt');
 return data.data;
}
export function localImage(file,a){
 // Only explicitly staged media; symlink escapes and arbitrary files are rejected.
 const root=fs.realpathSync(a.mediaRoot);const target=fs.realpathSync(file.replace(/^file:\/\//,''));
 if(!target.startsWith(root+path.sep)||!fs.statSync(target).isFile())throw Error('Image outside staged media');
 const bytes=fs.readFileSync(target);if(bytes.length>MAX_IMAGE_BYTES)throw Error('Image exceeds 8 MiB');
 if(!imageType(bytes))throw Error('Unsupported image bytes');
 return {type:'image',data:{file:'base64://'+bytes.toString('base64')}};
}
export async function sendSegments(cfg,to,message,id=randomUUID(),context={}){
 const a=account(cfg),target=ownerTarget(to,a);
 // Preserve legacy owner receipt keys; every member has a separate idempotency namespace.
 const subjectPrefix=subjectDeliveryPrefix(target,a.ownerId);
 id=subjectPrefix+id;
 if(!Array.isArray(message)||!message.length||message.some(x=>!['text','reply','image'].includes(x.type)))throw Error('Invalid message segments');
 context.signal?.throwIfAborted();
 const l=new Ledger(a.stateDir);
 try{
  const onReserve=context.onReserve && (db=>context.onReserve(db,id,target));
  const prior=l.reserve(id,a.sendLimit,a.dailySendLimit??120,context.quota?{...context.quota,prefix:subjectPrefix+context.quota.prefix}:undefined,null,onReserve);
  if(prior){
   if(prior.status==='sent')return {channel:'kurumi-qq',messageId:prior.message_id,...(context.reportReplay?{replayed:true}:{})};
   throw Object.assign(Error('Previous QQ send unresolved/failed; manual reconciliation required'),{code:'qq_receipt_unresolved'});
  }
  try{
   await context.onPlatformSendDispatch?.();
   context.signal?.throwIfAborted();context.assertDirectAdapterHandoff?.();
   ownerTarget(to,account(cfg));
   const r=await onebot(a,'send_private_msg',{user_id:Number(target),message},context.signal);
   if(!Number.isSafeInteger(r?.message_id)||r.message_id===0)throw Error('Missing message receipt');
   l.sent(id,r.message_id);return {channel:'kurumi-qq',messageId:String(r.message_id)};
  }catch(e){if(e.rejected)l.failed(id);throw e;}
 }finally{l.close();}
}
export async function sendImage({cfg,to,bytes,contentType,key,text='',signal,dailyLimit=20,assertDirectAdapterHandoff,feedback}){
 signal?.throwIfAborted();
 if(typeof key!=='string'||!key||key.length>512)throw Error('Stable image delivery key required');
 const type=imageType(bytes);
 if(!type||bytes.length>MAX_IMAGE_BYTES||type!==contentType)throw Error('Invalid QQ image');
 if(typeof text!=='string'||text.length>500)throw Error('Invalid QQ image caption');
 const segments=[];
 if(text)segments.push({type:'text',data:{text}});
 segments.push({type:'image',data:{file:'base64://'+bytes.toString('base64')}});
 const observation = feedback && {...feedback, imageStatus: 'generated'};
 const onReserve = observation && ((db,id,peer)=>observeFeedback(observation.action, observation.log,
   ()=>writeImageFeedback(db,{...observation,id,peer,reserved:true})));
 try {
  return await sendSegments(cfg,to,segments,imageDeliveryPrefix+key,{signal,assertDirectAdapterHandoff,reportReplay:true,
   quota:{prefix:imageDeliveryPrefix,limit:dailyLimit},onReserve});
 }catch(error){
  if(observation)observeFeedback(observation.action,observation.log,()=>{
   assertDirectAdapterHandoff?.();
   recordImageFeedback(cfg,{...observation,to,key});
  });
  throw error;
 }
}
export async function sendPayload({cfg,to,text='',mediaUrl,replyToId,key,deliveryQueueId,deliveryPartIndex,signal,onPlatformSendDispatch,assertDirectAdapterHandoff,onDeliveryResult,onTextPlan}){
 key??=deliveryQueueId?`delivery:${deliveryQueueId}:${deliveryPartIndex??0}`:randomUUID();
 const a=account(cfg),target=ownerTarget(to,a);
 const mediaAccount=target===a.ownerId?a:{...a,mediaRoot:path.join(a.mediaRoot,'subjects',target)};
 if(replyToId!=null&&!/^-?[1-9]\d*$/.test(String(replyToId)))throw Error('Invalid reply id');
 const media=mediaUrl?localImage(mediaUrl,mediaAccount):null;
 const {pieces,paced}=presentForQQ(text,a.chunkLimit??1200,a.naturalSegments!==false);
 if(!pieces.length&&media)pieces.push('');
 if(pieces.length&&!media)onTextPlan?.(subjectDeliveryPrefix(target,a.ownerId)+key,pieces.length);
 let last;
 for(let i=0;i<pieces.length;i++){
  if(i>0&&paced)await pause(a.segmentDelayMs??450,undefined,{signal});
  const message=[];
  if(i===0&&replyToId)message.push({type:'reply',data:{id:String(replyToId)}});
  if(pieces[i])message.push({type:'text',data:{text:pieces[i]}});
  if(i===pieces.length-1&&media)message.push(media);
  last=await sendSegments(cfg,to,message,`${key}:${i}`,{signal,onPlatformSendDispatch,assertDirectAdapterHandoff});
  await onDeliveryResult?.(last);
 }
 return last??{channel:'kurumi-qq',messageId:''};
}
