// Test-only slow operation to verify native Host concurrency and cancellation.
// Registered only with testIngress=true and only visible in the named test session.
import fs from 'node:fs';
export function registerAcceptanceTools(api){
 api.on('after_tool_call',event=>{
  if(!['automations','cron','kurumi_task','kurumi_project_check'].includes(event.toolName))return;
  fs.appendFileSync(api.config.channels['kurumi-qq'].stateDir+'/native-tool-receipts.jsonl',JSON.stringify({at:Date.now(),tool:event.toolName,action:event.params?.action,error:event.error??null})+'\n',{mode:0o600});
 });
 api.registerTool(ctx=>ctx.sessionKey==='agent:main:fusion-slow-test'?{
  name:'kurumi_test_wait',label:'Isolated wait test',description:'Wait 25 seconds for the authorized isolated cancellation/concurrency acceptance test. No network or business effect.',
  parameters:{type:'object',properties:{},additionalProperties:false},
  async execute(id,args,signal){
   const dir=api.config.channels['kurumi-qq'].stateDir;
   fs.writeFileSync(`${dir}/test-wait-started.json`,JSON.stringify({at:Date.now(),sessionKey:ctx.sessionKey}));
   await new Promise((resolve,reject)=>{const done=()=>{signal?.removeEventListener('abort',abort);resolve();};const t=setTimeout(done,25000);const abort=()=>{clearTimeout(t);signal?.removeEventListener('abort',abort);reject(Error('Canceled wait'));};signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();});
   return {content:[{type:'text',text:'WAIT_COMPLETED'}]};
  }
 }:null,{name:'kurumi_test_wait',optional:true});
}
