// Document 29 domain orchestration: provenance, derived records, masks, retrieval and cursors.
// Host input is read-only; transport authorization remains in plugin.js.
import {randomBytes} from 'node:crypto';
import {readHostRecords,messageText} from '../../../packages/session-records/index.js';
import {redactText} from '../../../packages/observability/index.js';
import {digest,canonical,validateState,factDigest,safeText} from '../continuity/model.js';
import {normalize} from '../model.js';
import {RecordStore} from './store.js';
import {recordText as text} from './policy.js';
const fail=code=>Object.assign(Error(code),{code});
const stamp=()=>new Date().toISOString();
const id=()=>randomBytes(6).toString('hex');
const validId=v=>typeof v==='string' && /^[a-f0-9]{12,64}$/.test(v);
const time=v=>typeof v==='string' && Number.isFinite(Date.parse(v));
const localTools = new Set(['personal_weather_get_brief','personal_profile_state_get','personal_planning_state_get','personal_reminder_state_get','personal_reminder_list_get','personal_reminder_list_manage','knowledge_bills_get','knowledge_bill_add','knowledge_bill_manage','kurumi_memory','kurumi_code']);
function hostOrigin(record) {
  // Host user envelopes can also contain forwarded/tool-projected data. Only the trusted ingress hook
  // (appendIngress below) may mint owner_said. Unknown tools and user-like envelopes fail external.
  const message = record.message ?? {};
  if (message.role === 'assistant') return 'she_said';
  if (['tool','toolResult'].includes(message.role) && localTools.has(message.toolName ?? message.name)) return 'tool_result';
  return 'external';
}
export class RecordApplication extends RecordStore {
  appendIngress(request) {
    if (request.ownerId !== this.ownerId || request.sessionKey !== `agent:main:kurumi-qq:direct:${this.ownerId}` || !request.messageId || !request.sessionId || !request.runId
      || typeof request.raw !== 'string' || request.raw.length > 2000 || !Number.isFinite(request.at)) throw fail('invalid_trusted_memory_ingress');
    const rawId = digest(canonical(['owner-ingress', request.sessionKey, request.messageId, request.raw]));
    return this.appendRaw({rawId, sessionId: request.sessionId, origin: 'owner_said', content: request.raw,
      body: {type: 'trusted_owner_ingress', messageId: request.messageId, raw: request.raw}, at: new Date(request.at).toISOString(), runId: request.runId});
  }
  ingestHost(file) {
    const result = readHostRecords(file, {sessionKey: `agent:main:kurumi-qq:direct:${this.ownerId}`, archives: true});
    return this.atomic(() => {
      for (const row of result.rows) this.appendRaw({rawId: digest(canonical([row.sessionId,row.seq,row.eventHash])), sessionId: row.sessionId, eventSeq: row.seq,
        origin: hostOrigin(row.record), content: messageText(row.record.message?.content), body: row.record, at: new Date(row.createdAt).toISOString(), runId: row.record.__openclaw?.runId ?? null});
      this.rebuild(); return {seen: result.rows.length, retained: this.db.prepare('SELECT count(*) AS n FROM memory_raw').get().n};
    });
  }
  masked(raw) {
    if (!raw) return true;
    const normalized = normalize(raw.text);
    return this.db.prepare('SELECT * FROM memory_masks').all().some(m => m.raw_id === raw.id || m.text_hash === factDigest(raw.text) || (m.needle && normalized.includes(m.needle))
      || (m.raw_id?.startsWith('legacy-before:') && raw.at<=m.raw_id.slice(14) && JSON.parse(raw.body_json).type!=='p2_explicit_evidence'));
  }
  visible(record, seen = new Set()) {
    if (!record || record.state === 'forgotten' || seen.has(record.id)) return false;
    seen = new Set([...seen, record.id]);
    return record.sources.every(s => s.rawId ? !this.masked(this.raw(s.rawId)) : this.visible(this.record(s.recordId), seen));
  }
  external(record,seen=new Set()) {
    if(!record || seen.has(record.id))return false;
    if(record.external)return true;seen=new Set([...seen,record.id]);
    return record.sources.some(s=>s.rawId?this.raw(s.rawId)?.origin==='external':this.external(this.record(s.recordId),seen));
  }
  provenance(sources, recordId, maximum=100) {
    if (!Array.isArray(sources) || !sources.length || sources.length > maximum) throw fail('memory_sources_required');
    let external = false;
    const reaches = (value, seen = new Set()) => value && (value.id === recordId || (!seen.has(value.id) && value.sources.some(s => s.recordId && reaches(this.record(s.recordId), new Set([...seen,value.id])))));
    for (const source of sources) {
      if (!source || Object.keys(source).length !== 1 || !(validId(source.rawId) || validId(source.recordId))) throw fail('invalid_memory_source');
      if (source.rawId) {const raw = this.raw(source.rawId); if (!raw || this.masked(raw)) throw fail('memory_source_unavailable'); external ||= raw.origin === 'external';}
      else {const record = this.record(source.recordId); if (!this.visible(record) || reaches(record)) throw fail('memory_source_unavailable'); external ||= this.external(record);}
    }
    return external;
  }
  put(input, {expectedVersion = 0, actor = 'chat', runId, program = false} = {}) {
    const old = input.id ? this.record(input.id) : null;
    if (!Number.isSafeInteger(expectedVersion) || (old?.version ?? 0) !== expectedVersion || (input.id && !old)) throw fail('memory_version_conflict');
    if (old?.state === 'forgotten') throw fail('forgotten_memory_requires_explicit_remember');
    const kind = input.kind ?? old?.kind, about = input.about ?? old?.about, basis = input.basis ?? old?.basis;
    if(old && (kind!==old.kind || about!==old.about))throw fail('memory_record_identity_changed');
    if (typeof kind !== 'string' || !/^[a-z][a-z0-9_-]{0,39}$/.test(kind) || !['owner','self'].includes(about) || !['stated','inferred','observed','self'].includes(basis)) throw fail('invalid_memory_record');
    if ((kind === 'fact' && (about !== 'owner' || basis !== 'stated')) || (kind === 'inference' && (about !== 'owner' || basis !== 'inferred'))
      || (kind === 'note' && (about !== 'self' || basis !== 'self')) || (kind === 'rhythm' && (!program || about !== 'owner' || basis !== 'observed'))) throw fail('invalid_memory_record_kind');
    const value = text(input.text), sources = input.sources ?? old?.sources, external = this.provenance(sources, old?.id,program?Number.MAX_SAFE_INTEGER:100);
    if (kind === 'fact' && !sources.some(s => {const raw = s.rawId && this.raw(s.rawId); return raw?.origin === 'owner_said' && raw.text.includes(value);})) throw fail('fact_requires_exact_owner_source');
    const attrs = input.attrs ?? old?.attrs ?? {};
    if (!attrs || Array.isArray(attrs) || typeof attrs !== 'object' || JSON.stringify(attrs).length > 12000 || (attrs.due && !time(attrs.due))) throw fail('invalid_memory_attributes');
    const validFrom = input.valid_from ?? old?.valid_from ?? stamp(); if (!time(validFrom)) throw fail('invalid_memory_time');
    const record = {id: old?.id ?? id(), version: expectedVersion + 1, kind, about, basis, text: value, sources,
      attrs, valid_from: validFrom, recorded_at: stamp(), state: 'active', external: external || Boolean(old?.external)};
    let p2;
    if (kind==='fact') {
      safeText(value,300);if(attrs.legacyKind!==undefined && !['fact','preference'].includes(attrs.legacyKind))throw fail('invalid_memory_record_kind');
      if(!old && this.db.prepare("SELECT count(*) AS n FROM memory_records WHERE state='active' AND kind='fact'").get().n>=128)throw fail('personal_fact_limit');
      const raw=this.raw(sources.find(s=>s.rawId && this.raw(s.rawId)?.origin==='owner_said' && this.raw(s.rawId).text.includes(value)).rawId);
      p2={id:record.id,text:value,kind:attrs.legacyKind??'fact',createdAt:old?.valid_from??record.valid_from,updatedAt:record.recorded_at,
        source:{origin:'current_owner',messageId:raw.body.messageId??'raw:'+raw.id.slice(0,32),sessionKey:`agent:main:kurumi-qq:direct:${this.ownerId}`,sessionId:raw.session_id,runId:raw.run_id??runId,at:raw.at,rawHash:digest(raw.text),evidence:value}};
    }
    return this.saveRecord(record, {actor,runId,p2});
  }
  write(input, context) {return this.atomic(() => {const result = this.put(input, context); this.bump(); this.rebuild(); return result;});}
  revise(recordId, {action, expectedVersion, text: value, find, replacement, sources, attrs}, context) {
    return this.atomic(() => {
      const old = this.record(recordId);
      if (!old || !this.visible(old) || old.version !== expectedVersion || old.state !== 'active') throw fail('memory_version_conflict');
      if(old.kind==='rhythm')throw fail('program_memory_readonly');
      let result;
      if (action === 'retract') result = this.saveRecord({...old,version:old.version+1,state:'retracted',recorded_at:stamp()},context);
      else {
        if (action === 'append') value = old.text + '\n' + text(value);
        else if (action === 'replace') {if (!find || typeof replacement !== 'string' || old.text.split(find).length !== 2) throw fail('memory_replace_requires_unique_span'); value = old.text.replace(find,replacement);}
        else if (action !== 'rewrite') throw fail('invalid_memory_revision');
        result = this.put({...old,text:value,sources:sources ?? old.sources,attrs:attrs ?? old.attrs},{...context,expectedVersion});
      }
      this.bump(); this.rebuild(); return result;
    });
  }
  supersede(recordId, expectedVersion, replacement, context) {
    return this.atomic(() => {
      const old = this.record(recordId); if (!old || !this.visible(old) || old.state !== 'active' || old.version !== expectedVersion) throw fail('memory_version_conflict');
      if(old.kind==='rhythm')throw fail('program_memory_readonly');
      this.saveRecord({...old,version:old.version+1,state:'superseded',recorded_at:stamp()},context);
      const result = this.put(replacement,{...context,expectedVersion:0}); this.bump(); this.rebuild(); return result;
    });
  }
  forgetInternal(ids, context) {
    const selected = ids.map(recordId => this.record(recordId));
    if (!selected.length || selected.some(r => !r)) throw fail('unknown_memory_record');
    const affected = new Set(ids), raws = new Set();
    function collect(store, record, seen = new Set()) {if (seen.has(record.id)) return; seen.add(record.id); for (const s of record.sources) if (s.rawId) raws.add(s.rawId); else collect(store, store.record(s.recordId), seen);}
    for (const r of selected) collect(this,r);
    const all = this.records(); let changed = true;
    while (changed) {changed = false; for (const r of all) if (!affected.has(r.id) && r.sources.some(s => s.recordId && affected.has(s.recordId) || s.rawId && raws.has(s.rawId))) {affected.add(r.id); changed = true;}}
    for (const r of selected) {
      const group=factDigest(r.text), ownRaw=new Set();
      function collectOwn(store,record,seen=new Set()){if(!record || seen.has(record.id))return;seen.add(record.id);for(const s of record.sources)if(s.rawId)ownRaw.add(s.rawId);else collectOwn(store,store.record(s.recordId),seen);}
      collectOwn(this,r);
      for(const rawId of ownRaw)this.db.prepare('INSERT OR IGNORE INTO memory_masks VALUES(?,?,?,?,?)').run(digest('raw:'+rawId+group),rawId,null,null,group);
      this.db.prepare('INSERT OR IGNORE INTO memory_masks VALUES(?,?,?,?,?)').run(digest('text:'+group),null,group,normalize(r.text),group);
    }
    for(const r of all)if(!this.visible(r))affected.add(r.id);
    for (const r of all.filter(r => affected.has(r.id) && r.state !== 'forgotten')) this.saveRecord({...r,version:r.version+1,state:'forgotten',recorded_at:stamp()},context);
    const aux = this.aux(); aux.generation++; aux.summaries = []; this.saveAux(aux); return [...affected];
  }
  forget(ids, context) {return this.atomic(() => {const result = this.forgetInternal(ids,context); this.bump(); this.rebuild(); return {ids:result};});}
  get(recordId) {const record = this.record(recordId); return this.visible(record) ? {...record,external:this.external(record)} : null;}
  history(recordId) {return this.get(recordId) ? this.db.prepare('SELECT body_json,actor,run_id,at FROM memory_versions WHERE id=? ORDER BY version').all(recordId).map(row => ({...JSON.parse(row.body_json),actor:row.actor,runId:row.run_id,at:row.at})).filter(row=>this.visible(row)) : [];}
  rebuild() {
    this.db.exec('DELETE FROM memory_record_fts; DELETE FROM memory_raw_fts;');
    for (const r of this.records()) if (this.visible(r)) this.db.prepare('INSERT INTO memory_record_fts VALUES(?,?)').run(r.id,r.text);
    for (const r of this.rawRows()) if (!this.masked(r)) this.db.prepare('INSERT INTO memory_raw_fts VALUES(?,?)').run(r.id,r.text);
  }
  search(query = '', {kind, from, to, limit = 20, history = false} = {}) {
    if (typeof query !== 'string' || query.length > 300 || !Number.isInteger(limit) || limit < 1 || limit > 50) throw fail('invalid_memory_query');
    const q = query.trim(), ids = q.length >= 3 ? new Set(this.db.prepare('SELECT id FROM memory_record_fts WHERE memory_record_fts MATCH ?').all('"'+q.replaceAll('"','""')+'"').map(r=>r.id)) : null;
    return this.records().filter(r => this.visible(r) && (history || r.state === 'active') && (!kind || r.kind === kind) && (!from || r.valid_from >= from) && (!to || r.valid_from <= to)
      && (!q || (ids ? ids.has(r.id) : normalize(r.text).includes(normalize(q))))).sort((a,b)=>b.recorded_at.localeCompare(a.recorded_at)).slice(0,limit).map(r=>({...r,external:this.external(r)}));
  }
  searchRaw(query, {from, to, limit = 20} = {}) {
    if (typeof query !== 'string' || !query.trim() || query.length > 300 || !Number.isInteger(limit) || limit < 1 || limit > 50) throw fail('invalid_memory_query');
    const q = query.trim(), ids = q.length >= 3 ? new Set(this.db.prepare('SELECT id FROM memory_raw_fts WHERE memory_raw_fts MATCH ?').all('"'+q.replaceAll('"','""')+'"').map(r=>r.id)) : null;
    return this.rawRows().filter(r => !this.masked(r) && (!from || r.at >= from) && (!to || r.at <= to) && (ids ? ids.has(r.id) : normalize(r.text).includes(normalize(q)))).slice(-limit).map(r => this.presentRaw(r));
  }
  presentRaw(row) {return {rawId:row.id,sessionId:row.session_id,eventSeq:row.event_seq,origin:row.origin,at:row.at,runId:row.run_id,text:redactText(row.text)};}
  around(rawId, radius = 2) {
    const row = this.raw(rawId); if (!row || this.masked(row) || !Number.isInteger(radius) || radius < 0 || radius > 10) return [];
    const rows = this.rawRows().filter(r=>r.session_id===row.session_id), index = rows.findIndex(r=>r.id===rawId);
    return rows.slice(Math.max(0,index-radius),index+radius+1).filter(r=>!this.masked(r)).map(r=>this.presentRaw(r));
  }
  context(raw, maxContextChars = 6000) {
    const active = this.records().filter(r=>r.state==='active' && this.visible(r));
    const groups = [active.filter(r=>r.kind==='portrait' && r.about==='self'),active.filter(r=>r.kind==='portrait' && r.about==='owner'),
      active.filter(r=>r.kind==='thread').sort((a,b)=>(a.attrs.due??'9999').localeCompare(b.attrs.due??'9999'))];
    const topics = new Map(); for (const r of active.filter(r=>r.kind==='episode')) for (const tag of Array.isArray(r.attrs.topics)?r.attrs.topics:[]) if (typeof tag==='string') {const old=topics.get(tag); topics.set(tag,{topic:tag,count:(old?.count??0)+1,recent:old?.recent>r.valid_from?old.recent:r.valid_from});}
    groups.push([...topics.values()].map(v=>({kind:'topic',...v})),active.filter(r=>r.kind==='rhythm'));
    const terms=[...normalize(raw).matchAll(/[a-z0-9]{2,}|[\p{Script=Han}]{2}/gu)].map(m=>m[0]);
    const relevant=active.filter(r=>['fact','inference','note','episode'].includes(r.kind)).map(r=>({r,score:terms.reduce((n,t)=>n+Number(normalize(r.text).includes(t)),0)}));
    groups.push(relevant.filter(v=>v.score>0 || !active.some(r=>r.kind==='portrait') && v.r.kind==='fact').sort((a,b)=>b.score-a.score || b.r.recorded_at.localeCompare(a.r.recorded_at)).map(v=>v.r));
    const result={revision:this.aux().revision,generation:this.aux().generation,records:[]}; let used=JSON.stringify(result).length;
    for (const group of groups) for (const r of group) {const value=r.id?{id:r.id,version:r.version,kind:r.kind,about:r.about,basis:r.basis,text:r.text,external:this.external(r),...(r.attrs.due?{due:r.attrs.due}:{})}:r;const size=JSON.stringify(value).length+2;if(used+size<=maxContextChars){result.records.push(value);used+=size;}}
    return result;
  }
  updateRhythm() {
    const rows=this.rawRows().filter(r=>r.origin==='owner_said' && JSON.parse(r.body_json).type==='trusted_owner_ingress' && !this.masked(r));
    if(!rows.length)return null;
    const hourly=Array(24).fill(0),days={};const format=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'});
    for(const row of rows){const parts=Object.fromEntries(format.formatToParts(new Date(row.at)).map(p=>[p.type,p.value]));hourly[Number(parts.hour)]++;const day=parts.year+'-'+parts.month+'-'+parts.day;days[day]=(days[day]??0)+1;}
    const attrs={timezone:'Asia/Shanghai',messages:rows.length,hourly,days,from:rows[0].at,to:rows.at(-1).at},old=this.records().find(r=>r.kind==='rhythm' && r.state==='active');
    if(old && canonical(old.attrs)===canonical(attrs))return old;
    // Mechanical statistics use their own record version, not the fact-command revision captured
    // by the parallel P2 prompt hook. No personality/sleep interpretation is inferred here.
    return this.atomic(()=>{const result=this.put({...(old?{id:old.id}:{}),kind:'rhythm',about:'owner',basis:'observed',text:`已记录${rows.length}条主人可信私聊；上海时间小时分布：${hourly.map((n,h)=>n?h+'时='+n:null).filter(Boolean).join('，')}`,attrs,sources:rows.map(r=>({rawId:r.id}))},{runId:'mechanical-rhythm',actor:'program',program:true,expectedVersion:old?.version??0});this.rebuild();return result;});
  }
  nextBatch({name='main',limit=50,runId}) {
    if (!runId || !Number.isInteger(limit) || limit<1 || limit>100 || !/^[a-z][a-z0-9_-]{0,39}$/.test(name)) throw fail('invalid_memory_batch');
    return this.atomic(()=>{
      const cursor=this.db.prepare('SELECT * FROM memory_cursors WHERE name=?').get(name)??{after_seq:0,version:0};
      const rows=this.db.prepare('SELECT * FROM memory_raw WHERE seq>? ORDER BY seq LIMIT ?').all(cursor.after_seq,limit),visible=rows.filter(r=>!this.masked(r));
      if(!rows.length)return {done:true,cursorVersion:cursor.version,entries:[]};
      const batchId=id();this.db.prepare('INSERT INTO memory_batches VALUES(?,?,?,?,?,?,?,?,?)').run(batchId,name,cursor.version,cursor.after_seq,rows.at(-1).seq,JSON.stringify(visible.map(r=>r.id)),runId,this.aux().generation,'pending');
      return {done:false,batchId,cursorVersion:cursor.version,entries:visible.map(r=>this.presentRaw(r))};
    });
  }
  commitBatch(batchId, commands, context) {
    return this.atomic(()=>{
      const batch=this.db.prepare('SELECT * FROM memory_batches WHERE id=?').get(batchId),aux=this.aux();
      if(!batch || batch.state!=='pending' || batch.run_id!==context.runId || batch.generation!==aux.generation)throw fail('memory_batch_stale');
      const cursor=this.db.prepare('SELECT * FROM memory_cursors WHERE name=?').get(batch.cursor_name)??{after_seq:0,version:0};
      if(cursor.version!==batch.cursor_version || cursor.after_seq!==batch.after_seq)throw fail('memory_cursor_conflict');
      if(!Array.isArray(commands) || commands.length>100)throw fail('invalid_memory_batch');
      const allowed=new Set(JSON.parse(batch.raw_ids_json)),results=[];
      for(const command of commands){if(!command.sources?.every(s=>s.recordId || allowed.has(s.rawId)))throw fail('memory_source_outside_batch');results.push(this.put(command,{...context,actor:'organizer',expectedVersion:command.expectedVersion??0}));}
      this.db.prepare('INSERT INTO memory_cursors VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET after_seq=excluded.after_seq,version=excluded.version').run(batch.cursor_name,batch.through_seq,cursor.version+1);
      this.db.prepare("UPDATE memory_batches SET state='committed' WHERE id=?").run(batchId);this.bump();this.rebuild();return {ok:true,records:results,cursorVersion:cursor.version+1};
    });
  }
}


// Compatibility adapter keeps the existing observe/upsert/delete policy and transaction contract.
// The facts live in versioned rows; aux stores only receipts, summaries, generation and barriers.
export function seedP2(store, state) {
  // Legacy barriers contain hashes only; their old texts cannot be reconstructed. Conservatively
  // mask pre-barrier host history, while retaining explicitly active P2 facts and their own evidence.
  for(const barrier of state.barriers)store.db.prepare('INSERT INTO memory_masks VALUES(?,?,?,?,?)').run(digest('legacy:'+barrier.hash),'legacy-before:'+barrier.at,barrier.hash,null,barrier.hash);
  for (const entry of state.facts) {
    const rawId=digest(canonical(['p2-source',entry.source]));
    store.appendRaw({rawId,sessionId:entry.source.sessionId,origin:'owner_said',body:{type:'p2_explicit_evidence',source:entry.source},content:entry.source.evidence,at:entry.source.at,runId:entry.source.runId});
    store.saveRecord({id:entry.id,version:1,kind:'fact',about:'owner',basis:'stated',text:entry.text,sources:[{rawId}],attrs:{legacyKind:entry.kind},
      valid_from:entry.createdAt,recorded_at:entry.updatedAt,state:'active',external:false},{actor:'migration',runId:'p2-to-v3',p2:entry});
  }
}
export function openRecordContinuityStore(location) {
  const store=new RecordApplication(location);
  const read=()=>{
    const aux=store.aux(),facts=store.db.prepare("SELECT id,p2_json FROM memory_records WHERE state='active' AND kind='fact' AND p2_json IS NOT NULL ORDER BY rowid").all().filter(r=>store.visible(store.record(r.id))).map(r=>JSON.parse(r.p2_json));
    return validateState({...aux,facts},location.ownerId);
  };
  return {read,write(data,expectedRevision){return store.atomic(()=>{
    const before=read(); if(before.revision!==expectedRevision)throw Error('记忆已改变，请重新读取revision后重试');
    const next=validateState({...data,revision:before.revision+1},location.ownerId),byId=new Map(next.facts.map(r=>[r.id,r]));
    if(next.generation<before.generation || next.ownerId!==before.ownerId)throw fail('invalid_memory_generation');
    const removed=before.facts.filter(r=>!byId.has(r.id));
    if(removed.length)store.forgetInternal(removed.map(r=>r.id),{actor:'owner-forget',runId:next.receipts.at(-1)?.messageId??'p2-delete'});
    for(const entry of next.facts){
      const old=store.record(entry.id),prior=before.facts.find(r=>r.id===entry.id);
      if(prior && canonical(prior)===canonical(entry))continue;
      // The existing policy has already required a fresh explicit remember for upsert and suppressed observe barriers.
      const receipt=next.receipts.at(-1),explicit=receipt?.result.action==='upsert';
      if(explicit)store.db.prepare('DELETE FROM memory_masks WHERE group_hash=?').run(factDigest(entry.text));
      const rawId=digest(canonical(['p2-source',entry.source]));
      store.appendRaw({rawId,sessionId:entry.source.sessionId,origin:'owner_said',body:{type:'p2_explicit_evidence',source:entry.source},content:entry.source.evidence,at:entry.source.at,runId:entry.source.runId});
      if(store.masked(store.raw(rawId)))throw fail('forgotten_memory_requires_explicit_remember');
      store.saveRecord({id:entry.id,version:(old?.version??0)+1,kind:'fact',about:'owner',basis:'stated',text:entry.text,sources:[{rawId}],attrs:{legacyKind:entry.kind},
        valid_from:entry.createdAt,recorded_at:entry.updatedAt,state:'active',external:old?.external??false},{actor:'p2-current-owner',runId:entry.source.runId,p2:entry});
      if(prior && factDigest(prior.text)!==factDigest(entry.text)){
        const group=factDigest(prior.text);store.db.prepare('INSERT OR IGNORE INTO memory_masks VALUES(?,?,?,?,?)').run(digest('text:'+group),null,group,normalize(prior.text),group);
      }
    }
    const {facts:ignored,...aux}=next;store.saveAux(aux);store.rebuild();return next;
  });},close(){store.close();}};
}
