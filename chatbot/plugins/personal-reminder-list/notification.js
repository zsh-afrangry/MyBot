// Operator-only fixed-runner endpoint. Inputs select a due slot, never a route,
// executable, database or user-supplied message. Items come from the real store/API.
import {createAssistantComposer,withFacts,noticeErrorRecord} from '../../packages/response-core/index.js';
import {createHash} from 'node:crypto';
import {activeSubject,primaryOwner,sessionFor} from '../../packages/access-control/index.js';
import {digestFacts} from './formatter.js';
import {dueSlot} from './time.js';
export function registerDigestNotice(api,options,{loadItems,composeNotice,now=Date.now}={}) {
  const compose=composeNotice??createAssistantComposer({runtime:api.runtime,config:()=>api.config});
  api.registerGatewayMethod?.('personal-reminder-list.compose',async({params,respond})=>{
    let store,digest,generation,validation,stage='claim';
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
      stage='generation';
      const reply=await compose({request:{subjectId:owner.qq,agentId:'main',sessionKey:sessionFor(owner),accountId:'default',to:'user:'+owner.qq},
        check,sourceTool:'personal_reminder_list_digest',facts:{kind:'scheduled_reminder_list_opening',at:digest.at,timezone:'Asia/Shanghai',count:digest.count},
        instructions:'这是已设置的定时待办播报。只写一小段自然开场，沿用人格和当前关系，可提未完成数量；本轮完整清单由宿主紧接开场呈现一次。不要列举或概括任何具体事项，不从历史搬出标题、ID、DDL、内容或备注，不生成列表，不追问确认，不声称已经发出或更改状态。'});
      check();
      generation={runId:reply.runId,sessionId:reply.sessionId};stage='opening_validation';
      const opening=reply.text?.trim();
      // This is a literal presentation check, never an authorization or chat-intent parser.
      // A rejected opening cannot silently fall back to facts-only delivery.
      const repeatsItems=!!opening && digest.items.some(item=>
        [item.id,...[item.title,item.content,item.note].filter(value=>typeof value==='string' && [...value.trim()].length>=4)]
          .some(value=>typeof value==='string' && value.trim() && opening.includes(value.trim())));
      validation={empty:!opening,multiline:/[\r\n]/u.test(opening??''),repeatsItems,
        textLength:(reply.text??'').length,lineCount:(reply.text??'').split(/\r\n|\r|\n/u).length,
        sha256:createHash('sha256').update(reply.text??'').digest('hex')};
      const rule=validation.empty?'digest_opening_empty':validation.multiline?'digest_opening_multiline':repeatsItems?'digest_opening_repeats_items':undefined;
      if(rule)throw Object.assign(Error(rule),{code:rule});
      stage='freeze';
      const text=withFacts(opening,facts);
      if(Buffer.byteLength(text,'utf8')>500000)throw Error('digest_output_limit');
      const visible=store.finishDigestGeneration(digest.slotKey,text,undefined,{generation,validation});
      respond(true,visible?{text}:{});
    }catch(error){
      if(digest?.count)store?.finishDigestGeneration(digest.slotKey,'',{
        stage,error:noticeErrorRecord(error),generation:generation??error?.generation,validation,
        origin:{file:'chatbot/plugins/personal-reminder-list/notification.js',function:'registerDigestNotice',rule:error?.code??error?.message},
      });
      respond(false,undefined,{code:'UNAVAILABLE',message:'assistant_notice_generation_failed'});
    }
    finally{store?.close();}
  },{scope:'operator.admin'});
}
