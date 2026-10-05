// Reuse existing domain configuration and credentials in the isolated runtime only.
import fs from 'node:fs';
import {parseEnv} from 'node:util';
const root='/home/afrangry/kurumi-fusion',state='/home/afrangry/.openclaw-fusion';
const cfg=JSON.parse(fs.readFileSync(`${state}/openclaw.json`)),old=JSON.parse(fs.readFileSync('/home/afrangry/.openclaw/openclaw.json'));
const env=JSON.parse(fs.readFileSync(`${state}/runtime-env.json`)),oldEnv=parseEnv(fs.readFileSync('/home/afrangry/.openclaw/gateway.systemd.env','utf8'));
for(const key of ['QWEATHER_API_KEY','QWEATHER_API_HOST'])if(oldEnv[key])env[key]=oldEnv[key];
for(const id of ['personal-confirmation','personal-weather']){
 cfg.plugins.allow=[...new Set([...cfg.plugins.allow,id])];cfg.plugins.load.paths=[...new Set([...cfg.plugins.load.paths,`${root}/chatbot/plugins/${id}`])];
 cfg.plugins.entries[id]={...(old.plugins.entries[id]??{}),enabled:true};
}
cfg.plugins.entries['personal-weather'].config={...cfg.plugins.entries['personal-weather'].config,scheduledOwnerId:cfg.channels['kurumi-qq'].ownerId,reminderBackend:'native-service',reminderRunnerRoot:`${root}/chatbot/plugins/personal-weather`};
const domainTools=['personal_weather_get_brief','personal_profile_state_get','personal_profile_change_propose','personal_profile_change_commit','personal_planning_state_get','personal_planning_change_propose','personal_planning_change_commit','personal_reminder_state_get','personal_reminder_propose','personal_reminder_commit','personal_reminder_change_propose','personal_reminder_change_commit','personal_reminder_cancel_propose','personal_reminder_cancel_commit'];
cfg.agents.entries.main.tools.alsoAllow=[...new Set([...cfg.agents.entries.main.tools.alsoAllow,...domainTools])];
cfg.channels['kurumi-qq'].testIngress=true;
fs.writeFileSync(`${state}/openclaw.json`,JSON.stringify(cfg,null,2),{mode:0o600});fs.writeFileSync(`${state}/runtime-env.json`,JSON.stringify(env),{mode:0o600});
console.log('Copied domain configuration; weather/Profile/planning tools enabled for owner. Typed reminder service enabled for acceptance.');
