// P2-only bounded projection for an explicitly authorized composition consumer.
// Does not import N2 applications, raw history, organizers or migration code.
import {openContinuityStore} from './store.js';
import {options} from './model.js';
export function readContinuityContext({workspace,ownerId,config={},now=Date.now}) {
  const cfg=options(config),store=openContinuityStore({workspace,ownerId,readonly:true});
  try {
    const data=store.read(),result={revision:data.revision,generation:data.generation,facts:[],recentSummaries:[]};
    let used=JSON.stringify(result).length;
    for(const [target,entries] of [['facts',data.facts],['recentSummaries',[...data.summaries].reverse().filter(e=>Date.parse(e.expiresAt)>now())]]) {
      for(const row of entries) {
        const value={id:row.id,text:row.text,kind:row.kind,updatedAt:row.updatedAt,...(row.expiresAt?{expiresAt:row.expiresAt}:{})};
        const size=JSON.stringify(value).length+2;if(used+size>cfg.maxContextChars)continue;
        result[target].push(value);used+=size;
      }
    }
    return result;
  } finally {store.close();}
}
