import type {OpenClawPluginApi} from 'openclaw/plugin-sdk/plugin-entry';
import {activeSubject,primaryOwner,sessionFor} from '@kurumi/access-control';
import {createAssistantComposer,withFacts,type Composer} from '../../response-core/index.js';
import {ReminderStore} from './reminder-store.js';
import {reminderStateDirectory} from './paths.js';

/** Fixed native runner only selects an already approved due reminder. The
 * operator endpoint owns data and routing; no model-facing command is added. */
export function registerReminderNotice(api:OpenClawPluginApi,options:{open?:()=>ReminderStore;composeNotice?:Composer}={}) {
  const compose=options.composeNotice??createAssistantComposer({runtime:api.runtime,config:()=>api.config});
  api.registerGatewayMethod?.('personal-reminder.compose',async({params,respond})=>{
    let store:ReminderStore|undefined,id:string|undefined,claimed=false;
    try {
      if(Object.keys(params).some(k=>k!=='id')||typeof params.id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(params.id))throw Error('invalid_reminder_id');
      id=params.id;
      const owner=primaryOwner(api.config),check=()=>{
        activeSubject(api.config,owner.qq,'chat.use');activeSubject(api.config,owner.qq,'reminders.read');activeSubject(api.config,owner.qq,'qq.notify');
      };check();
      store=options.open?.()??new ReminderStore({stateDirectory:reminderStateDirectory()});
      const current=store.getReminder(id);
      if(!current){respond(true,{});return;}
      if(current.delivery.channel!=='kurumi-qq'||current.delivery.to!=='user:'+owner.qq||(current.delivery.accountId??'default')!=='default')throw Error('untrusted_reminder_binding');
      const reminder=store.claimForDelivery(id,store.getNowUtc());
      if(!reminder){respond(true,{});return;}claimed=true;
      const reply=await compose({request:{subjectId:owner.qq,agentId:'main',sessionKey:sessionFor(owner),to:'user:'+owner.qq,accountId:'default'},
        check,sourceTool:'personal_reminder_delivery',facts:{kind:'scheduled_reminder',reminderId:id,content:reminder.content,scheduledAtUtc:reminder.scheduledAtUtc,timezone:reminder.timezone},
        instructions:'这是已由本人确认且已到时间的一次性提醒。自然提醒本人，不创建新提醒、不替本人完成事项，不声称已经发出。宿主会补齐不可变的时间和内容明细。'});
      check();
      const at=new Intl.DateTimeFormat('sv-SE',{timeZone:reminder.timezone,dateStyle:'short',timeStyle:'short'}).format(reminder.scheduledAtUtc*1000);
      respond(true,{text:withFacts(reply.text,['时间：'+at+'（'+reminder.timezone+'）','内容：'+reminder.content])});
    }catch{
      if(claimed&&id&&store)store.markNoticeGenerationFailed(id,store.getNowUtc());
      respond(false,undefined,{code:'UNAVAILABLE',message:'assistant_notice_generation_failed'});
    }finally{store?.close();}
  },{scope:'operator.admin'});
}
