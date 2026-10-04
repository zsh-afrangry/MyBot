// Import only stable owner fields into private runtime memory. Never print their values.
import fs from 'node:fs';
import {randomBytes} from 'node:crypto';
import {readMemory,writeMemory} from '../../chatbot/plugins/kurumi-memory/store.js';
const root='/home/afrangry/kurumi-fusion',state='/home/afrangry/.openclaw-fusion',workspace=state+'/workspace',old='/home/afrangry/.openclaw/chatbot';
const backup=state+'/migration/persona-before';fs.mkdirSync(backup,{recursive:true,mode:0o700});
for(const name of ['SOUL.md','IDENTITY.md','USER.md'])if(!fs.existsSync(backup+'/'+name)&&fs.existsSync(workspace+'/'+name))fs.copyFileSync(workspace+'/'+name,backup+'/'+name);
const fields=Object.fromEntries([...fs.readFileSync(old+'/USER.md','utf8').matchAll(/^- \*\*([^:]+):\*\* (.+)$/gm)].map(m=>[m[1],m[2]]));
for(const name of ['SOUL.md','IDENTITY.md']){
 let text=fs.readFileSync(old+'/'+name,'utf8');if(fields.Name)text=text.replaceAll(fields.Name,'主人').replace('主人是你的主人和开发者。','主人也是你的开发者。');fs.writeFileSync(workspace+'/'+name,text,{mode:0o600});
}
fs.writeFileSync(workspace+'/USER.md','# 主人资料\n\n称呼主人，默认中文与Asia/Shanghai时区。可更正的个人事实统一见MEMORY.md，不在此重复保存。私人资料只用于当前本人协助。\n',{mode:0o600});
const existing=readMemory(workspace);
if(existing.revision===0){
 const labels={Name:'主人姓名',Pronouns:'主人称谓',Age:'主人年龄（保留原始日期）',Occupation:'主人职业','Current goal':'主人当时目标（旧资料，需留意时效）',Spouse:'主人配偶'};
 const entries=Object.entries(labels).filter(([key])=>fields[key]).map(([key,label])=>({id:randomBytes(6).toString('hex'),text:`${label}：${fields[key]}`,updatedAt:new Date().toISOString(),source:'owner_profile_import; original dated USER.md'}));
 writeMemory(workspace,{entries},0);
}
const cfg=JSON.parse(fs.readFileSync(state+'/openclaw.json'));
cfg.plugins.allow=[...new Set([...cfg.plugins.allow,'kurumi-memory'])];cfg.plugins.load.paths=[...new Set([...cfg.plugins.load.paths,root+'/chatbot/plugins/kurumi-memory'])];cfg.plugins.entries['kurumi-memory']={enabled:true};cfg.agents.entries.main.tools.alsoAllow=[...new Set([...cfg.agents.entries.main.tools.alsoAllow,'kurumi_memory'])];
fs.writeFileSync(state+'/openclaw.json',JSON.stringify(cfg,null,2),{mode:0o600});console.log({persona:'Kurumi',memoryEntries:readMemory(workspace).entries.length,automaticMemory:false});
