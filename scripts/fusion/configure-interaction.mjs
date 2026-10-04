// Copy the old read-only sticker catalog and set explicit migration/daily send budgets.
import fs from 'node:fs';
const state='/home/afrangry/.openclaw-fusion',file=state+'/openclaw.json',cfg=JSON.parse(fs.readFileSync(file)),a=cfg.channels['kurumi-qq'];
const target=a.stateDir+'/stickers.json';if(!fs.existsSync(target)){fs.copyFileSync('/home/afrangry/桌面/qq-bridge/state/stickers.json',target);fs.chmodSync(target,0o600);}
// User authorized owner-only nighttime testing. Preserve every historical attempt; do not reset the ledger.
a.sendLimit=40;a.dailySendLimit=120;a.naturalSegments=true;a.segmentDelayMs=450;
cfg.agents.entries.main.tools.alsoAllow=[...new Set([...cfg.agents.entries.main.tools.alsoAllow,'kurumi_sticker'])];
fs.writeFileSync(file,JSON.stringify(cfg,null,2),{mode:0o600});console.log({migrationLifetimeAttemptLimit:a.sendLimit,rolling24hAttemptLimit:a.dailySendLimit,naturalSegments:true,stickerEntries:JSON.parse(fs.readFileSync(target)).length});
