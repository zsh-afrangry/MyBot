import {digest,time} from './policy.js';
// Short-lived projection of newly accepted owner messages. Never reads history
// or persists raw text; resetting/forgetting discards this projection.
export function createRecentContext({ownerId,now=Date.now,maxAgeMs=21600000}) {
  const accepted=new Map();let turns=[],generation;
  const key='agent:main:kurumi-qq:direct:'+ownerId;
  const prune=()=>{const at=time(now());turns=turns.filter(t=>at>=t.at&&at-t.at<maxAgeMs).slice(-8);};
  return {
    accepted(meta) {
      if(meta.origin!=='onebot'||meta.subjectId!==ownerId||meta.agentId!=='main'||meta.sessionKey!==key||meta.postType!=='message')return;
      accepted.set(String(meta.messageId),meta.occurredAt);
      while(accepted.size>32)accepted.delete(accepted.keys().next().value);
    },
    receive(ctx,raw) {
      const id=String(ctx?.MessageSid),at=accepted.get(id);accepted.delete(id);
      if(!Number.isSafeInteger(at)||at>now()||now()-at>=maxAgeMs||typeof raw!=='string'||!raw.trim()||raw.trimStart().startsWith('/'))return;
      const text=raw.slice(0,1000).replace(/(?:Bearer\s+|(?:api[_-]?key|token|password|密码)\s*[:：=]\s*)\S+/gi,'[credential omitted]');
      turns.push({sourceId:'chat:'+digest(id).slice(0,24),role:'owner',text,at,expiresAt:at+maxAgeMs});prune();
    },
    sent(key,text) {turns.push({sourceId:'speech:'+digest(key).slice(0,24),role:'assistant',text:text.slice(0,1000),at:time(now()),expiresAt:now()+maxAgeMs});prune();},
    read(currentGeneration) {
      time(currentGeneration);
      if(generation!==undefined&&generation!==currentGeneration){turns=[];accepted.clear();}
      generation=currentGeneration;prune();return structuredClone(turns);
    },
    clear(){turns=[];accepted.clear();},
  };
}
