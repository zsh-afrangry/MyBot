import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {account,ownerTarget,token} from './config.js';
import {Ledger} from './ledger.js';
import {mdToPlain,splitForQQ} from './vendor/md-to-plain.js';
export async function onebot(a,action,params){
 const r=await fetch(new URL('/'+action,a.httpUrl),{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token(a,'http')}`},body:JSON.stringify(params),signal:AbortSignal.timeout(15000)});
 if(!r.ok)throw Error(`OneBot HTTP ${r.status}`);
 const data=await r.json();if(data.status!=='ok'||data.retcode!==0){const e=Error(`OneBot rejected action (${data.retcode})`);e.rejected=true;throw e;}return data.data;
}
export function localImage(file,a){
 // Only explicitly staged media; symlink escapes and arbitrary files are rejected.
 const root=fs.realpathSync(a.mediaRoot);const target=fs.realpathSync(file.replace(/^file:\/\//,''));
 if(!target.startsWith(root+path.sep)||!fs.statSync(target).isFile())throw Error('Image outside staged media');
 const bytes=fs.readFileSync(target);if(bytes.length>8*1024*1024)throw Error('Image exceeds 8 MiB');
 if(!(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||(bytes[0]===255&&bytes[1]===216)||bytes.subarray(0,3).toString()==='GIF'||(bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP')))throw Error('Unsupported image bytes');
 return {type:'image',data:{file:'base64://'+bytes.toString('base64')}};
}
export async function sendSegments(cfg,to,message,id=randomUUID()){
 const a=account(cfg);ownerTarget(to,a);
 if(!Array.isArray(message)||!message.length||message.some(x=>!['text','reply','image'].includes(x.type)))throw Error('Invalid message segments');
 const l=new Ledger(a.stateDir);
 try{
  const prior=l.reserve(id,a.sendLimit);
  if(prior){if(prior.status==='sent')return {channel:'kurumi-qq',messageId:prior.message_id};throw Error('Previous QQ send unresolved/failed; manual reconciliation required');}
  try{
   const r=await onebot(a,'send_private_msg',{user_id:Number(a.ownerId),message});
   if(!Number.isSafeInteger(r?.message_id)||r.message_id===0)throw Error('Missing message receipt');
   l.sent(id,r.message_id);return {channel:'kurumi-qq',messageId:String(r.message_id)};
  }catch(e){if(e.rejected)l.failed(id);throw e;}
 }finally{l.close();}
}
export async function sendPayload({cfg,to,text='',mediaUrl,replyToId,key=randomUUID()}){
 const a=account(cfg);ownerTarget(to,a);
 if(replyToId!==undefined&&!/^-?[1-9]\d*$/.test(String(replyToId)))throw Error('Invalid reply id');
 const media=mediaUrl?localImage(mediaUrl,a):null;
 const pieces=splitForQQ(mdToPlain(text),a.chunkLimit??1200);
 if(!pieces.length&&media)pieces.push('');
 let last;
 for(let i=0;i<pieces.length;i++){
  const message=[];
  if(i===0&&replyToId)message.push({type:'reply',data:{id:String(replyToId)}});
  if(pieces[i])message.push({type:'text',data:{text:pieces[i]}});
  if(i===pieces.length-1&&media)message.push(media);
  last=await sendSegments(cfg,to,message,`${key}:${i}`);
 }
 return last??{channel:'kurumi-qq',messageId:''};
}
