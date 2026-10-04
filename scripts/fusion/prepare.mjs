// Prepare an isolated runtime from selected existing settings; never changes originals.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {parseEnv} from 'node:util';
const root='/home/afrangry/kurumi-fusion',state='/home/afrangry/.openclaw-fusion';
const write=(p,v)=>{if(fs.existsSync(p))throw Error('Refusing overwrite: '+p);fs.writeFileSync(p,v,{mode:0o600});};
for(const d of ['workspace','media','channel','source-snapshots'])fs.mkdirSync(`${state}/${d}`,{recursive:true,mode:0o700});
const original=JSON.parse(fs.readFileSync('/home/afrangry/.openclaw/openclaw.json'));
const bridge=JSON.parse(fs.readFileSync('/home/afrangry/桌面/qq-bridge/config.json'));
const env=parseEnv(fs.readFileSync('/home/afrangry/.openclaw/gateway.systemd.env','utf8'));
const configs=fs.readdirSync('/home/afrangry/snowluma/runtime/config').filter(x=>/^onebot_.*\.json$/.test(x)).map(x=>JSON.parse(fs.readFileSync('/home/afrangry/snowluma/runtime/config/'+x)));
const ws=configs.flatMap(x=>x.networks?.wsServers??[]).find(x=>Number(x.port)===3084);
if(!ws?.accessToken||!env.OPENAI_API_KEY)throw Error('Missing existing credential');
write(`${state}/http-token`,bridge.snowluma.accessToken);
write(`${state}/ws-token`,ws.accessToken);
write(`${state}/runtime-env.json`,JSON.stringify({OPENAI_API_KEY:env.OPENAI_API_KEY,OPENCLAW_GATEWAY_TOKEN:randomUUID()}));
write(`${state}/source-snapshots/qq-bridge-config.json`,JSON.stringify(bridge,null,2));
const cfg={
 agents:{defaults:{workspace:`${state}/workspace`,model:{primary:'naiccc/gpt-5.6-terra'},heartbeat:{every:'0m'}}},
 models:{providers:{naiccc:original.models.providers.naiccc}},secrets:original.secrets,
 skills:{workshop:{autonomous:{mode:'off'}}},session:{dmScope:'per-channel-peer'},commands:{ownerAllowFrom:['kurumi-qq:365999865']},
 gateway:{mode:'local',port:18890,bind:'loopback',auth:{mode:'token',token:'${OPENCLAW_GATEWAY_TOKEN}'},controlUi:{enabled:false}},discovery:{mdns:{mode:'off'}},
 plugins:{slots:{memory:'none'},allow:['kurumi-qq'],load:{paths:[`${root}/chatbot/plugins/kurumi-qq`]},entries:{'kurumi-qq':{enabled:true}}},
 channels:{'kurumi-qq':{enabled:true,ownerId:'365999865',httpUrl:bridge.snowluma.httpUrl,wsUrl:bridge.snowluma.wsUrl,httpTokenFile:`${state}/http-token`,wsTokenFile:`${state}/ws-token`,stateDir:`${state}/channel`,mediaRoot:`${state}/media`,sendLimit:10,chunkLimit:1200}},
 tools:{profile:'messaging',deny:['message','sessions_spawn','cron','exec','process','write','edit','read']}
};
write(`${state}/openclaw.json`,JSON.stringify(cfg,null,2));
write(`${state}/workspace/AGENTS.md`,fs.readFileSync(`${root}/scripts/fusion/templates/AGENTS.md`));
write(`${state}/workspace/SOUL.md`,'# Kurumi\n自然、亲近、简洁，可以轻轻调侃。闲聊不要机械列计划；做事依据实际工具结果。保持关心但不假装知道没有证据的事实。\n');
fs.copyFileSync('/home/afrangry/snowluma/runtime/client/logo.png',`${state}/media/snowluma-logo.png`);
const md=fs.readFileSync(`${root}/chatbot/plugins/kurumi-qq/src/vendor/md-to-plain.js`);
fs.writeFileSync(`${root}/chatbot/plugins/kurumi-qq/src/vendor/ORIGIN.md`,`# 来源\n\nmd-to-plain.js 复制自 /home/afrangry/桌面/qq-bridge/src/md-to-plain.js，2026-10-05 本机快照，未改动。SHA-256: ${createHash('sha256').update(md).digest('hex')}。许可证见 qq-bridge-LICENSE。\n\n仅复用格式化实现；没有复制其 DSH 会话、调度或权限控制。QQ 连接配置的私有副本位于 ${state}/source-snapshots/qq-bridge-config.json，不纳入 Git。\n`);
console.log('Isolated configuration prepared; no secrets printed.');
