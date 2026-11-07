// Operator-only fixed-runner endpoint. Inputs select a due slot, never a route,
// executable, database or user-supplied message. Items come from the real store/API.
import {createAssistantComposer,withFacts} from '../../packages/response-core/index.js';
import {activeSubject,primaryOwner,sessionFor} from '../../packages/access-control/index.js';
import {digestFacts} from './formatter.js';
import {dueSlot} from './time.js';
export function registerDigestNotice(api,options,{loadItems,composeNotice,now=Date.now}={}) {
  const compose=composeNotice??createAssistantComposer({runtime:api.runtime,config:()=>api.config});
  api.registerGatewayMethod?.('personal-reminder-list.compose',async({params,respond})=>{
    let store,digest;
    try {
      if(Object.keys(params).some(k=>k!=='slot')||!/^([01]\d|2[0-3]):[0-5]\d$/.test(params.slot??''))throw Error('invalid_digest_slot');
      const owner=primaryOwner(api.config),check=()=>{
        activeSubject(api.config,owner.qq,'chat.use');activeSubject(api.config,owner.qq,'reminder-list.read');activeSubject(api.config,owner.qq,'qq.notify');
      };check();
      store=options.openStore({...options,now});
      const settings=store.settings();
      if(!settings.enabled||!settings.times.includes(params.slot)||!dueSlot(params.slot,now())){respond(true,{});return;}
      digest=loadItems?store.claimRemoteDigest(params.slot,await loadItems(),settings.version):store.claimDigest(params.slot);
      if(!digest?.count){respond(true,{});return;}
      const facts=digestFacts(digest.items,digest.at);
      const reply=await compose({request:{subjectId:owner.qq,agentId:'main',sessionKey:sessionFor(owner),accountId:'default',to:'user:'+owner.qq},
        check,sourceTool:'personal_reminder_list_digest',facts:{kind:'scheduled_reminder_list',at:digest.at,items:digest.items},
        instructions:'这是已设置的定时待办播报。自然提醒本人查看这些未完成事项，不更改事项状态，不把逾期说成已完成。正文后可由宿主补齐完整事实明细；不要声称已经发出。'});
      check();const text=withFacts(reply.text,facts);
      if(Buffer.byteLength(text,'utf8')>500000)throw Error('digest_output_limit');
      const visible=store.finishDigestGeneration(digest.slotKey,text);
      respond(true,visible?{text}:{});
    }catch{if(digest?.count)store?.finishDigestGeneration(digest.slotKey,'','generation_failed');respond(false,undefined,{code:'UNAVAILABLE',message:'assistant_notice_generation_failed'});}
    finally{store?.close();}
  },{scope:'operator.admin'});
}
