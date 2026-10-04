// Two ordinary native sessions; no child agents, no QQ sends.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {rpc,ready} from './rpc.mjs';
await ready();
const marker='/home/afrangry/.openclaw-fusion/channel/test-wait-started.json';
if(fs.existsSync(marker))fs.unlinkSync(marker);
const r={boundary:'Real Host/model in two ordinary sessions, test-only wait tool, deliver=false; not yet QQ main-to-background delegation',startedAt:new Date().toISOString()};
try{
 r.slow=await rpc('agent',{sessionKey:'agent:main:fusion-slow-test',message:'这是隔离并发验收。先用 tool_search 查找 kurumi_test_wait，再按实际参数调用它等待25秒，实际完成后只回复 WAIT_DONE；工具不可用或失败时如实报告，禁止伪造完成。',deliver:false,idempotencyKey:randomUUID()});
 for(let i=0;i<40&&!fs.existsSync(marker);i++)await new Promise(r=>setTimeout(r,500));
 assert(fs.existsSync(marker),'Slow tool did not start');r.slowStarted=JSON.parse(fs.readFileSync(marker));
 const start=Date.now();r.fast=await rpc('agent',{sessionKey:'agent:main:fusion-fast-test',message:'这是并发测试，直接回复 FAST_DONE，不使用工具。',deliver:false,idempotencyKey:randomUUID()});
 r.fastFinished=await rpc('agent.wait',{runId:r.fast.runId,timeoutMs:20000});r.fastElapsedMs=Date.now()-start;
 assert(r.fastElapsedMs<22000,'Fast session blocked behind slow task');
 r.cancel=await rpc('chat.abort',{sessionKey:'agent:main:fusion-slow-test',runId:r.slow.runId});
 r.slowFinished=await rpc('agent.wait',{runId:r.slow.runId,timeoutMs:10000});assert.equal(r.cancel.aborted,true);assert.equal(r.slowFinished.status,'error');r.passed=true;
}catch(e){r.error=e.message;r.passed=false;process.exitCode=1;}
fs.writeFileSync('/home/afrangry/kurumi-fusion/docs/verification/fusion/05-native-concurrency.json',JSON.stringify(r,null,2));console.log(JSON.stringify(r));
