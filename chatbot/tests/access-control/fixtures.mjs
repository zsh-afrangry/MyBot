// Synthetic identities and policy builders for offline tests, never production configuration. docs/24.
import {PERMISSIONS,SHARED_PERMISSIONS,sessionFor,agentFor} from '../../packages/access-control/index.js';
export const OWNER='365999865',MEMBER='800001',OTHER='800002';
export function ownerPolicy(id=OWNER){return {version:1,revision:1,subjects:[{qq:id,kind:'user',role:'owner',enabled:true,permissions:Object.fromEntries(PERMISSIONS.map(p=>[p,true])),mailRecipients:[id+'@qq.com']}]};}
export function memberRow(id=MEMBER){return {qq:id,kind:'user',role:'member',enabled:true,permissions:Object.fromEntries(SHARED_PERMISSIONS.map(p=>[p,true])),mailRecipients:[]};}
export function withAccess(cfg,id=cfg.channels?.['kurumi-qq']?.ownerId??OWNER){
 cfg.channels??={};cfg.channels['kurumi-qq']??={};const a=cfg.channels['kurumi-qq'];a.ownerId=id;a.accessControl=ownerPolicy(id);return cfg;
}
export function context(row){return {messageChannel:'kurumi-qq',requesterSenderId:row.qq,senderIsOwner:row.role==='owner',agentId:agentFor(row),sessionKey:sessionFor(row),sessionId:'synthetic-'+row.qq,agentAccountId:'default',deliveryContext:{channel:'kurumi-qq',to:'user:'+row.qq,accountId:'default'},assertInvocationCurrent(){}};}
