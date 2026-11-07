// Synthetic domain fixtures. No host authority or production identity is created.
import {scopeFromInboundEvent} from '../../packages/confirmation-core/dist/index.js';
import {ReminderStore} from '../../packages/personal-domains/dist/reminder-store.js';
import {proposeReminderCreate,commitReminderProposal} from '../../packages/personal-domains/dist/reminders.js';
import {ListStore} from '../../plugins/personal-reminder-list/store.js';
export async function seedReminder(root,owner,now) {
 const store=new ReminderStore({stateDirectory:root+'/state/personal-reminders',now:()=>Math.floor(now()/1000)});
 const inbound={channel:'kurumi-qq',conversationId:'user:'+owner,accountId:'default',senderId:owner,sessionKey:'agent:main:kurumi-qq:direct:'+owner,messageId:'synthetic-confirm',isGroup:false,senderIsOwner:true};
 const ctx={delivery:{channel:'kurumi-qq',to:'user:'+owner,accountId:'default'},scope:scopeFromInboundEvent(inbound)};
 const p=proposeReminderCreate(store,{schema_version:1,request:{kind:'reminder.create',content:'合成提醒：起身活动',schedule:{local_date_time:'2026-11-30T20:00',timezone:'Asia/Shanghai'}}},ctx);
 if(!p.ok)throw Error('fixture proposal rejected');
 store.recordInboundConfirmation({...inbound,content:'确认 '+p.proposalId+' '+p.payloadHash});
 const result=await commitReminderProposal(store,{proposal_id:p.proposalId,payload_hash:p.payloadHash},ctx,{add:async()=>({jobId:'synthetic-job'}),remove:async()=>{}});
 if(!result.ok)throw Error('fixture confirmation rejected '+JSON.stringify(result));store.close();return result.reminder.reminderId;
}
export function seedList(root,owner,now) {
 const store=new ListStore({root,ownerId:owner,now});
 store.changeSchedule({action:'schedule',times:['20:00']},{});
 store.transaction(()=>store.addItem({title:'合成事项',content:'明细不能丢',note:'越快越好',ddl:null,deadlineMs:null},{}));
 store.close();
}
