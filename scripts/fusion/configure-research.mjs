// Reuse installed native provider read-only; only isolated config/env are written.
import fs from 'node:fs';
import path from 'node:path';
import {parseEnv} from 'node:util';
const state='/home/afrangry/.openclaw-fusion',original='/home/afrangry/.openclaw';
const cfg=JSON.parse(fs.readFileSync(`${state}/openclaw.json`));
const source=JSON.parse(fs.readFileSync(`${original}/openclaw.json`));
const sourceEnv=parseEnv(fs.readFileSync(`${original}/gateway.systemd.env`,'utf8'));
const env=JSON.parse(fs.readFileSync(`${state}/runtime-env.json`));
if(!sourceEnv.TAVILY_API_KEY)throw Error('Existing Tavily credential unavailable');
for(const key of ['TAVILY_API_KEY','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy'])if(sourceEnv[key])env[key]=sourceEnv[key];
const candidates=fs.readdirSync(`${original}/npm/projects`).map(x=>path.join(original,'npm/projects',x,'node_modules/@openclaw/tavily-plugin')).filter(x=>fs.existsSync(path.join(x,'openclaw.plugin.json')));
if(candidates.length!==1)throw Error('Ambiguous native provider installation');
cfg.tools.web=structuredClone(source.tools.web);cfg.tools.web.search.enabled=true;cfg.tools.web.search.provider='tavily';cfg.tools.web.fetch={...cfg.tools.web.fetch,enabled:true,maxChars:15000,maxCharsCap:15000};
cfg.plugins.entries.tavily=structuredClone(source.plugins.entries.tavily);cfg.plugins.entries.tavily.enabled=true;
cfg.plugins.allow=[...new Set([...cfg.plugins.allow,'tavily'])];cfg.plugins.load.paths=[...new Set([...cfg.plugins.load.paths,candidates[0]])];
cfg.agents.entries.main.tools.alsoAllow=[...new Set([...cfg.agents.entries.main.tools.alsoAllow,'web_search','web_fetch'])];
fs.writeFileSync(`${state}/openclaw.json`,JSON.stringify(cfg,null,2),{mode:0o600});fs.writeFileSync(`${state}/runtime-env.json`,JSON.stringify(env),{mode:0o600});
console.log('Native research configured in isolated runtime; credentials not printed.');
