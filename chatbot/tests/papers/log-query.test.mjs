// Offline paper trace integration, temporary runtime only. Development owner: docs/22 and docs/18.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {collectEvents,filterEvents} from '../../../scripts/fusion/log-query.mjs';
import {createTraceSink} from '../../../scripts/fusion/lib/trace-events.mjs';
test('Configured paper trace source joins job and QQ message without including credentials',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'kurumi-paper-log-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const documents=path.join(root,'managed-pdfs');fs.mkdirSync(documents);
 fs.writeFileSync(path.join(root,'openclaw.json'),JSON.stringify({plugins:{entries:{'kurumi-papers':{config:{root:documents}}}}}));
 const sink=createTraceSink(path.join(documents,'events.jsonl'));
 for(const status of ['queued','running','succeeded'])sink.emit({source:'papers',kind:'paper.job',correlation:{qqMessageId:'m1',taskId:'job_fixture'},data:{status,credentials:'private'}});
 const events=collectEvents({runtimeRoot:root,sources:['papers'],from:0,to:Date.now()+1000});
 assert.equal(events.length,3);assert.equal(filterEvents(events,{messageId:'m1'}).length,3);
 assert(events.every(e=>e.data.credentials==='[REDACTED]'));assert(events.every(e=>e.correlation.taskId==='job_fixture'));
});
