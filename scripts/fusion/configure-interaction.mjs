// Copy the old read-only sticker catalog and set explicit migration/daily send budgets.
// The migration source is explicit so this script does not depend on the removed desktop tree.
import fs from 'node:fs';
import path from 'node:path';
import {legacySource} from './lib/legacy-source.mjs';
const state='/home/afrangry/.openclaw-fusion',file=state+'/openclaw.json',cfg=JSON.parse(fs.readFileSync(file)),a=cfg.channels['kurumi-qq'];
const target=a.stateDir+'/stickers.json';
if(!fs.existsSync(target)){
 const source=path.join(legacySource(),'state','stickers.json');
 if(!fs.existsSync(source))throw Error(`Sticker catalog missing from explicit legacy source: ${source}`);
 fs.copyFileSync(source,target);fs.chmodSync(target,0o600);
}
// User authorized owner-only nighttime testing. Preserve every historical attempt; do not reset the ledger.
a.sendLimit=40;a.dailySendLimit=120;a.naturalSegments=true;a.segmentDelayMs=450;
cfg.agents.entries.main.tools.alsoAllow=[...new Set([...cfg.agents.entries.main.tools.alsoAllow,'kurumi_sticker'])];
fs.writeFileSync(file,JSON.stringify(cfg,null,2),{mode:0o600});console.log({migrationLifetimeAttemptLimit:a.sendLimit,rolling24hAttemptLimit:a.dailySendLimit,naturalSegments:true,stickerEntries:JSON.parse(fs.readFileSync(target)).length});
