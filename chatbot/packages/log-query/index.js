/**
 * Read-only cross-module event query.
 *
 * Sources are deliberately adapters: SnowLuma and OpenClaw keep their own
 * native logs, while this command presents a stable event envelope. A future
 * module can either add an adapter here or emit the same envelope through
 * chatbot/packages/observability/index.js; no business operation is performed by this command.
 */
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {readHostRecords} from '../session-records/index.js';
import {
  correlationFrom,
  epochMs,
  normalizeTraceEvent,
  redactValue,
  summarizeText,
} from '../observability/index.js';
import {
  applyViewFilters,
  auditTurns,
  collectErrors,
  eventError,
  deepParseJson,
  formatAudit,
  formatErrors,
  formatEvent,
  formatListing,
  formatTurns,
  groupTurns,
  localTime,
  pairCalls,
  RAW_KINDS,
} from './log-query-views.mjs';

import {normalizeToolResult} from './log-query-result.mjs';
import {noTextProjection,normalizeQueryEvent,paginateQueryContent,eventReference,queryOutputFits} from './log-query-privacy.mjs';
import {stateSnapshot,readCronRuns,knownWarning,selectRecentTurns,queryStatistics,tabularEvents,followQueries,readStoredQQMessages} from './log-query-diagnostics.mjs';

import {DEFAULT_RUNTIME_ROOT,DEFAULT_SNOWLUMA_ROOT,parseQueryInstant,readSnowLumaLogs,readRuntimeLog,readReceiptFile,readReminderListDatabase,readChannelDelivery,attachTurnCorrelation,attachRuntimeCorrelation,transcriptEvents,agentDatabases,readReminderDatabase,readTraceFile,attachSessionCorrelation,safeRead} from './source-adapters.js';
export * from './source-adapters.js';
import {traceSources,SOURCES} from './sources.js';
import {readPaperHistory} from './paper-history.js';
import {executionTree} from './execution-tree.js';
import {privateInteractions} from './private-interactions.js';
import {dailyFeedbackQuery} from './daily-feedback-query.js';
import {readDailyFeedback} from './daily-feedback.js';
/** Spread-free append: `push(...list)` overflows the call stack once a source yields ~100k rows. */
function append(target, items) {
  for (const item of items) target.push(item);
}

export function collectEvents({from, to, runtimeRoot = DEFAULT_RUNTIME_ROOT, snowlumaRoot = DEFAULT_SNOWLUMA_ROOT, sources, expand = false, fullContent = false, messageId,peer,executionId} = {}) {
  const wanted=sources?new Set(sources):undefined;
  if(wanted&&[...wanted].some(id=>!SOURCES.includes(id)))throw Error('Unknown log source');
  const include=name=>!wanted||wanted.has(name),events=[],windows=[],sourceStatus=[];
  const read=(source,file,fn)=>{
    const status={source,status:'available',...(file?{path:file}:{})};sourceStatus.push(status);
    if(file&&!fs.existsSync(file)){status.status='missing';return;}
    const options={expand,fullContent,onIssue:()=>{status.status='partial';status.reason='unreadable_records';}};
    try{const rows=fn(options)??[];append(events,rows);status.count=rows.length;}
    catch(error){status.status='read_failed';status.reason=error.code??'source_read_error';}
  };
  if(include('cron-runs'))read('cron-runs',path.join(runtimeRoot,'state','openclaw.sqlite'),o=>readCronRuns(runtimeRoot,from,to,o));
  if(include('channel-delivery'))read('channel-delivery',path.join(runtimeRoot,'channel','channel.sqlite'),o=>readChannelDelivery(path.join(runtimeRoot,'channel','channel.sqlite'),from,to,{...o,messageId}));
  if(include('snowluma'))read('snowluma',path.join(snowlumaRoot,'runtime','logs'),o=>readSnowLumaLogs(snowlumaRoot,from,to,o));
  if(include('openclaw-runtime'))read('openclaw-runtime',runtimeRoot,o=>{
    const list=[];for(const name of fs.readdirSync(runtimeRoot).filter(n=>/^runtime(?:\.\d+)?\.log$/u.test(n)).sort())append(list,readRuntimeLog(path.join(runtimeRoot,name),from,to,o));return list;
  });
  if(include('openclaw-receipt'))for(const name of ['task-receipts.jsonl','reminder-receipts.jsonl','native-tool-receipts.jsonl']){
    const file=path.join(runtimeRoot,'channel',name);read('openclaw-receipt',file,o=>readReceiptFile(file,from,to,o));
  }
  if(include('openclaw-session')){
    const databases=agentDatabases(runtimeRoot);
    if(!databases.length)sourceStatus.push({source:'openclaw-session',status:'missing'});
    for(const file of databases)read('openclaw-session',file,o=>{const value=transcriptEvents(file,from,to,o);append(windows,value.windows);return value.events;});
  }else if(include('snowluma')){
    const file=path.join(runtimeRoot,'agents','main','agent','openclaw-agent.sqlite');
    if(fs.existsSync(file))read('openclaw-session',file,o=>{append(windows,transcriptEvents(file,from,to,o).windows);return[];});
  }
  for(const [id,relative,reader] of [['personal-reminders','personal-reminders/reminders.sqlite',readReminderDatabase],['personal-reminder-list','personal-reminder-list/list.sqlite',readReminderListDatabase]]){
    if(include(id)){const file=path.join(runtimeRoot,'state',relative);read(id,file,o=>reader(file,from,to,o));}
  }
  let config={};try{config=JSON.parse(safeRead(path.join(runtimeRoot,'openclaw.json'))||'{}');}catch{sourceStatus.push({source:'configuration',status:'read_failed'});}
  for(const source of traceSources(runtimeRoot,config))if(include(source.id)){
    if(!source.file){sourceStatus.push({source:source.id,status:'not_configured'});continue;}
    const files=[source.file+'.1',source.file].filter(fs.existsSync);
    if(!files.length)sourceStatus.push({source:source.id,status:'missing',path:source.file});
    for(const file of files)read(source.id,file,o=>readTraceFile(file,from,to,o));
    if(source.paperRoot)read('papers',source.paperRoot,o=>readPaperHistory(source.paperRoot,from,to,{...o,executionId}));
  }
  if(wanted?.has('snowluma-messages'))read('snowluma-messages',undefined,o=>readStoredQQMessages(snowlumaRoot,runtimeRoot,from,to,{messageId,peer,expand,previews:events.filter(e=>e.source==='snowluma'),...o}));
  attachSessionCorrelation(events,windows);attachTurnCorrelation(events);attachRuntimeCorrelation(events);
  events.sort((a,b)=>a.epochMs-b.epochMs||a.source.localeCompare(b.source)||a.kind.localeCompare(b.kind));
  events.sourceStatus=sourceStatus;return events;
}

function containsEvent(eventValue, text) {
  return JSON.stringify(eventValue).toLocaleLowerCase('zh-CN').includes(String(text).toLocaleLowerCase('zh-CN'));
}

function matchesQuery(item,filters) {
  if(filters.code){
    const codes=new Set(),visit=value=>{if(!value||typeof value!=='object')return;for(const [key,child]of Object.entries(value)){if(['code','failureCode','errorCode'].includes(key)&&typeof child==='string')codes.add(child);else if(child&&typeof child==='object')visit(child);}};
    visit(item.data);const classified=eventError(item,{fullContent:true});if(classified)codes.add(classified.code);
    if(!codes.has(filters.code))return false;
  }
  if(filters.levels?.length && !filters.levels.some(level=>String(item.data?.level ?? '').toUpperCase()===String(level).toUpperCase()))return false;
  if(filters.contains && !containsEvent(item,filters.contains))return false;
  const terms=filters.keywords ?? [];
  return !terms.length || (filters.keywordMode==='all' ? terms.every(term=>containsEvent(item,term)) : terms.some(term=>containsEvent(item,term)));
}

export function filterEvents(events, filters = {}) {
  if(filters.code){
    const refs=new Set(collectErrors(events,undefined,{details:true,fullContent:true}).items.filter(e=>e.code===filters.code).flatMap(e=>(e.details??[]).map(eventReference)));
    events=events.filter(item=>refs.has(eventReference(item))||matchesQuery(item,{code:filters.code}));
    filters={...filters,code:undefined};
  }
  if(filters.eventRef)events=events.filter(item=>eventReference(item)===filters.eventRef);
  if(filters.eventKey)events=events.filter(item=>item.correlation.eventKey===filters.eventKey);
  if(filters.cronJobId)events=events.filter(item=>item.correlation.cronJobId===filters.cronJobId);
  if(filters.peer){
    if(!/^\d{5,12}$/.test(filters.peer))throw Error('Invalid peer');
    events=events.filter(e=>e.correlation.subjectId===filters.peer||e.correlation.senderId===filters.peer||e.correlation.recipientId===filters.peer||String(e.correlation.sessionKey??'').endsWith(':kurumi-qq:direct:'+filters.peer));
  }
  if(filters.lastTurns!==undefined)events=selectRecentTurns(events,Number(filters.lastTurns));
  if (filters.messageId) {
    events = events.filter(item => !['reminder-list.feedback', 'qq.image_feedback'].includes(item.kind)
      || item.correlation.qqMessageId === String(filters.messageId));
  }
  const idFilters = ['messageId', 'proposalId', 'runId', 'sessionKey', 'reminderId'];
  const requested = idFilters.filter((name) => filters[name]);
  if (!requested.length) return events.filter((item) => matchesQuery(item,filters));
  const seeds = events.filter(item => requested.every(name => {
    if (name === 'messageId' && item.source === 'channel-delivery') {
      return [item.correlation.qqMessageId, item.data.sourceMessageId, item.data.receiptId].includes(String(filters.messageId));
    }
    return Object.values(item.correlation).some(value => String(value) === String(filters[name]));
  }));
  const selected = new Set(seeds);
  // Correlation closure joins a QQ turn to its tool result and a reminder
  // proposal to its committed/delivered record without broadening to every
  // event in the conversation's session.
  // A nested tool's parentToolCallId names the outer call, so both IDs share
  // the toolCallId namespace.
  const keys = ['executionId','spanId','qqMessageId', 'replyToId', 'proposalId', 'payloadHash', 'reminderId', 'cronJobId', 'eventKey', 'runId', 'taskId', 'toolCallId'];
  const namespace = key => key==='parentToolCallId'?'toolCallId':key==='parentSpanId'?'spanId':key;
  const joinValues = (item) => [...keys, 'parentToolCallId','parentSpanId'].filter((key) => item.correlation[key]).flatMap((key) => {
    const name=namespace(key),c=item.correlation;
    // Span IDs such as "root" or "request:1" repeat in every execution.
    // Host tool IDs are likewise scoped by session, including nested calls.
    if(name==='spanId'&&!c.executionId)return[];
    const scope=name==='spanId'?c.executionId:name==='toolCallId'?(c.sessionKey??c.sessionId??''):'';
    return [JSON.stringify([name,scope,c[key]])];
  });
  const index = new Map();
  for (const item of events) for (const value of joinValues(item)) index.set(value, [...(index.get(value) ?? []), item]);
  const queue = [...seeds];
  const seen = new Set();
  while (queue.length) {
    for (const value of joinValues(queue.shift())) {
      if (seen.has(value)) continue;
      seen.add(value);
      for (const candidate of index.get(value) ?? []) if (!selected.has(candidate)) { selected.add(candidate); queue.push(candidate); }
    }
  }
  return events.filter((item) => selected.has(item) && matchesQuery(item,filters));
}

function usage() {
  return `用法：node chatbot/scripts/log-query.mjs [选项]

  --from <时间>       起始时间（带时区 ISO；无时区按 Asia/Shanghai）
  --to <时间>         结束时间
  --since <30m|2h|30d|all> 相对时间窗或全部留存历史，不与--from组合
  --peer <QQ>         只看对应私聊/可信收发账号，不推测身份
  --last-turns <N>    当前时间窗内最近N个模型回合
  --interactions-for <本人QQ>  只查其他账号的 Fusion 私聊文本，最新在前；可用 --peer / --direction / --expand
  --snapshot <类型>   memory/reminders/reminder-list/documents/cron，只读当前状态
  --stats             当前筛选范围的来源/工具失败率、耗时和模型用量
  --format <格式>     text/table/markdown；表格只显示技术字段
  --fields <列,...>   time,source,kind,tool,outcome,durationMs,runId,messageId
  --offset <N>        固定时间窗内按行分页，nextOffset为后续页
  --show-known        展开精确识别的可选模型目录刷新警告
  --follow            持续只读跟随，Ctrl+C退出（JSON为一行一个包）
  --interval <毫秒>   跟随间隔100..60000，默认1000
  --contains <文本>   按事件内容筛选
  --keyword <文本>    可重复；按完整记录字面检索，no-text不降低召回
  --keyword-mode <any|all> 多关键词命中任意/全部，默认any
  --level <级别>      可重复；按原生级别筛选，如ERROR/FATAL
  --context-before <N> 命中前事件数0..1000，邻居不按关键词/类型/级别过滤
  --context-after <N> 命中后事件数0..1000，仍限本次时间/来源
  --message-id <ID>   按 QQ 消息 ID 筛选（自动带出同一链路的事件）
  --proposal-id <ID>  按提醒提案筛选
  --run-id <ID>       按后台/模型运行 ID 筛选
  --session-key <键>  按 OpenClaw 会话筛选
  --reminder-id <ID>  按提醒 ID 筛选
  --source <名称>     可重复；限制为适配器名称。snowluma-messages须显式选择并附message-id/peer
  --exclude-source <名称> 可重复；排除适配器
  --kind <前缀>       可重复；只看这些事件类型，前缀匹配（如 agent.tool_）
  --exclude-kind <前缀> 可重复；排除事件类型，前缀匹配
  --no-text           显式选择无正文技术摘要，保留原样代码/关联ID
  --full-content      读取登记来源已有完整内容，不追加查询脱敏
  --output-bytes <N>  JSON内容分段预算2000..524288字节，不删除字段
  --content-offset <N> 照抄nextContentOffset，固定时间/筛选/行页继续取内容
  --content-hash <值> 照抄contentHash；内容变化则重新读该页
  --raw               显示未分类的原生日志行（openclaw.log、snowluma.log，默认隐藏）
  --expand, --full    展开完整工具参数与结果、不截断文本（可能含聊天原文）
  --turns             按回合汇总：用户说 → 工具 → 回复，/new 与压缩显示为分段
  --tree              业务分类、执行和节点；--node-id 展开子节点，--detail 读取命名明细\n  --execution-id <ID> 限定执行；--node-id <ID> 定位节点；--detail <名称> 如 request/response/receipt\n  --overview          错误码、来源与业务尝试概览，含稳定eventRef
  --event-ref <引用>  精确展开该事件（仍限时间/来源）
  --event-key <键>    精确业务键，列表为日期T时刻
  --daily-feedback <reminder-list|weather> --scheduled-at <时间>  按计划时刻核对播报与QQ受理
  --cron-job-id <ID> 精确Cron任务
  --code <错误码>    精确筛选业务及嵌套异常码
  --errors            只看错误与拒绝，并按错误码计数
  --audit             每回合被拒绝的工具与同一工具的连续重试
  --runtime-root <目录> 运行状态根目录
  --snowluma-root <目录> SnowLuma 根目录
  --json              输出 JSON（默认视图另含 calls 与 hiddenRaw）
  --limit <数量>      最多输出多少条（默认 500）
  --help              显示本帮助

默认文本视图把同一次工具调用的调用、访问决定、真实工具和结果合并为一行 [tool.call]。
`;
}

const VALUE_FLAGS = ['--from', '--to', '--contains', '--message-id', '--proposal-id', '--run-id', '--session-key', '--reminder-id', '--source', '--exclude-source', '--kind', '--exclude-kind', '--runtime-root', '--snowluma-root', '--limit', '--since', '--peer', '--last-turns', '--snapshot', '--format', '--fields', '--offset', '--interval','--keyword','--keyword-mode','--level','--context-before','--context-after','--output-bytes','--content-offset','--content-hash','--output-chars','--code','--event-key','--cron-job-id','--event-ref','--node-id','--execution-id','--detail','--interactions-for','--direction','--daily-feedback','--scheduled-at'];
const LIST_FLAGS = {'--source': 'sources', '--exclude-source': 'excludeSources', '--kind': 'kinds', '--exclude-kind': 'excludeKinds','--keyword':'keywords','--level':'levels'};
const BOOLEAN_FLAGS = {'--no-text': 'noText', '--json': 'json', '--raw': 'raw', '--expand': 'expand', '--full': 'expand', '--turns': 'turns', '--errors': 'errors', '--audit': 'audit', '--stats':'stats','--overview':'overview','--tree':'tree', '--follow':'follow', '--show-known':'showKnown','--full-content':'fullContent'};

function parseArgs(argv) {
  const result = {sources: [], excludeSources: [], kinds: [], excludeKinds: [], keywords:[], levels:[]};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help') return {...result, help: true};
    if (BOOLEAN_FLAGS[arg]) { result[BOOLEAN_FLAGS[arg]] = true; continue; }
    const equal=String(arg).indexOf('=');
    const [flag,inline]=equal<0?[String(arg),undefined]:[String(arg).slice(0,equal),String(arg).slice(equal+1)];
    if (!VALUE_FLAGS.includes(flag)) throw new Error(`未知参数：${arg}`);
    const value = inline ?? argv[++index];
    if (value === undefined) throw new Error(`缺少参数值：${flag}`);
    const key = flag.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
    if (LIST_FLAGS[flag]) result[LIST_FLAGS[flag]].push(value); else result[key] = value;
  }
  if (result.dailyFeedback !== undefined) {
    const allowed = ['dailyFeedback', 'scheduledAt', 'cronJobId', 'runtimeRoot', 'json'];
    if (Object.entries(result).some(([key, value]) => !allowed.includes(key) && (!Array.isArray(value) || value.length))) throw Error('Invalid daily feedback query');
  } else if (result.scheduledAt !== undefined) throw Error('Scheduled time requires --daily-feedback');
  if (result.interactionsFor !== undefined) {
    const allowed = ['interactionsFor','peer','direction','eventRef','expand','from','to','since','limit','offset','contentOffset','contentHash','outputBytes','outputChars','runtimeRoot','json'];
    if (Object.entries(result).some(([key, value]) => !allowed.includes(key) && (!Array.isArray(value) || value.length))) throw Error('Invalid private interaction query');
  } else if (result.direction !== undefined) throw Error('Direction requires --interactions-for');
  if (['turns', 'errors', 'audit', 'stats', 'overview', 'tree', 'snapshot'].filter((name) => result[name]).length > 1) throw new Error('只能选择一个查询视图');
  if(result.format&&!['text','table','markdown'].includes(result.format))throw Error('Invalid format');
  if((result.fields||result.format&&result.format!=='text')&&(result.turns||result.errors||result.audit||result.stats||result.overview||result.snapshot))throw Error('Table formatting requires event view');
  if(result.since&&result.from)throw Error('since and from are mutually exclusive');
  if(result.snapshot&&(result.peer||result.lastTurns||result.contains||result.messageId||result.runId||result.sessionKey||result.proposalId||result.reminderId||result.sources.length||result.kinds.length))throw Error('snapshot is current owner state; event filters cannot be combined');
  if(result.follow&&(result.snapshot||result.lastTurns||result.offset||result.to))throw Error('follow cannot combine snapshot/last-turns/offset/to');
  if(result.keywordMode && !['any','all'].includes(result.keywordMode))throw Error('Invalid keyword mode');
  for(const name of ['contextBefore','contextAfter','contentOffset','outputBytes','outputChars'])if(result[name]!==undefined){result[name]=Number(result[name]);if(!Number.isSafeInteger(result[name])||result[name]<0||['contextBefore','contextAfter'].includes(name)&&result[name]>1000)throw Error('Invalid '+name);}
  if((result.contextBefore||result.contextAfter)&&(result.stats||result.overview||result.turns||result.audit||result.snapshot))throw Error('Context requires events/errors view');
  return result;
}

export function runCli(argv = process.argv.slice(2), now = Date.now()) {
  const args = parseArgs(argv);
  if (args.help) { console.log(usage()); return 0; }
  const runtimeRoot=args.runtimeRoot??DEFAULT_RUNTIME_ROOT;
  if (args.dailyFeedback !== undefined) {
    const query = dailyFeedbackQuery({broadcast: args.dailyFeedback, scheduledAt: args.scheduledAt, cronJobId: args.cronJobId});
    console.log(JSON.stringify(readDailyFeedback(runtimeRoot, query, now), null, 2));
    return 0;
  }
  const duration=args.since && args.since!=='all'?parseDuration(args.since):60*60*1000;
  const from = parseQueryInstant(args.from, args.since==='all'?0:now - duration),to = parseQueryInstant(args.to, now);
  if ((args.from&&!Number.isFinite(parseQueryInstant(args.from,NaN)))||(args.to&&!Number.isFinite(parseQueryInstant(args.to,NaN)))||!Number.isFinite(from)||!Number.isFinite(to)||from>to)throw Error('时间范围无效');
  if (args.interactionsFor !== undefined) {
    const result = privateInteractions({...args,runtimeRoot,from,to,ownerId:args.interactionsFor,
      limit:Number(args.limit??10),offset:Number(args.offset??0)});
    console.log(JSON.stringify(result,null,2));return 0;
  }
  if(args.snapshot){const value=stateSnapshot(runtimeRoot,args.snapshot,{expand:args.expand,now});console.log(JSON.stringify(args.noText?noTextProjection(value):value,null,2));return 0;}
  const read=(start,end)=>collectEvents({from:start,to:end,runtimeRoot,snowlumaRoot:args.snowlumaRoot??DEFAULT_SNOWLUMA_ROOT,sources:args.sources.length?args.sources:undefined,expand:Boolean(args.expand || args.fullContent),fullContent:Boolean(args.fullContent),messageId:args.messageId,peer:args.peer});
  const emit=(events,start,end,following=false)=>{let offset=Number(args.offset??0);do{const rendered=renderQuery(events,{...args,offset,from:start,to:end});console.log(args.json?JSON.stringify(rendered.json,null,following?0:2):rendered.lines.join('\n'));offset=following?rendered.json.nextOffset:null;}while(offset!=null);};
  if(args.follow){
    const controller=new AbortController(),stop=()=>controller.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);
    return followQueries({from,read,emit:(events,start,end)=>emit(events,start,end,true),intervalMs:Number(args.interval??1000),signal:controller.signal}).finally(()=>{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);});
  }
  emit(read(from,to),from,to);return 0;
}
export function parseDuration(value){
 const match=/^([1-9]\d*)(s|m|h|d)$/.exec(value??'');if(!match)throw Error('Invalid since duration');
 const ms=Number(match[1])*({s:1000,m:60000,h:3600000,d:86400000}[match[2]]);if(!Number.isSafeInteger(ms)||!Number.isFinite(new Date(Date.now()-ms).getTime()))throw Error('Invalid since duration');return ms;
}

/**
 * Pure rendering for the CLI: correlation filters, then view filters, then the
 * selected view. The default JSON keeps schemaVersion 1 fields and only adds
 * `hiddenRaw` and `calls`; view modes add a `view` field with their own data.
 */
function queryLimit(value) {
  const requested = Number(value ?? 500);
  return Number.isFinite(requested) ? Math.max(1, Math.min(5000, Math.floor(requested))) : 500;
}

function addQueryContext(value, events, anchors, options) {
  const before=options.contextBefore ?? 0, after=options.contextAfter ?? 0;
  if(!before && !after)return value;
  const key=e=>JSON.stringify([e.source,e.kind,e.at,e.sourceRef,e.correlation]);
  const keys=new Set(anchors.map(key)),pool=events.filter(e=>!(options.excludeSources??[]).includes(e.source));
  const selected=new Set();let matched=0;
  for(let n=0;n<pool.length;n++)if(keys.has(key(pool[n]))){matched++;for(let i=Math.max(0,n-before);i<=Math.min(pool.length-1,n+after);i++)selected.add(i);}
  return {...value,contextBefore:before,contextAfter:after,contextAnchors:matched,
    contextEvents:pool.filter((_,n)=>selected.has(n)).map(e=>({...e,contextRole:keys.has(key(e))?'match':'neighbor'})),contextWithinQueryWindow:true};
}

function renderQueryInternal(events, options = {}) {
  const {from, to, limit: rawLimit, raw = false, expand = false, turns, errors, audit} = options;
  const correlated = filterEvents(events, options).map(knownWarning);
  const viewFilters = {kinds: options.kinds ?? [], excludeKinds: options.excludeKinds ?? [], excludeSources: options.excludeSources ?? [],showKnown:options.showKnown};
  // --errors keeps native WARN/ERROR lines; they are often the only trace of a host failure.
  const knownFiltered=options.showKnown?correlated:correlated.filter(e=>!e.data.known);
  const hiddenKnown=correlated.length-knownFiltered.length;
  const values = applyViewFilters(knownFiltered, {...viewFilters, raw: raw || Boolean(errors)});
  const hiddenRaw = applyViewFilters(knownFiltered, {...viewFilters, raw: true}).filter((item) => RAW_KINDS.has(item.kind)).length
    - values.filter((item) => RAW_KINDS.has(item.kind)).length;
  const limit = queryLimit(rawLimit),offset=Number(options.offset??0);
  if(!Number.isSafeInteger(offset)||offset<0)throw Error('Invalid offset');
  const page=rows=>({offset,nextOffset:offset+limit<rows.length?offset+limit:null,totalRows:rows.length,truncated:offset+limit<rows.length});
  const range = {from: new Date(from).toISOString(), to: new Date(to).toISOString()};
  const window = `（${localTime(from)} 至 ${localTime(to)}）`;
  const rawNote = hiddenRaw ? `，已隐藏原生日志 ${hiddenRaw} 行（--raw 显示）` : '';
  if(options.tree){const tree=executionTree(values,{...options,offset,limit});return{json:{schemaVersion:1,...range,...tree},lines:[JSON.stringify(tree,null,2)]};}
  if(options.overview){
    const found=collectErrors(values,undefined,{fullContent:Boolean(options.fullContent)}),sources=new Map();
    for(const e of values)sources.set(e.source,(sources.get(e.source)??0)+1);
    const rows=found.items.map(item=>({...item,sourceRef:undefined,epochMs:undefined}));
    return{json:{schemaVersion:1,view:'overview',...range,total:values.length,errorRecords:found.recordCount,counts:found.counts,
      businessAttemptCount:found.businessAttemptCount,businessAttemptBasis:found.businessAttemptBasis,unkeyedErrorRecords:found.unkeyedErrorRecords,
      sources:[...sources].map(([source,count])=>({source,count})),shown:rows.slice(offset,offset+limit).length,...page(rows),items:rows.slice(offset,offset+limit)},lines:[]};
  }
  if(options.stats){const stats=queryStatistics(values);return{json:{schemaVersion:1,...range,hiddenKnown,...stats},lines:[JSON.stringify(stats,null,2)]};}
  if (turns || audit) {
    const grouped = groupTurns(values);
    if (audit) {
      const rows = auditTurns(grouped.turns);
      const flagged = rows.filter((row) => row.flagged);
      return {
        json: {schemaVersion: 1, view: 'audit', ...range, total: rows.length, flagged: flagged.length, shown: rows.slice(offset,offset+limit).length, ...page(rows), hiddenKnown, turns: rows.slice(offset, offset+limit)},
        lines: formatAudit(rows.slice(offset), {limit}).map((line, index) => index ? line : `审计 ${line}${window}`),
      };
    }
    const timeline = grouped.timeline.slice(offset, offset+limit);
    return {
      json: {schemaVersion: 1, view: 'turns', ...range, total: grouped.turns.length, shown: timeline.filter((item) => item.kind === 'turn').length, hiddenRaw, hiddenKnown, ...page(grouped.timeline), orphanEvents: grouped.orphanEvents, timeline},
      lines: [`回合 ${grouped.turns.length}${window}${rawNote}`, ...formatTurns({timeline, orphanEvents: grouped.orphanEvents}, {full: expand})],
    };
  }
  if (errors) {
    const found = collectErrors(values,undefined,{details:Boolean(options.fullContent || options.contextBefore || options.contextAfter),fullContent:Boolean(options.fullContent)});
    const items = found.items.slice(offset,offset+limit);
    return {
      json: addQueryContext({schemaVersion: 1, view: 'errors', ...range, total: found.items.length, shown: items.length, counts: found.counts, hiddenKnown, ...page(found.items), items,recordCount:found.recordCount,correlationGroups:found.correlationGroups,countBasis:found.countBasis,
        businessAttemptCount:found.businessAttemptCount,businessAttemptBasis:found.businessAttemptBasis,unkeyedErrorRecords:found.unkeyedErrorRecords},events,items.flatMap(item=>item.details??[]),options),
      lines: [`错误与拒绝 ${items.length}/${found.items.length}${window}`, ...formatErrors({items, counts: found.counts})],
    };
  }
  const selected = values.slice(offset,offset+limit);
  const calls = pairCalls(selected);
  return {
    json: addQueryContext({schemaVersion: 1, ...range, total: values.length, shown: selected.length, hiddenRaw, hiddenKnown, ...page(values), events: selected, calls},events,selected,options),
    lines: [`链路事件 ${selected.length}/${values.length}${window}${rawNote}`, ...formatListing(selected, {expand, calls})],
  };
}

export function renderQuery(events, options = {}) {
  const sourceStatus=events.sourceStatus??[];
  events=events.map(item=>({...item,eventRef:eventReference(item)}));
  const present = input => {
    const value={...input,sourceStatus};
    const event = item => {
      let result={...item};
      if(result.data&&typeof result.data.text==='string')result.data={...result.data,textLength:result.data.text.length,displayTruncated:!options.expand&&result.data.text.length>260};
      if(options.fullContent&&!options.expand){const {original,...rest}=result;const {expanded,...data}=rest.data??{};result={...rest,...(rest.data?{data}:{})};}
      return result;
    };
    if(value.events)value.events=value.events.map(event);
    if(value.contextEvents)value.contextEvents=value.contextEvents.map(event);
    if(value.items)value.items=value.items.map(item=>({...item,...(item.details?{details:item.details.map(event)}:{})}));
    if(options.fullContent)value.detailsExpanded=!!options.expand;
    return options.noText?noTextProjection({...value,noText:true}):value;
  };
  // Fit complete presented records, including metadata added below. Only an
  // individual oversize record or global context needs lossless JSON fragments.
  const fits=value=>queryOutputFits(present(value),options);
  let rendered=renderQueryInternal(events,options);
  if(options.outputBytes!==undefined&&rendered.json.shown>1&&!fits(rendered.json)){
    let low=1,high=rendered.json.shown-1,best;
    while(low<=high){const n=Math.floor((low+high)/2),candidate=renderQueryInternal(events,{...options,limit:n});if(fits(candidate.json)){best=candidate;low=n+1;}else high=n-1;}
    rendered=best??renderQueryInternal(events,{...options,limit:1});
  }
  const value=present(rendered.json),paged=paginateQueryContent(value,options);
  rendered.json=paged;
  if(options.noText||paged!==value||options.overview)return{json:paged,lines:[JSON.stringify(paged)]};
  if(options.fields||options.format==='table'||options.format==='markdown')rendered.lines=tabularEvents(value.events??[],options);
  if(value.hiddenKnown)rendered.lines.push('已折叠明确识别的可选目录警告 '+value.hiddenKnown+' 条（--show-known 展开）。');
  if(value.truncated)rendered.lines.push('本页之后仍有记录：固定--from/--to及筛选，使用--offset '+value.nextOffset+' 继续。');
  return rendered;
}
