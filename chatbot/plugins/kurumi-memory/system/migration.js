// Explicit, preview-first P2 -> v3 migration. Operator backups are always outside the workspace.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {memoryPaths, openContinuityStore} from '../continuity/store.js';
import {canonical, digest} from '../continuity/model.js';
import {SCHEMA_V3, NOTICE_V3} from './store.js';
import {RecordApplication as RecordStore,seedP2} from './application.js';
const quote = value => "'"+value.replaceAll("'","''")+"'";
const hashBytes=bytes=>createHash('sha256').update(bytes).digest('hex');
function backupDirectory(root, workspace, name) {
  if (!path.isAbsolute(root??'') || fs.realpathSync(root)!==root || root===workspace || root.startsWith(workspace+'/') || fs.statSync(root).mode&0o077) throw Error('Private external backup directory required');
  const dir=path.join(root,name+'-'+randomUUID());fs.mkdirSync(dir,{mode:0o700});return dir;
}
function replace(file,bytes) {const temp=file+'.'+randomUUID()+'.tmp';const fd=fs.openSync(temp,'wx',0o600);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temp,file);const dir=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}}
function sqliteBackup(file,target) {const db=new DatabaseSync(file,{readOnly:true});try{db.exec('VACUUM INTO '+quote(target));fs.chmodSync(target,0o600);}finally{db.close();}}
export function migrateMemoryV3({workspace,ownerId,backupRoot,apply=false,expectedStateHash}) {
  if(!/^\d{5,12}$/.test(ownerId))throw Error('Explicit primary owner required');
  const paths=memoryPaths(workspace),db=new DatabaseSync(paths.file,{readOnly:true});let version;try{version=db.prepare('PRAGMA user_version').get().user_version;}finally{db.close();}
  if(version===3){const store=new RecordStore({workspace,ownerId,requireNotice:false});try{if(apply && fs.readFileSync(paths.notice,'utf8')!==NOTICE_V3)replace(paths.notice,NOTICE_V3);return {ok:true,alreadyMigrated:true,revision:store.aux().revision};}finally{store.close();}}
  const old=openContinuityStore({workspace,ownerId,readonly:true});let state;try{state=old.read();}finally{old.close();}
  const stateHash=digest(canonical(state)),result={ok:true,applied:false,from:2,to:3,stateHash,revision:state.revision,facts:state.facts.length,summaries:state.summaries.length,barriers:state.barriers.length};
  if(!apply)return result;if(expectedStateHash!==stateHash)throw Error('Migration preview changed; require exact expectedStateHash');
  const backup=backupDirectory(backupRoot,workspace,'before-memory-v3');sqliteBackup(paths.file,path.join(backup,'state.sqlite'));
  const notice=fs.readFileSync(paths.notice);fs.writeFileSync(path.join(backup,'MEMORY.md'),notice,{mode:0o600,flag:'wx'});
  fs.writeFileSync(path.join(backup,'migration.json'),JSON.stringify({workspace,ownerId,stateHash,revision:state.revision,sha256:hashBytes(fs.readFileSync(path.join(backup,'state.sqlite'))),noticeHash:hashBytes(notice)}),{mode:0o600,flag:'wx'});
  const write=new DatabaseSync(paths.file);let store;
  try {
    write.exec('PRAGMA synchronous=FULL; BEGIN IMMEDIATE');
    const current=JSON.parse(write.prepare('SELECT state_json FROM memory_state WHERE singleton=1').get().state_json);
    if(digest(canonical(current))!==stateHash)throw Error('Memory changed during migration');
    write.exec(SCHEMA_V3);const {facts:ignored,...aux}=state;write.prepare('INSERT INTO memory_aux VALUES(1,?)').run(JSON.stringify(aux));
    // The transaction owns this connection; use the same methods without opening a second writer.
    store=Object.create(RecordStore.prototype);store.db=write;store.ownerId=ownerId;seedP2(store,state);store.rebuild();
    write.exec('DROP TABLE memory_state; COMMIT');
  } catch(error){try{write.exec('ROLLBACK');}catch{}throw error;} finally {write.close();}
  replace(paths.notice,NOTICE_V3);return {...result,applied:true,backup};
}
export function rollbackMemoryV3({workspace,ownerId,backup,backupRoot,expectedRevision,apply=false}) {
  const paths=memoryPaths(workspace),meta=JSON.parse(fs.readFileSync(path.join(backup,'migration.json'))),bytes=fs.readFileSync(path.join(backup,'state.sqlite')),notice=fs.readFileSync(path.join(backup,'MEMORY.md'));
  if(fs.realpathSync(backup)!==backup || meta.workspace!==workspace || meta.ownerId!==ownerId || hashBytes(bytes)!==meta.sha256 || hashBytes(notice)!==meta.noticeHash)throw Error('Memory rollback material mismatch');
  const store=new RecordStore({workspace,ownerId,readonly:true,requireNotice:false});let revision;try{revision=store.aux().revision;}finally{store.close();}
  const result={ok:true,applied:false,revision,restoredRevision:meta.revision,sourceWritesSinceMigration:revision!==meta.revision};
  if(!apply)return result;if(revision!==expectedRevision)throw Error('Memory changed since rollback preview');
  // Caller must stop writers before migration/rollback. Refuse unresolved WAL, never discard sidecars.
  const write=new DatabaseSync(paths.file);try{write.exec('PRAGMA wal_checkpoint(TRUNCATE)');if(write.prepare('PRAGMA journal_mode=DELETE').get().journal_mode!=='delete')throw Error('Memory writer still active');}finally{write.close();}
  for(const suffix of ['-wal','-shm','-journal'])if(fs.existsSync(paths.file+suffix)&&fs.statSync(paths.file+suffix).size)throw Error('Memory has active sidecar state');
  const saved=backupDirectory(backupRoot,workspace,'before-memory-v3-rollback');sqliteBackup(paths.file,path.join(saved,'state.sqlite'));fs.copyFileSync(paths.notice,path.join(saved,'MEMORY.md'));
  replace(paths.file,bytes);replace(paths.notice,notice);return {...result,applied:true,preservedV3:saved};
}
