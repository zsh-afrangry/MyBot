// Execution relationships are evidence, never guesses based on timestamps or prose.
import {traceId,readExecutionDetail,EVIDENCE_STORE} from '../observability/execution.js';
import {eventReference} from './log-query-privacy.mjs';
import {pairCalls} from './log-query-views.mjs';

const terminal=new Set(['succeeded','failed','cancelled','interrupted','completed','error','denied','platform_accepted','not_requested']);
const nodeKey=(execution,span)=>'node:'+traceId(execution,span);
const callKey=c=>JSON.stringify([c.sessionId??c.sessionKey??'',c.toolCallId]);
const countKeys=['inputTokens','outputTokens','reasoningTokens','cacheReadTokens','cacheWriteTokens'];

export function executionTree(events,{nodeId,executionId,detail,offset=0,limit=50,now=Date.now()}={}) {
  const nodes=new Map(),latest=new Map(),calls=new Map();
  const add=(id,values)=>{const node={id,details:{},references:[],issues:[],...values};nodes.set(id,node);return node;};
  for(const event of events){
    const c=event.correlation??{},d=event.data??{};
    if(event.kind!=='execution.node'||!c.executionId||!c.spanId)continue;
    const id=nodeKey(c.executionId,c.spanId);
    let node=nodes.get(id);
    if(!node)node=add(id,{executionId:c.executionId,spanId:c.spanId,parentId:c.parentSpanId?nodeKey(c.executionId,c.parentSpanId):null,
      business:d.business??event.source,type:d.type??'stage',name:d.name??d.type,relationship:'explicit',correlation:c,startedAtMs:event.epochMs});
    node.startedAtMs=Math.min(node.startedAtMs,d.startedAtMs??event.epochMs);
    node.finishedAtMs=terminal.has(d.status)?Math.max(node.finishedAtMs??0,event.epochMs):node.finishedAtMs;
    node.status=d.status??node.status;node.selfUsage=d.usage??node.selfUsage;
    node.usageKnown=d.usageKnown??node.usageKnown;
    node.measuredDurationMs=d.durationMs??node.measuredDurationMs;
    node.details={...node.details,...d.details};node.references.push(eventReference(event));
    node.links=d.links??node.links;node.captureStatus=d.captureStatus??node.captureStatus;
    node.expectedRequests=d.expectedRequests??node.expectedRequests;
    latest.set(id,event);
    if(node.type==='tool'&&c.toolCallId)calls.set(callKey(c),node);
  }
  // Host records supply generic tool input/output. Explicit domain trees take precedence.
  const sessions=new Map();
  for(const e of events){const c=e.correlation??{};if(c.toolCallId&&e.kind.startsWith('agent.tool_')){
    const key=c.sessionId??c.sessionKey??'';if(!sessions.has(key))sessions.set(key,[]);sessions.get(key).push(e);
  }}
  for(const values of sessions.values())for(const call of pairCalls(values)){
    const c=call.correlation,key=callKey(c);let node=calls.get(key);
    if(!node){
      const exec='host:'+traceId(c.sessionId??c.sessionKey,c.runId??c.toolCallId),rootId=nodeKey(exec,'root');
      if(!nodes.has(rootId))add(rootId,{executionId:exec,spanId:'root',business:'tools',type:'execution',name:'工具执行',status:'observed',parentId:null,relationship:c.runId?'host_run':'single_call',startedAtMs:call.epochMs});
      node=add(nodeKey(exec,key),{executionId:exec,spanId:key,parentId:rootId,business:'tools',type:'tool',name:call.tool,status:call.outcome,relationship:'host_call',correlation:c,startedAtMs:call.epochMs});
    }
    const members=values.filter(e=>e.correlation.toolCallId===call.toolCallId||e.correlation.parentToolCallId===call.toolCallId);
    for(const e of members){
      node.references.push(eventReference(e));
      if(e.kind==='agent.tool_call'&&!node.details.input)node.details.input={status:'inline',eventRef:eventReference(e),field:'arguments'};
      if(e.kind==='agent.tool_result'&&!node.details.result)node.details.result={status:'inline',eventRef:eventReference(e),field:'result'};
    }
  }
  for(const node of nodes.values()){
    if(node.parentId&&!nodes.has(node.parentId)){node.issues.push('parent_not_in_query');node.parentId=null;}
    const seen=new Set([node.id]);let parent=nodes.get(node.parentId);
    while(parent){if(seen.has(parent.id)){node.issues.push('parent_cycle');node.parentId=null;break;}seen.add(parent.id);parent=nodes.get(parent.parentId);}
  }
  const children=new Map();
  for(const node of nodes.values()){const k=node.parentId??null;if(!children.has(k))children.set(k,[]);children.get(k).push(node);}
  for(const group of children.values())group.sort((a,b)=>(a.startedAtMs??0)-(b.startedAtMs??0)||a.id.localeCompare(b.id));
  const aggregate=node=>{
    const usage={requests:0,unknownUsageRequests:0};
    if(node.type==='api'){
      usage.requests=1;
      if(node.usageKnown===false||!Number.isFinite(node.selfUsage?.inputTokens)||!Number.isFinite(node.selfUsage?.outputTokens))usage.unknownUsageRequests=1;
      for(const key of countKeys)if(Number.isFinite(node.selfUsage?.[key]))usage[key]=node.selfUsage[key];
    }
    for(const child of children.get(node.id)??[]){const sub=aggregate(child);for(const key of ['requests','unknownUsageRequests',...countKeys])if(sub[key]!==undefined)usage[key]=(usage[key]??0)+sub[key];}
    usage.scope='captured_api_requests';
    if(Number.isSafeInteger(node.expectedRequests)&&node.expectedRequests>usage.requests){
      usage.missingRequestDetails=node.expectedRequests-usage.requests;node.issues.push('request_details_missing');
    }
    if(usage.inputTokens!==undefined&&usage.outputTokens!==undefined)usage.totalTokens=usage.inputTokens+usage.outputTokens;
    node.usage=usage;return usage;
  };
  for(const root of children.get(null)??[])aggregate(root);
  const summary=node=>{const {selfUsage,measuredDurationMs,...value}=node;return{...value,childCount:(children.get(node.id)??[]).length,
    references:[...new Set(node.references)],durationMs:measuredDurationMs??(node.finishedAtMs===undefined?null:node.finishedAtMs-node.startedAtMs)};};
  let parent=null,rows;
  if(nodeId?.startsWith('business:')){
    rows=(children.get(null)??[]).filter(node=>node.business===nodeId.slice(9));
    parent={id:nodeId,type:'business',name:nodeId.slice(9),childCount:rows.length};
  }else if(nodeId){
    const node=nodes.get(nodeId);if(!node)throw Error('Unknown node in query range');
    if(executionId&&node.executionId!==executionId)throw Error('Node does not belong to execution');
    parent=summary(node);rows=children.get(nodeId)??[];
    if(detail){
      const ref=node.details[detail];let body;
      if(!ref)body={status:'not_collected'};
      else if(ref.status==='inline'){
        const e=events.find(e=>eventReference(e)===ref.eventRef);
        body=e?{...ref,content:ref.field==='arguments'?e.data.arguments:e.data.expanded?.content??e.data.expanded?.result??e.data}:{status:'not_in_query'};
      }else{
        const file=latest.get(nodeId)?.[EVIDENCE_STORE];
        try{body=file?readExecutionDetail(file,ref,{now}):{...ref,status:ref.status==='stored'?'untrusted_reference':ref.status};}
        catch{body={...ref,status:'read_failed'};}
      }
      return{view:'tree',total:nodes.size,shown:1,nodes:[parent],node:parent,detail:{name:detail,...body},offset:0,nextOffset:null};
    }
  }else{
    rows=(children.get(null)??[]).filter(node=>!executionId||node.executionId===executionId);
    if(!executionId){
      const groups=new Map();for(const node of rows){if(!groups.has(node.business))groups.set(node.business,[]);groups.get(node.business).push(node);}
      // Business categories are navigation nodes, not runtime executions.
      for(const[business,list]of groups){const id='business:'+business;nodes.set(id,{id,type:'business',name:business,business,details:{},references:[],issues:[],childCount:list.length});}
      rows=[...groups].map(([business,list])=>({id:'business:'+business,type:'business',name:business,business,parentId:null,childCount:list.length,executions:list.length}));
    }
  }
  const selected=rows.slice(offset,offset+limit).map(node=>node.type==='business'?node:summary(node));
  return{view:'tree',coverage:'captured_nodes_only',total:nodes.size,totalRows:rows.length,shown:selected.length,offset,nextOffset:offset+limit<rows.length?offset+limit:null,truncated:offset+limit<rows.length,
    ...(parent?{node:parent}:{}),nodes:selected,unassignedEvents:events.filter(e=>e.kind!=='execution.node'&&!e.kind.startsWith('agent.tool_')).length};
}

export function backgroundUsage(events) {
  const latest=new Map();
  for(const e of events)if(e.kind==='execution.node'&&e.data.type==='api')latest.set(JSON.stringify([e.correlation.executionId,e.correlation.spanId]),e);
  const requests=[...latest.values()].map(e=>({executionId:e.correlation.executionId,spanId:e.correlation.spanId,status:e.data.status,usage:e.data.usage??{},usageKnown:e.data.usageKnown===true}));
  const usage={requests:requests.length,unknownUsageRequests:requests.filter(r=>!r.usageKnown).length};
  for(const row of requests)for(const key of countKeys)if(Number.isFinite(row.usage[key]))usage[key]=(usage[key]??0)+row.usage[key];
  if(usage.inputTokens!==undefined&&usage.outputTokens!==undefined)usage.totalTokens=usage.inputTokens+usage.outputTokens;
  return{backgroundRequests:requests,backgroundUsage:usage};
}
