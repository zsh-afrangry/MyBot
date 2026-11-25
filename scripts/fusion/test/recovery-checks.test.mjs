import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {carryDisabledHeartbeat,expectedAfterHeartbeatMigration,clearCopiedGatewayLeases,snapshotCodingActivity,snapshotCronDefinitions,verifyCronMigration,verifyCronProbe} from '../lib/recovery-checks.mjs';

const tmp=()=>fs.mkdtempSync('/tmp/kurumi-recovery-checks-');

test('upgrade carries only the known disabled heartbeat and retains unrelated protected settings',()=>{
 const previous={agents:{defaults:{heartbeat:{every:'0m',agentId:'main'}},entries:{main:{}}}};
 const intent={agents:{defaults:{model:'fixture'},entries:{main:{tools:{deny:['read']}}}}};
 assert.equal(carryDisabledHeartbeat(intent,previous),true);
 assert.deepEqual(intent.agents.defaults.heartbeat,previous.agents.defaults.heartbeat);
 const expected=expectedAfterHeartbeatMigration(intent);
 assert.equal(expected.agents.defaults.heartbeat,undefined);
 assert.deepEqual(expected.agents.entries.main.tools,{deny:['read']});
 assert.deepEqual(intent.agents.defaults.heartbeat,previous.agents.defaults.heartbeat);
 for(const heartbeat of [{every:'30m'},{every:'0m',agentId:'main',target:'last'},{every:'0m',agentId:'member'}]){
  assert.throws(()=>carryDisabledHeartbeat(structuredClone(expected),{agents:{defaults:{heartbeat}}}),/heartbeat/i);
 }
 assert.throws(()=>carryDisabledHeartbeat(structuredClone(expected),{agents:{entries:{member:{heartbeat:{every:'0m'}}}}}),/heartbeat/i);
});

test('lease cleanup changes only the gateway and agent leases in a contained state DB',()=>{
 const dir=tmp(),file=dir+'/runtime/state/openclaw.sqlite';fs.mkdirSync(path.dirname(file),{recursive:true});
 try{
  const db=new DatabaseSync(file);db.exec("CREATE TABLE state_leases(scope TEXT); INSERT INTO state_leases VALUES ('gateway-owner'),('other'); CREATE TABLE agent_database_leases(id TEXT); INSERT INTO agent_database_leases VALUES ('stale');");db.close();
  assert.deepEqual(clearCopiedGatewayLeases(dir),{gateway:1,agent:1});
  const check=new DatabaseSync(file,{readOnly:true});assert.equal(check.prepare('SELECT count(*) n FROM state_leases').get().n,1);assert.equal(check.prepare('SELECT scope FROM state_leases').get().scope,'other');assert.equal(check.prepare('SELECT count(*) n FROM agent_database_leases').get().n,0);check.close();
  const other=tmp();try{fs.mkdirSync(other+'/runtime/state',{recursive:true});fs.symlinkSync(file,other+'/runtime/state/openclaw.sqlite');assert.throws(()=>clearCopiedGatewayLeases(other),/regular/);}finally{fs.rmSync(other,{recursive:true});}
  const linked=tmp();try{fs.mkdirSync(linked+'/runtime/state',{recursive:true});fs.linkSync(file,linked+'/runtime/state/openclaw.sqlite');assert.throws(()=>clearCopiedGatewayLeases(linked),/regular/);}finally{fs.rmSync(linked,{recursive:true});}
 }finally{fs.rmSync(dir,{recursive:true});}
});

test('coding activity detects new rounds and events even when the task count is unchanged',()=>{
 const dir=tmp(),file=dir+'/coding.sqlite';
 try{
  const db=new DatabaseSync(file);db.exec("CREATE TABLE coding_tasks(id TEXT,facts TEXT); CREATE TABLE coding_results(task_id TEXT,round_id TEXT,facts TEXT); CREATE TABLE coding_result_events(task_id TEXT,round_id TEXT,seq INTEGER,facts TEXT); INSERT INTO coding_tasks VALUES ('task','{\"state\":\"running\",\"executionRoundId\":\"r1\"}'); INSERT INTO coding_results VALUES ('task','r1','{}');");
  const before=snapshotCodingActivity(file);
  db.prepare('UPDATE coding_tasks SET facts=?').run(JSON.stringify({state:'needs_reconciliation',executionRoundId:'r1'}));
  assert.deepEqual(snapshotCodingActivity(file),before);
  db.exec("INSERT INTO coding_result_events VALUES ('task','r1',1,'{}');");assert.notDeepEqual(snapshotCodingActivity(file),before);
  db.exec("DELETE FROM coding_result_events; INSERT INTO coding_results VALUES ('task','r2','{}');");assert.notDeepEqual(snapshotCodingActivity(file),before);db.close();
 }finally{fs.rmSync(dir,{recursive:true});}
});

test('upgrade preserves ordinary cron definitions and only adds disabled jobs',()=>{
 const dir=tmp(),file=dir+'/state.sqlite';
 try{
  const db=new DatabaseSync(file);db.exec('CREATE TABLE cron_jobs(store_key TEXT,job_id TEXT,enabled INTEGER,payload_kind TEXT,job_json TEXT)');
  const insert=db.prepare('INSERT INTO cron_jobs VALUES (?,?,?,?,?)');
  insert.run('s','ordinary',1,'command',JSON.stringify({schedule:{kind:'every',everyMs:60000},payload:{kind:'command'},state:{nextRunAtMs:1}}));
  insert.run('s','heartbeat',0,'heartbeat',JSON.stringify({payload:{kind:'heartbeat'}}));
  const before=snapshotCronDefinitions(file);
  db.prepare('UPDATE cron_jobs SET payload_kind=?,job_json=? WHERE job_id=?').run('agentTurn',JSON.stringify({payload:{kind:'agentTurn'}}),'heartbeat');
  insert.run('s','new-disabled',0,'agentTurn',JSON.stringify({payload:{kind:'agentTurn'}}));
  assert.equal(verifyCronMigration(before,snapshotCronDefinitions(file)),true);
  db.prepare('UPDATE cron_jobs SET enabled=1 WHERE job_id=?').run('heartbeat');assert.equal(verifyCronMigration(before,snapshotCronDefinitions(file)),false);
  db.prepare('UPDATE cron_jobs SET enabled=0 WHERE job_id=?').run('heartbeat');
  db.prepare('UPDATE cron_jobs SET enabled=1 WHERE job_id=?').run('new-disabled');assert.equal(verifyCronMigration(before,snapshotCronDefinitions(file)),false);
  db.prepare('UPDATE cron_jobs SET enabled=0 WHERE job_id=?').run('new-disabled');
  db.prepare('UPDATE cron_jobs SET job_json=? WHERE job_id=?').run(JSON.stringify({schedule:{kind:'every',everyMs:1},payload:{kind:'command'}}),'ordinary');
  assert.equal(verifyCronMigration(before,snapshotCronDefinitions(file)),false);db.close();
 }finally{fs.rmSync(dir,{recursive:true});}
});

test('only the matching disabled legacy heartbeat can appear in the relocated probe store',()=>{
 const definition={id:'one',createdAtMs:1,agentId:'main',declarationKey:'heartbeat:main',enabled:false,
   schedule:{kind:'every',everyMs:1800000},payload:{kind:'heartbeat'}};
 const original={id:'one',store:'/original/cron/jobs.json',kind:'heartbeat',enabled:0,definition};
 const isolatedStore='/tmp/restored/cron/jobs.json';
 const copy={...original,id:'two',store:isolatedStore,definition:{...definition,id:'two',createdAtMs:2}};
 const options={legacyHeartbeat:{every:'0m',agentId:'main'},isolatedStore};
 assert(verifyCronProbe([original],[copy,original],options));
 assert(!verifyCronProbe([original],[copy,original],{isolatedStore}));
 assert(!verifyCronProbe([original],[copy,original],{...options,legacyHeartbeat:{every:'10m'}}));
 assert(!verifyCronProbe([original],[{...copy,enabled:1},original],options));
 assert(!verifyCronProbe([original],[{...copy,store:'/elsewhere'},original],options));
 assert(!verifyCronProbe([original],[{...copy,definition:{...copy.definition,schedule:{everyMs:5000}}},original],options));
 assert(!verifyCronProbe([original],[copy,{...original,enabled:1}],options));
});
