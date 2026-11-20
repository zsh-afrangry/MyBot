import {allowedMembers} from '../../packages/access-control/index.js';
import {registerHostToolBoundary, reportAcceptedInbound} from '../../packages/host-control/index.js';
import WebSocket from 'ws';
import {registerAcceptanceTools} from './src/acceptance.js';
import {account, CHANNEL, token, onebot, sendPayload} from '../../packages/qq-delivery/index.js';
import {createOneBotInbound,handleInbound} from './src/inbound.js';
import {registerStickerTool} from './src/stickers.js';
export const plugin={
 id:CHANNEL,meta:{id:CHANNEL,label:'Kurumi QQ',selectionLabel:'Kurumi QQ (OneBot)',docsPath:'/channels/kurumi-qq',blurb:'QQ private channel with explicit identity permissions'},
 capabilities:{chatTypes:['direct'],media:true,threads:false,reactions:false},
 config:{listAccountIds:()=>['default'],resolveAccount:account,inspectAccount:cfg=>({enabled:cfg.channels?.[CHANNEL]?.enabled===true,configured:!!cfg.channels?.[CHANNEL]?.httpTokenFile}),isEnabled:a=>a.enabled,isConfigured:a=>!!a.httpTokenFile,resolveAllowFrom:({cfg})=>allowedMembers(account(cfg)).map(row=>row.qq)},
 threading:{resolveReplyToMode:({cfg})=>cfg.channels?.[CHANNEL]?.replyToMode??'off',allowExplicitReplyTagsWhenOff:true},
 reload:{configPrefixes:[`channels.${CHANNEL}`]},
 messaging:{normalizeTarget:raw=>String(raw).replace(/^kurumi-qq:/,''),targetResolver:{looksLikeId:raw=>/^(?:user:)?\d+$/.test(raw),hint:'user:<authorized QQ>'}},
 agentPrompt:{inboundFormattingHints:()=>['使用自然中文和适合 QQ 的简短段落。默认普通发送；仅为明确回复较早消息或区分话题才使用显式引用标签。不要输出内部工具日志。任务未实际完成时不要声称已完成。']},
 outbound:{deliveryMode:'direct',textChunkLimit:4000,resolveTarget:({to})=>to?{ok:true,to}:{ok:false,error:Error('Authorized target required')},sendText:args=>sendPayload(args),sendMedia:args=>sendPayload(args)},
 gateway:{startAccount:async (ctx,{runtime,onAcceptedInbound}={})=>{
  const a=ctx.account;const login=await onebot(a,'get_login_info',{});const selfId=String(login.user_id);
  if(selfId===a.ownerId)throw Error('Bot identity must differ from owner');
  const inbound=createOneBotInbound({cfg:ctx.cfg,runtime,selfId,log:ctx.log,signal:ctx.abortSignal,onAcceptedInbound});
  let socket,timer,stopped=false;
  const {promise:stopping,resolve:signalStopped}=Promise.withResolvers();
  const connect=()=>{
   if(stopped)return;
   socket=new WebSocket(a.wsUrl,{headers:{authorization:`Bearer ${token(a,'ws')}`},maxPayload:2*1024*1024});
   socket.on('open',()=>{ctx.setStatus({...ctx.getStatus(),running:true,connected:true});ctx.log?.info('Kurumi QQ OneBot connected');});
   socket.on('message',data=>{
    if(stopped)return;
    let event;try{event=JSON.parse(data.toString());}catch{return;}
    void inbound.enqueue(event).catch(()=>ctx.log?.error?.('Kurumi QQ inbound failed; see task state'));
   });
   socket.on('error',()=>ctx.log?.warn('Kurumi QQ socket error'));
   socket.on('close',()=>{ctx.setStatus({...ctx.getStatus(),connected:false});if(!stopped)timer=setTimeout(connect,3000);});
  };
  const stop=()=>{stopped=true;clearTimeout(timer);socket?.close();signalStopped();};
  ctx.abortSignal.addEventListener('abort',stop,{once:true});
  try{
   if(ctx.abortSignal.aborted)stop();else connect();
   await stopping;
  }finally{
   ctx.abortSignal.removeEventListener('abort',stop);
   await inbound.close();
  }
 }}
};
export default {id:CHANNEL,name:'Kurumi QQ',description:'Isolated identity-scoped OneBot channel',register(api){
 const runtime=api.runtime;
 registerHostToolBoundary(api);
 const onAcceptedInbound=meta=>reportAcceptedInbound(api.config,meta);
 api.registerChannel({plugin:{...plugin,gateway:{startAccount:ctx=>plugin.gateway.startAccount(ctx,{runtime,onAcceptedInbound})}}});
 registerStickerTool(api);
 if(api.config.channels?.[CHANNEL]?.testIngress===true){
  registerAcceptanceTools(api);
  api.registerGatewayMethod('kurumi-qq.testInbound',async ({params,respond,hasCurrentClientAuthority})=>{
   try{
    if(hasCurrentClientAuthority&&!hasCurrentClientAuthority())throw Error('Expired test authority');
    const a=account(api.config);const login=await onebot(a,'get_login_info',{});
    if(hasCurrentClientAuthority&&!hasCurrentClientAuthority())throw Error('Expired test authority');
    const captured=[];const deliverOverride=params.capture===true?async p=>{captured.push({text:p.text,mediaUrl:p.mediaUrl});}:undefined;
    const result=await handleInbound({cfg:api.config,runtime,event:params.event,selfId:String(login.user_id),log:api.logger,deliverOverride,ingressKind:'synthetic'});
    respond(true,{...result,...(params.capture===true?{captured}:{} )});
   }catch(e){respond(false,undefined,{code:'UNAVAILABLE',message:String(e.message).slice(0,180)});}
  },{scope:'operator.admin'});
 }
}};
