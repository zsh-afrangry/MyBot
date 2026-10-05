// ONE-SHOT MIGRATION SCRIPT — do NOT use this to change the persona day to day.
//
// It is kept because it records how the runtime was switched to the DeepSeek/小鲸鱼 configuration,
// but it does far more than set a role. Running it rewrites:
//   - models.providers (replacing every provider with a single DeepSeek entry)
//   - agents.defaults.model and agents.entries.main.model
//   - runtime-env.json, and DELETES OPENAI_API_KEY from it
//   - openclaw.json, plus workspace SOUL.md / IDENTITY.md / AGENTS.md / USER.md
//
// For a routine persona change use `sync-persona.mjs` (persona only). For models and providers
// edit config/runtime.config.json and apply it with `sync-config.mjs`.
import fs from 'node:fs';
import {credential} from './lib/legacy-source.mjs';
const root='/home/afrangry/kurumi-fusion',state='/home/afrangry/.openclaw-fusion',backup=state+'/migration/before-deepseek-whale-2026-10-05';
fs.mkdirSync(backup,{recursive:true,mode:0o700});
for(const rel of ['openclaw.json','runtime-env.json','workspace/SOUL.md','workspace/IDENTITY.md','workspace/AGENTS.md','workspace/USER.md']){const to=backup+'/'+rel.replaceAll('/','__');if(!fs.existsSync(to))fs.copyFileSync(state+'/'+rel,to);fs.chmodSync(to,0o600);}
// Credential comes from the isolated runtime (already migrated); the legacy tree is only a first-run fallback.
const env=JSON.parse(fs.readFileSync(state+'/runtime-env.json'));env.DEEPSEEK_API_KEY=credential('DEEPSEEK_API_KEY',{env});delete env.OPENAI_API_KEY;
const cfg=JSON.parse(fs.readFileSync(state+'/openclaw.json'));cfg.models.providers={deepseek:{baseUrl:'https://api.deepseek.com',api:'openai-completions',apiKey:{source:'env',provider:'default',id:'DEEPSEEK_API_KEY'},models:[{id:'deepseek-flash',name:'DeepSeek Flash',reasoning:true,input:['text','image'],contextWindow:1048576,maxTokens:32768}]}};cfg.agents.defaults.model={primary:'deepseek/deepseek-flash'};cfg.agents.entries.main.model={primary:'deepseek/deepseek-flash'};
fs.writeFileSync(state+'/runtime-env.json',JSON.stringify(env,null,2),{mode:0o600});fs.writeFileSync(state+'/openclaw.json',JSON.stringify(cfg,null,2),{mode:0o600});
fs.copyFileSync(root+'/roles/小鲸鱼.md',state+'/workspace/SOUL.md');fs.chmodSync(state+'/workspace/SOUL.md',0o600);
fs.writeFileSync(state+'/workspace/IDENTITY.md','# 当前角色\n\n- Name: 小鲸鱼\n- Persona: roles/小鲸鱼.md，原样加载至SOUL.md\n- 所属项目: Kurumi融合助手；项目名不是当前角色名。\n',{mode:0o600});
let agents=fs.readFileSync(root+'/scripts/fusion/templates/AGENTS.md','utf8').replace('你是 Kurumi，用户的中文个人助手。','当前临时使用SOUL.md中的小鲸鱼角色，Kurumi是项目名。角色卡的群友语气用于本人私聊；办事时仍准确、诚实地使用真实工具结果，不能用角色玩笑伪造任务完成。');fs.writeFileSync(state+'/workspace/AGENTS.md',agents,{mode:0o600});
const user=fs.readFileSync(state+'/workspace/USER.md','utf8').replace('称呼主人，','称呼遵循当前角色卡，');fs.writeFileSync(state+'/workspace/USER.md',user,{mode:0o600});
console.log({model:'deepseek/deepseek-flash',persona:'小鲸鱼',backup,historyUnchanged:true});
