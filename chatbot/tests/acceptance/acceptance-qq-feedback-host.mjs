// Isolated OpenClaw, loopback OneBot and deterministic model. Uses only temporary accounts and state.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {once} from 'node:events';
import {existsSync,mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {isAbsolute,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {compileAccessConfig} from '../../packages/access-control/config.js';
import {ownerPolicy} from '../access-control/fixtures.mjs';
import {withHostControl} from '../access-control/host-config.mjs';
import {startIsolatedGateway} from './isolated-gateway.mjs';
import {createOneBotPeer,waitForAcceptance,waitForOneBotTurn,textOfSend} from './onebot-peer.mjs';

const [flag,out,...extra]=process.argv.slice(2);
assert(flag==='--out'&&isAbsolute(out??'')&&!extra.length&&!existsSync(out));
const root=mkdtempSync(join(tmpdir(),'kurumi-qq-feedback-')), repo=fileURLToPath(new URL('../../../',import.meta.url));
const owner='810041',bot='810042',token=randomBytes(24).toString('hex'),tokenFile=join(root,'token');
const channelDir=join(root,'channel'),workspace=join(root,'workspace');
const report={passed:false,cases:[],primaryModel:'fixture/fixture',boundary:'isolated OpenClaw, loopback OneBot, deterministic model'};
let peer,gateway,model,mode,firstReply,modelError,toolChecked;
const check=()=>{peer.check(); if(modelError)throw modelError;};

function modelReply(request) {
  if(mode==='send')return {content:'第一段样本。\n\n第二段样本。'};
  if(mode==='receipt')return {content:'好的。'};
  const tool=request.messages.at(-1);
  if(tool.role!=='tool'){
    assert(request.tools.some(t=>t.function.name==='kurumi_logs'));
    return {tool_calls:[{id:'feedback_'+mode,type:'function',function:{name:'kurumi_logs',
      arguments:JSON.stringify({view:'events',sources:['channel-delivery'],messageId:firstReply,since:'all',noText:true})}}]};
  }
  const content=typeof tool.content==='string'?tool.content:tool.content.map(part=>part.text??'').join('');
  // The real log tool wraps a JSON payload with external-content markers.
  const begin=content.indexOf('{"status":"ok"'),end=content.lastIndexOf('}');
  assert(begin>=0,'Missing authorized log result');
  const rows=JSON.parse(content.slice(begin,end+1)).events;
  assert.equal(rows.length,2);
  const [first,second]=rows.sort((a,b)=>a.data.part-b.data.part).map(row=>row.data);
  assert.deepEqual([first.platformStatus,second.platformStatus],['accepted','accepted']);
  assert.equal(first.recipientStatus,mode==='before'?'unverified':'acknowledged');
  assert.equal(second.recipientStatus,'unverified');
  assert([first,second].every(row=>row.parts===2&&row.readStatus==='unknown'&&row.clientDelivery==='unknown'));
  toolChecked=true;
  return {content:mode==='before'?'两段平台都已受理，收件情况尚未核实。':'你已回认第一段，第二段仍待核实。'};
}
try{
  mkdirSync(workspace);writeFileSync(tokenFile,token,{mode:0o600});
  peer=await createOneBotPeer({token,botId:bot,subjects:[owner],methods:{get_msg({message_id}){
    const row=peer.sends.find(s=>s.messageId===String(message_id));
    assert(row?.accepted);
    return {message_id,message_type:'private',sender:{user_id:Number(bot)},target_id:Number(row.user_id),message:row.message};
  }}});
  model=createServer(async(req,res)=>{
    try{
      let body='';for await(const chunk of req)body+=chunk;
      const request=JSON.parse(body),message={role:'assistant',...modelReply(request)};
      const finish=message.tool_calls?'tool_calls':'stop',base={id:'fixture-'+mode,model:'fixture',created:1};
      if(!request.stream)return res.setHeader('content-type','application/json').end(JSON.stringify({...base,
        object:'chat.completion',choices:[{index:0,message,finish_reason:finish}]}));
      if(message.tool_calls)message.tool_calls[0].index=0;
      const chunk=(delta,finish_reason)=>'data: '+JSON.stringify({...base,object:'chat.completion.chunk',choices:[{index:0,delta,finish_reason}]})+'\n\n';
      res.setHeader('content-type','text/event-stream').end(chunk(message,null)+chunk({},finish)+'data: [DONE]\n\n');
    }catch(error){modelError??=error;res.writeHead(400).end();}
  });
  model.listen(0,'127.0.0.1');await once(model,'listening');
  const plugins=['kurumi-qq','kurumi-logs'];
  const cfg=withHostControl(compileAccessConfig({
    agents:{ownership:'explicit',defaults:{workspace,systemAgent:{agentId:'main'},heartbeat:{every:'0m'},model:{primary:'fixture/fixture'}},
      entries:{main:{workspace,tools:{allow:['kurumi_logs']}}}},
    models:{catalogRefresh:{enabled:false},providers:{fixture:{baseUrl:'http://127.0.0.1:'+model.address().port+'/v1',
      apiKey:'fixture',api:'openai-completions',models:[{id:'fixture',name:'fixture',contextWindow:64000,maxTokens:600}]}}},
    plugins:{allow:plugins,load:{paths:plugins.map(id=>join(repo,'chatbot/plugins',id))},slots:{memory:'none'},
      entries:{'kurumi-qq':{enabled:true},'kurumi-logs':{enabled:true,config:{backendRoot:repo,runtimeRoot:root,snowlumaRoot:root}}}},
    channels:{'kurumi-qq':{enabled:true,httpUrl:peer.httpUrl,wsUrl:peer.wsUrl,httpTokenFile:tokenFile,wsTokenFile:tokenFile,
      stateDir:channelDir,mediaRoot:join(root,'media'),segmentDelayMs:0,testIngress:false}},
    tools:{toolSearch:false,codeMode:false,web:{search:{enabled:false},fetch:{enabled:false}}},
    session:{dmScope:'per-channel-peer'},cron:{enabled:false},update:{checkOnStart:false},logging:{file:join(root,'runtime.log')},
  },ownerPolicy(owner)),repo);
  gateway=await startIsolatedGateway({repo,root,token,configure:()=>cfg});
  await gateway.ready();await waitForAcceptance(peer.connected,'OneBot connection');
  async function exchange(stage,segments){
    mode=stage;toolChecked=false;
    const index=peer.sends.length;
    const id=await peer.send(peer.message(owner,segments));
    await waitForOneBotTurn(channelDir,[id],{check});
    return peer.sends.slice(index);
  }
  const initial=await exchange('send','请发两段样本。');
  assert.deepEqual(initial.map(textOfSend),['第一段样本。','第二段样本。']);
  firstReply=initial[0].messageId;
  report.cases.push('One authorized private reply produces two distinct physical text messages');
  await exchange('before','这两段收到了吗？');
  assert(toolChecked);report.cases.push('Owner log tool finds platform acceptance and unverified receipt for both parts');
  await exchange('receipt',[{type:'reply',data:{id:firstReply}},{type:'text',data:{text:'收到了。'}}]);
  const answer=await exchange('after','现在能查到我收到了哪一段吗？');
  assert(toolChecked&&answer.some(row=>textOfSend(row).includes('已回认第一段')));
  report.cases.push('A quoted receipt updates only its part and a subsequent owner query reports it');
  report.passed=true;
}catch(error){report.error=(modelError??error).message;}
finally{
  if(await gateway?.close()===false){report.passed=false;report.error??='Gateway shutdown failed';}
  model?.closeAllConnections();await Promise.all([peer?.close(),model&&new Promise(resolve=>model.close(resolve))]);
  report.configSha256=gateway?.configSha256;
  if(report.passed)rmSync(root,{recursive:true,force:true});else {report.diagnosticsRoot=root;process.exitCode=1;}
  report.fixtureCleaned=!existsSync(root);
  writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
  console.log(JSON.stringify({passed:report.passed,cases:report.cases.length,error:report.error}));
}
