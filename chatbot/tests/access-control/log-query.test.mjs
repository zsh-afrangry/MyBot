// Offline unified-query contract for authorization audit; synthetic events and temporary state only. docs/24 T02/T10.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createTraceSink} from '../../packages/observability/index.js';
import {collectEvents,filterEvents,formatEvent} from '../../../scripts/fusion/log-query.mjs';

test('Authorization audit joins by real run and shows decision/reason without tool parameters', t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'kurumi-access-query-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const at=Date.parse('2026-10-19T12:00:00+08:00');
  createTraceSink(path.join(root,'channel/access-events.jsonl')).emit({at,source:'access-control',kind:'access.tool',
    correlation:{runId:'synthetic-run',toolCallId:'synthetic-call',sessionKey:'agent:qq-user-100001:kurumi-qq:direct:100001'},
    data:{subjectId:'100001',tool:'email_send',permission:'mail.send',revision:1,decision:'deny',code:'capability_not_allowed'}});
  const rows=collectEvents({from:at-1,to:at+1,runtimeRoot:root,sources:['access-control']});
  assert.equal(rows.length,1);
  assert.equal(filterEvents(rows,{runId:'synthetic-run'}).length,1);
  assert.match(formatEvent(rows[0]),/email_send mail.send deny capability_not_allowed/);
  assert.deepEqual(rows[0].data,{subjectId:'100001',tool:'email_send',permission:'mail.send',revision:1,decision:'deny',code:'capability_not_allowed'});
  assert.equal(fs.statSync(path.join(root,'channel/access-events.jsonl')).mode&0o077,0);
  assert.equal(collectEvents({from:at+2,to:at+3,runtimeRoot:root,sources:['access-control']}).length,0);
});
