import WebSocket from 'ws';
import {account,CHANNEL,token,ownerTarget} from './src/config.js';
import {onebot,sendPayload} from './src/transport.js';
import {handleInbound} from './src/inbound.js';
let runtime;
export const plugin={
 id:CHANNEL,meta:{id:CHANNEL,label:'Kurumi QQ',selectionLabel:'Kurumi QQ (OneBot)',docsPath:'/channels/kurumi-qq',blurb:'Owner-only QQ channel'},
 capabilities:{chatTypes:['direct'],media:true,threads:false,reactions:false},
 config:{listAccountIds:()=>['default'],resolveAccount:account,inspectAccount:cfg=>({enabled:cfg.channels?.[CHANNEL]?.enabled===true,configured:!!cfg.channels?.[CHANNEL]?.httpTokenFile}),isEnabled:a=>a.enabled,isConfigured:a=>!!a.httpTokenFile,resolveAllowFrom:({cfg})=>[account(cfg).ownerId]},
 reload:{configPrefixes:[`channels.${CHANNEL}`]},
 messaging:{normalizeTarget:raw=>String(raw).replace(/^kurumi-qq:/,''),targetResolver:{looksLikeId:raw=>/^(?:user:)?\d+$/.test(raw),hint:'user:<owner QQ>'}},
 agentPrompt:{inboundFormattingHints:()=>['使用自然中文和适合 QQ 的简短段落。不要输出内部工具日志。任务未实际完成时不要声称已完成。']},
 outbound:{deliveryMode:'direct',textChunkLimit:4000,resolveTarget:({to})=>to?{ok:true,to}:{ok:false,error:Error('Owner target required')},sendText:args=>sendPayload(args),sendMedia:args=>sendPayload(args)},
 gateway:{startAccount:async ctx=>{
  const a=ctx.account;const login=await onebot(a,'get_login_info',{});const selfId=String(login.user_id);
  if(selfId===a.ownerId)throw Error('Bot identity must differ from owner');
  let socket,timer,stopped=false;const pending=new Set();
  await new Promise(resolve=>{
   const connect=()=>{
    if(stopped)return;
    socket=new WebSocket(a.wsUrl,{headers:{authorization:`Bearer ${token(a,'ws')}`},maxPayload:2*1024*1024});
    socket.on('open',()=>{ctx.setStatus({...ctx.getStatus(),running:true,connected:true});ctx.log?.info('Kurumi QQ OneBot connected');});
    socket.on('message',data=>{
     let event;try{event=JSON.parse(data.toString());}catch{return;}
     const task=handleInbound({cfg:ctx.cfg,runtime,event,selfId,log:ctx.log}).catch(()=>ctx.log?.error('Kurumi QQ inbound failed; see task state')).finally(()=>pending.delete(task));pending.add(task);
    });
    socket.on('error',()=>ctx.log?.warn('Kurumi QQ socket error'));
    socket.on('close',()=>{ctx.setStatus({...ctx.getStatus(),connected:false});if(!stopped)timer=setTimeout(connect,3000);});
   };
   const stop=()=>{stopped=true;clearTimeout(timer);socket?.close();resolve();};
   ctx.abortSignal.addEventListener('abort',stop,{once:true});if(ctx.abortSignal.aborted)stop();else connect();
  });
  await Promise.allSettled(pending);
 }}
};
export default {id:CHANNEL,name:'Kurumi QQ',description:'Isolated owner-only OneBot channel',register(api){runtime=api.runtime;api.registerChannel({plugin});
 if(api.config.channels?.[CHANNEL]?.testIngress===true){
  api.registerGatewayMethod('kurumi-qq.testInbound',async ({params,respond,hasCurrentClientAuthority})=>{
   try{
    if(hasCurrentClientAuthority&&!hasCurrentClientAuthority())throw Error('Expired test authority');
    const a=account(api.config);const login=await onebot(a,'get_login_info',{});
    if(hasCurrentClientAuthority&&!hasCurrentClientAuthority())throw Error('Expired test authority');
    const result=await handleInbound({cfg:api.config,runtime,event:params.event,selfId:String(login.user_id),log:api.logger});
    respond(true,result);
   }catch(e){respond(false,undefined,{code:'UNAVAILABLE',message:String(e.message).slice(0,180)});}
  },{scope:'operator.admin'});
 }
}};
