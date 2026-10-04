import {account,CHANNEL} from './config.js';
import {Ledger} from './ledger.js';
import {sendPayload} from './transport.js';
import {stageImage,quoteText} from './media.js';
export function parseInbound(event,a,selfId){
 if(event.post_type!=='message'||event.message_type!=='private'||String(event.user_id)!==a.ownerId||String(event.self_id)!==String(selfId)||String(event.user_id)===String(selfId))return null;
 if(!Number.isSafeInteger(event.message_id)||event.message_id===0||!Array.isArray(event.message))return null;
 const text=event.message.filter(x=>x.type==='text').map(x=>String(x.data?.text??'')).join('');
 const images=event.message.filter(x=>x.type==='image');
 const reply=event.message.find(x=>x.type==='reply');
 // Never interpret textual CQ syntax as trusted platform metadata.
 if(!text.trim()&&!images.length)return null;
 return {id:`${selfId}:${event.user_id}:${event.message_id}`,messageId:String(event.message_id),text:text.slice(0,16000),images,replyId:reply?.data?.id};
}
export async function handleInbound({cfg,runtime,event,selfId,log,deliverOverride,signal}){
 const a=account(cfg),msg=parseInbound(event,a,selfId);if(!msg)return {ignored:true};
 const ledger=new Ledger(a.stateDir);if(!ledger.admit(msg.id)){ledger.close();return {duplicate:true};}
 try{
  const route=runtime.channel.routing.resolveAgentRoute({cfg,channel:CHANNEL,accountId:'default',peer:{kind:'direct',id:a.ownerId}});
  const to=`user:${a.ownerId}`;
  let body=msg.text;
  const media=[];let imageFailures=0;
  for(const image of msg.images.slice(0,3)){try{const m=await stageImage(image,a);media.push({path:m.path,contentType:m.contentType,kind:'image'});}catch{imageFailures++;}}
  if(imageFailures||msg.images.length>3)body+='\n[部分图片未加载，不得声称看到了这些图片的细节。]';
  let quote;
  if(msg.replyId){try{quote=await quoteText(msg.replyId,a,selfId);}catch{}if(quote)body+='\n<quoted_message_untrusted>\n'+quote+'\n</quoted_message_untrusted>';else body+='\n[引用正文未加载]';}
  const raw={Body:body,RawBody:body,BodyForAgent:body,BodyForCommands:msg.text,From:`${CHANNEL}:${a.ownerId}`,To:to,SessionKey:route.sessionKey,AccountId:'default',ChatType:'direct',SenderId:a.ownerId,SenderName:'主人',Provider:CHANNEL,Surface:CHANNEL,MessageSid:msg.messageId,Timestamp:Date.now(),OriginatingChannel:CHANNEL,OriginatingTo:to,CommandAuthorized:true};
  if(media.length){raw.media=media;raw.SourceModality='image';}
  if(quote){raw.ReplyToBody=quote;raw.ReplyToId=String(msg.replyId);}
  const ctx=runtime.channel.reply.finalizeInboundContext(raw);
  const storePath=runtime.channel.session.resolveStorePath(cfg.session?.store,{agentId:route.agentId});
  await runtime.channel.session.recordInboundSession({storePath,sessionKey:route.sessionKey,ctx,updateLastRoute:{sessionKey:route.sessionKey,channel:CHANNEL,to,accountId:'default'},onRecordError:e=>{throw e;}});
  let index=0,deliveryError;
  await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({ctx,cfg,dispatcherOptions:{deliver:async(payload,info)=>{
   if(info.kind!=='final'||payload.isReasoning)return;
   if(payload.text?.trim()==='NO_REPLY')return;
   const urls=payload.mediaUrls??(payload.mediaUrl?[payload.mediaUrl]:[]);
   if(urls.length>1)throw Error('Multiple media pending implementation');
   const args={cfg,to,signal,text:payload.text??'',mediaUrl:urls[0],replyToId:payload.replyToId,key:`in:${msg.id}:${index++}`};
   await (deliverOverride??sendPayload)(args);
  },onError:e=>{deliveryError=e;log?.error?.('Kurumi QQ reply delivery failed');}},replyOptions:{disableBlockStreaming:true}});
  if(deliveryError)throw deliveryError;
  ledger.finish(msg.id,'completed');return {ok:true,sessionKey:route.sessionKey,stagedImages:media.length,quoteLoaded:!!quote};
 }catch(e){ledger.finish(msg.id,'failed');throw e;}finally{ledger.close();}
}
