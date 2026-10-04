// Explicitly configure the isolated code worker; original projects are not its workspace.
import fs from 'node:fs';
const state='/home/afrangry/.openclaw-fusion',root='/home/afrangry/kurumi-fusion',dir=`${state}/code-workspace`;
fs.mkdirSync(dir,{recursive:true,mode:0o700});
if(!fs.existsSync(`${dir}/stats.py`)){
 fs.writeFileSync(`${dir}/stats.py`,'def mean(values):\n    return sum(values) / len(values)\n\ndef moving_average(values, window):\n    return [mean(values[i:i+window]) for i in range(len(values)-window)]\n');
 fs.copyFileSync(`${root}/scripts/fusion/fixtures/test_stats.py`,`${dir}/test_stats.py`);
 fs.writeFileSync(`${dir}/AGENTS.md`,'# Isolated code task\nWork only in this workspace. Never modify test_stats.py or access old .openclaw, snowluma or qq-bridge originals. Fix code and run kurumi_project_check, which executes the fixed test command. No shell or network is available. Report actual test results in concise Chinese, starting with 【融合验收】. Do not delegate or create other sessions.\n');
}
const p=`${state}/openclaw.json`,cfg=JSON.parse(fs.readFileSync(p));
cfg.agents.entries={main:{workspace:`${state}/workspace`,tools:{profile:'messaging',alsoAllow:[...(cfg.agents?.entries?.main?.tools?.alsoAllow??[]).filter(x=>x!=='kurumi_test_wait'),'automations','kurumi_task',...(cfg.channels['kurumi-qq'].testIngress?['kurumi_test_wait']:[])],deny:['read','write','edit','apply_patch','exec','process','message','sessions_spawn']}},worker:{workspace:dir,tools:{profile:'full',allow:['read','write','edit','apply_patch','kurumi_project_check'],fs:{workspaceOnly:true},deny:['exec','process','message','sessions_spawn','web_search','web_fetch']}}};
cfg.agents.ownership='explicit';cfg.agents.defaults.systemAgent={agentId:'main'};cfg.agents.defaults.heartbeat={every:'0m',agentId:'main'};
cfg.tools={...cfg.tools,fs:{workspaceOnly:true},deny:['message','exec','process','gateway','browser','sessions_spawn']};
cfg.bindings=[{agentId:'main',match:{channel:'kurumi-qq',accountId:'default'}}];
if(!cfg.plugins.allow.includes('kurumi-tasks'))cfg.plugins.allow.push('kurumi-tasks');
if(!cfg.plugins.load.paths.includes(`${root}/chatbot/plugins/kurumi-tasks`))cfg.plugins.load.paths.push(`${root}/chatbot/plugins/kurumi-tasks`);
cfg.plugins.entries['kurumi-tasks']={enabled:true};fs.writeFileSync(p,JSON.stringify(cfg,null,2),{mode:0o600});console.log('Isolated worker configured');
