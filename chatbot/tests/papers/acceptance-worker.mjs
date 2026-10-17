// Production-capture worker smoke test: reads selected captured code/runtime configuration,
// writes only temporary sandbox directories and explicit --out. No credentials/model/API/delivery.
// Development owner: docs/22_论文PDF翻译与文件投递.md.
// Evidence: docs/verification/paper-translation-2026-10-17/ (explicit --out).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {MAX_PDF_BYTES,MAX_ARTIFACT_PDF_BYTES} from '../../packages/documents/index.js';

const arg=name=>{const i=process.argv.indexOf('--'+name);return i<0?undefined:process.argv[i+1];};
const capture=arg('capture'),out=arg('out'),state='/home/afrangry/.openclaw-fusion';
if(!capture||!out||!path.isAbsolute(capture)||!path.isAbsolute(out)||fs.existsSync(out))throw Error('Explicit absolute --capture and new --out required');
if(!capture.startsWith(state+'/tmp/plugin-captures/')||path.basename(capture)!=='runner.js'||fs.realpathSync(capture)!==capture)throw Error('Use a real production plugin-captured runner');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'kurumi-capture-smoke-'));
const report={at:new Date().toISOString(),boundary:'Actual production plugin-captured code and fixed Python inside real Bubblewrap; only temporary sandbox and explicit evidence writes. No model, API, QQ or SMTP calls.',capturePath:capture};
try{
  const {workerCommand,executionSettings,reliabilitySettings,translationTimeoutSeconds}=await import(pathToFileURL(capture).href);
  const {resolveProfile}=await import(new URL('./profiles.js',pathToFileURL(capture)).href);
  const {selectedOutputs}=await import(new URL('./outputs.js',pathToFileURL(capture)).href);
  if(selectedOutputs('dual').join(',')!=='dual'||selectedOutputs('both').join(',')!=='dual,mono')throw Error('Captured output selection differs');
  // OpenClaw resolves cross-package imports through its own capture map, not native ESM paths.
  // Prove those copied sources match the regression-tested source without inventing symlinks.
  const build=path.resolve(path.dirname(capture),'../../..');
  const capturedDocuments=fs.readdirSync(build).filter(name=>name.startsWith('package-')).map(name=>path.join(build,name,'node_modules/documents/index.js')).find(file=>fs.existsSync(file));
  const source=file=>new URL(file,import.meta.url);
  const pairs=[
    ['service',path.join(path.dirname(capture),'service.js'),source('../../plugins/kurumi-papers/service.js')],
    ['outputs',path.join(path.dirname(capture),'outputs.js'),source('../../plugins/kurumi-papers/outputs.js')],
    ['documents',capturedDocuments,source('../../packages/documents/index.js')],
  ];
  report.capturedSourceHashes={};
  for(const [label,copied,original] of pairs){
    const bytes=fs.readFileSync(copied);
    if(!bytes.equals(fs.readFileSync(original)))throw Error('Captured source differs');
    report.capturedSourceHashes[label]=createHash('sha256').update(bytes).digest('hex');
  }
  report.pdfLimits={input:MAX_PDF_BYTES,artifact:MAX_ARTIFACT_PDF_BYTES};
  if(MAX_PDF_BYTES!==25*1024*1024||MAX_ARTIFACT_PDF_BYTES!==100*1024*1024)throw Error('Captured PDF limits differ');
  report.deepseekDefault=resolveProfile({provider:'deepseek'});
  if(report.deepseekDefault.model!=='deepseek-flash'||report.deepseekDefault.effort!=='high')throw Error('Captured DeepSeek default differs');
  report.gptDefault=resolveProfile();report.explicitMax=resolveProfile({effort:'MAX'});
  if(report.gptDefault.effort!=='high'||report.explicitMax.effort!=='max')throw Error('Captured GPT effort differs');
  const config=JSON.parse(fs.readFileSync(state+'/openclaw.json')).plugins.entries['kurumi-papers'].config;
  report.budgets={maxRequests:config.maxRequests,maxReportedTokens:config.maxReportedTokens};
  if(report.budgets.maxRequests!==300||report.budgets.maxReportedTokens!==300000)throw Error('Captured production budgets differ');
  report.execution=executionSettings(config);
  report.reliability=reliabilitySettings(config);
  if(report.reliability.batchValidationRetries!==1||report.reliability.channelRecoveryRetries!==1)throw Error('Captured retry defaults differ');
  report.timeoutSeconds=translationTimeoutSeconds(config);
  if(report.timeoutSeconds!==1800)throw Error('Captured deadline differs');
  for(const name of ['work','cache'])fs.mkdirSync(path.join(root,name));
  const {command,args}=workerCommand({config,work:path.join(root,'work'),cache:path.join(root,'cache')});
  const app=args.indexOf('/app'),pythonSource=args[app-1];
  report.sourceHashes=Object.fromEntries(['engine.py','responses.py','http_worker.py','profiles.json'].map(name=>{
    const bytes=fs.readFileSync(path.join(pythonSource,name));
    if(!bytes.equals(fs.readFileSync(source('../../plugins/kurumi-papers/python/'+name))))throw Error('Captured Python differs');
    return [name,createHash('sha256').update(bytes).digest('hex')];
  }));
  const code=`import pathlib,json,sys,subprocess; sys.path.insert(0,'/app'); import engine,responses; import babeldoc; p=pathlib.Path; assert not p('${state}/paper-credentials.json').exists(); assert not p('${state}/runtime-env.json').exists(); specs=responses.PROFILE_REGISTRY['providers']; assert [s['provider'] for s in specs]==['openai','deepseek']; assert specs[1]['baseUrl']=='https://api.deepseek.com'; assert specs[1]['defaultModel']=='deepseek-flash' and specs[1]['defaultEffort']=='high'; assert engine.execution_limits(json.loads('${JSON.stringify(report.execution)}'))==(${report.execution.apiConcurrency},${report.execution.apiQps}); child=subprocess.run([sys.executable,'-u','/app/http_worker.py'],input='{}',capture_output=True,text=True,timeout=5); assert json.loads(child.stdout)['code']=='api_transport_worker_error'; print(json.dumps({'ok':True,'providers':[s['provider'] for s in specs],'cancellableHttpWorker':True}))`;
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
