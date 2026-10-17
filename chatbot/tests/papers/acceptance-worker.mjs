// Production-capture worker smoke test: reads selected captured code/runtime configuration,
// writes only temporary sandbox directories and explicit --out. No credentials/model/API/delivery.
// Development owner: docs/22_论文PDF翻译与文件投递.md.
// Evidence: docs/verification/paper-translation-2026-10-17/channel-upgrade/.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';

const arg=name=>{const i=process.argv.indexOf('--'+name);return i<0?undefined:process.argv[i+1];};
const capture=arg('capture'),out=arg('out'),state='/home/afrangry/.openclaw-fusion';
if(!capture||!out||!path.isAbsolute(capture)||!path.isAbsolute(out)||fs.existsSync(out))throw Error('Explicit absolute --capture and new --out required');
if(!capture.startsWith(state+'/tmp/plugin-captures/')||path.basename(capture)!=='runner.js'||fs.realpathSync(capture)!==capture)throw Error('Use a real production plugin-captured runner');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'kurumi-capture-smoke-'));
const report={at:new Date().toISOString(),boundary:'Actual production plugin-captured code and fixed Python inside real Bubblewrap; only temporary sandbox and explicit evidence writes. No model, API, QQ or SMTP calls.',capturePath:capture};
try{
  const {workerCommand}=await import(pathToFileURL(capture).href);
  const config=JSON.parse(fs.readFileSync(state+'/openclaw.json')).plugins.entries['kurumi-papers'].config;
  for(const name of ['work','cache'])fs.mkdirSync(path.join(root,name));
  const {command,args}=workerCommand({config,work:path.join(root,'work'),cache:path.join(root,'cache')});
  const app=args.indexOf('/app'),pythonSource=args[app-1];
  report.sourceHashes=Object.fromEntries(['engine.py','responses.py','profiles.json'].map(name=>[name,createHash('sha256').update(fs.readFileSync(path.join(pythonSource,name))).digest('hex')]));
  const code=`import pathlib,json,sys; sys.path.insert(0,'/app'); import engine,responses; import babeldoc; p=pathlib.Path; assert not p('${state}/paper-credentials.json').exists(); assert not p('${state}/runtime-env.json').exists(); specs=responses.PROFILE_REGISTRY['providers']; assert [s['provider'] for s in specs]==['openai','deepseek']; assert specs[1]['baseUrl']=='https://api.deepseek.com'; print(json.dumps({'ok':True,'providers':[s['provider'] for s in specs]}))`;
  const result=spawnSync(command,[...args.slice(0,-1),'-c',code],{encoding:'utf8',timeout:20000,env:{PATH:'/usr/bin:/bin'}});
  report.exitCode=result.status;report.ok=result.status===0;
  if(report.ok)report.worker=JSON.parse(result.stdout.trim().split('\n').at(-1));
  else report.error='captured_worker_smoke_failed';
}catch{report.ok=false;report.error='captured_source_or_worker_unavailable';}
finally{
  fs.rmSync(root,{recursive:true,force:true});
  fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({ok:report.ok,evidence:out}));
  if(!report.ok)process.exitCode=1;
}
