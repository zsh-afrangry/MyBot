import {randomUUID} from 'node:crypto';
import {error,time} from './policy.js';
// Assistant-owned notes only. Tombstones retain concurrency evidence, not text.
export function createSelfRecords({store,scope,now=Date.now}) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS proactive_record (
    id TEXT PRIMARY KEY, scope TEXT NOT NULL, version INTEGER NOT NULL,
    generation INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT, sources TEXT,
    updated INTEGER NOT NULL, expires INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0);
    PRAGMA secure_delete=ON;`);
  const view=row=>({id:row.id,version:row.version,generation:row.generation,kind:row.kind,text:row.text,
    sources:JSON.parse(row.sources),updatedAt:row.updated,expiresAt:row.expires});
  return {
    page(generation,{offset=0}={}) {
      time(generation);time(offset);const at=time(now());
      const rows=store.db.prepare('SELECT * FROM proactive_record WHERE scope=? AND deleted=0 ORDER BY updated DESC,id LIMIT 50 OFFSET ?').all(scope,offset);
      const total=store.db.prepare('SELECT COUNT(*) AS n FROM proactive_record WHERE scope=? AND deleted=0').get(scope).n;
      return {records:rows.map(row=>({...view(row),active:row.generation===generation&&row.expires>at})),total,nextOffset:offset+rows.length<total?offset+rows.length:null};
    },
    list(generation,{includeInactive=false}={}) {
      time(generation);const at=time(now());
      return store.db.prepare(`SELECT * FROM proactive_record WHERE scope=? AND deleted=0
        ${includeInactive?'':'AND generation=? AND expires>?'} ORDER BY updated DESC,id LIMIT 201`)
        .all(scope,...(includeInactive?[]:[generation,at])).map(row=>({...view(row),active:row.generation===generation&&row.expires>at}));
    },
    put(args,{generation,knownSources,owner=false}) {
      time(generation);const at=time(now());
      if (!args||Object.keys(args).some(k=>!['id','expectedVersion','kind','text','sources','ttlDays'].includes(k))
        || !['interest','experience','intention'].includes(args.kind)||typeof args.text!=='string'||!args.text.trim()||args.text.length>1200
        || !Number.isInteger(args.ttlDays)||args.ttlDays<1||args.ttlDays>90
        || !Array.isArray(args.sources)||!args.sources.length||args.sources.length>8||new Set(args.sources).size!==args.sources.length
        || args.sources.some(s=>typeof s!=='string'||!knownSources.has(s))) throw error('invalid_self_record');
      return store.transaction(()=>{
        const row=args.id?store.db.prepare('SELECT * FROM proactive_record WHERE id=? AND scope=?').get(args.id,scope):undefined;
        if (args.id && (!row||row.deleted||row.version!==args.expectedVersion||(!owner&&row.generation!==generation))) throw error('wake_record_conflict');
        if (!args.id && args.expectedVersion!==undefined) throw error('invalid_self_record');
        if (!args.id && store.db.prepare('SELECT COUNT(*) AS n FROM proactive_record WHERE scope=? AND deleted=0 AND generation=? AND expires>?').get(scope,generation,at).n>=200) throw error('wake_record_capacity');
        const id=row?.id??randomUUID(),version=(row?.version??0)+1;
        store.db.prepare(`INSERT INTO proactive_record VALUES(?,?,?,?,?,?,?,?,?,0)
          ON CONFLICT(id) DO UPDATE SET version=excluded.version,generation=excluded.generation,kind=excluded.kind,
          text=excluded.text,sources=excluded.sources,updated=excluded.updated,expires=excluded.expires,deleted=0`)
          .run(id,scope,version,generation,args.kind,args.text.trim(),JSON.stringify(args.sources),at,at+args.ttlDays*86400000);
        return view(store.db.prepare('SELECT * FROM proactive_record WHERE id=?').get(id));
      });
    },
    remove({id,expectedVersion}) {
      return store.transaction(()=>{
        const row=store.db.prepare('SELECT * FROM proactive_record WHERE id=? AND scope=?').get(id,scope);
        if (!row||row.deleted||row.version!==expectedVersion) throw error('wake_record_conflict');
        store.db.prepare('UPDATE proactive_record SET version=version+1,text=NULL,sources=NULL,deleted=1,updated=? WHERE id=?').run(time(now()),id);
        return {id,version:row.version+1,deleted:true};
      });
    },
  };
}
