// Makes anonymous GET requests to Bilibili. Runs the operator command with a temporary
// OpenClaw state directory, verifies the actual read and withdrawal, then deletes that
// directory. No production state, QQ, paid model or service changes.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createSightingsService} from '../../plugins/kurumi-sightings/service.js';
import {sqliteSightings} from '../../plugins/kurumi-sightings/store.js';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'kurumi-sightings-source-')));
const script = fileURLToPath(new URL('../../scripts/sightings.mjs',import.meta.url));
const run = (...args) => JSON.parse(execFileSync(process.execPath,[script,...args],{
  env:{...process.env,OPENCLAW_STATE_DIR:root}, encoding:'utf8', timeout:12000,
}));
try {
  const service = createSightingsService({store:sqliteSightings(root)});
  assert.equal(service.list({}).status,'unavailable');
  const collected = run('--collect-bilibili');
  assert.equal(collected.status,'recorded');
  const visible = service.list({date:collected.date});
  assert.equal(visible.status,'ok');
  assert.equal(visible.items.length,1);
  const [item] = visible.items;
  assert.equal(item.id,collected.id);
  assert.equal(item.platform,'bilibili');
  assert.match(item.url,/^https:\/\/www\.bilibili\.com\/video\/BV[A-Za-z0-9]{10}\/$/u);
  assert(item.title.trim().length > 0);
  assert(item.excerpt.trim().length > 0);
  const withdrawn = run('--withdraw',item.id);
  assert.equal(withdrawn.status,'withdrawn');
  assert.deepEqual(service.list({date:collected.date}).items,[]);
  console.log(JSON.stringify({passed:true,source:'bilibili',content:'public_video_description',
    date:collected.date,recorded:true,withdrawn:true,boundary:'network read and temporary SQLite, no model or QQ'}));
} finally {
  fs.rmSync(root,{recursive:true,force:true});
}
