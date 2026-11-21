import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {Ledger} from '../../packages/qq-delivery/ledger.js';
import {privateTextFeedback} from '../../packages/qq-delivery/private-text-feedback.js';
import {LogQueryService} from '../../plugins/kurumi-logs/service.js';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const base = Date.parse('2026-11-10T01:00:00.000Z');

test('QQ evidence separates a missing receipt, unreadable source, window gap, adjacent warning and rejection', async t => {
  const root = mkdtempSync(join(tmpdir(),'kurumi-qq-evidence-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const file = join(root,'state/access-admin/changes.sqlite');
  mkdirSync(dirname(file),{recursive:true});
  const db = new DatabaseSync(file);
  const seconds = base/1000;
  db.exec(`
    CREATE TABLE access_changes(id,owner_qq,plan,state,updated_at,error);
    CREATE TABLE confirmation_proposals(proposal_id,domain,subject_id,payload_hash,created_at_utc,action_kind);
    CREATE TABLE confirmation_previews(proposal_id,payload_hash,source_message_id,presentation_message_id,presented_at_utc);
    CREATE TABLE approval_grants(grant_id,proposal_id,domain,subject_id,payload_hash,confirmation_message_id,issued_at_utc,status,consumed_at_utc);
  `);
  db.prepare('INSERT INTO access_changes VALUES(?,?,?,?,?,?)').run('proposal','100001','{"baseRevision":1}','written',seconds+1,null);
  db.prepare('INSERT INTO confirmation_proposals VALUES(?,?,?,?,?,?)').run('proposal','access','owner','hash',seconds-20,'member.add');
  db.prepare('INSERT INTO confirmation_previews VALUES(?,?,?,?,?)').run('proposal','hash','101','281',seconds-19);
  const grant = db.prepare('INSERT INTO approval_grants VALUES(?,?,?,?,?,?,?,?,?)');
  grant.run('earlier','proposal','access','owner','hash','102',seconds,'expired',null);
  grant.run('final','proposal','access','owner','hash','103',seconds+1,'consumed',seconds+1);
  db.close();
  const ledger = new Ledger(join(root,'channel'));
  privateTextFeedback(ledger.db,{selfId:'100002',peer:'100001',sourceMessage:'103'}).plan('reply',1);
  ledger.reserve('reply:0');
  ledger.failed('reply:0');
  ledger.db.prepare('UPDATE qq_reply_parts SET planned_at=?').run(base+1100);
  ledger.db.prepare('UPDATE outbound SET at=?').run(base+1100);
  ledger.close();
  writeFileSync(join(root,'runtime.log'), JSON.stringify({time:new Date(base+1500).toISOString(),
    0:'unrelated-worker',1:'SYNTHETIC_NEARBY_WARNING',_meta:{logLevelName:'WARN'}})+'\n');

  const service = new LogQueryService({backendRoot:repo,runtimeRoot:root,snowlumaRoot:root},{now:()=>base+60_000});
  const args = {view:'qq-evidence',messageId:'103',from:new Date(base).toISOString(),to:new Date(base+10_000).toISOString()};
  const query = overrides => service.query({...args,...overrides},{ownerId:'100001'});
  const channelFile = join(root,'channel/channel.sqlite');
  const sourceBefore = readFileSync(file), ledgerBefore = readFileSync(channelFile);
  const result = await query();
  assert.equal(result.selection.status,'recorded');
  const [item] = result.items;
  assert.equal(item.preview.coverage,'outside_window');
  assert.equal(item.write.status,'written');
  assert.equal(item.replies[0].platformStatus,'rejected');
  assert.deepEqual(item.replyCoverage.map(row=>row.status),['outside_window','no_record','recorded']);
  assert.equal(result.context.length,1);
  assert.equal(result.context[0].association,'time_adjacent');
  assert(!JSON.stringify(item).includes('unrelated-worker'));
  assert.deepEqual(await query(),result);
  assert.deepEqual(readFileSync(file),sourceBefore);
  assert.deepEqual(readFileSync(channelFile),ledgerBefore);

  writeFileSync(channelFile,'unreadable SQLite fixture');
  const broken = await query();
  assert(broken.sourceStatus.some(row=>row.source==='channel-delivery'&&row.status==='read_failed'));
  assert.deepEqual(broken.items[0].replyCoverage.map(row=>row.status),['outside_window','source_unavailable','source_unavailable']);
  assert.equal(broken.items[0].write.status,'written');
});
