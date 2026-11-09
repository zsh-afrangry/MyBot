// Compatibility export; shared technical-output policy. Contract: docs/18.
export {noTextProjection} from '../../chatbot/packages/observability/query-privacy.js';
import {normalizeTraceEvent} from '../../chatbot/packages/observability/index.js';
import {createHash} from 'node:crypto';

// Stable across views, text projection, expansion and correlation enrichment.
export function eventReference(event) {
  return 'event:'+createHash('sha256').update(JSON.stringify([
    event.source,event.kind,event.at,event.sourceRef??null,event.correlation?.toolCallId??null,
    ...(event.sourceRef?[]:[event.data]),
  ])).digest('hex').slice(0,32);
}

// Conservative upper bound for OpenClaw 2026.11 CJK-aware live text budgeting.
// Common CJK costs four chars; other Unicode uses the UTF-8 worst case. Avoid
// importing hashed kernel internals. Recheck this bound on a kernel upgrade.
export function queryTextWeight(text) {
  let total=0;
  for(const character of text){const cp=character.codePointAt(0);
    total+=cp<=127?1:cp===183||cp>=12288&&cp<=12703||cp>=19968&&cp<=40869||cp>=44032&&cp<=55215||cp>=65281&&cp<=65376?4:Buffer.byteLength(character)*4;
  }
  return total;
}
export function queryOutputFits(value,{outputBytes,outputChars}={}) {
  const text=JSON.stringify(value);
  return (outputBytes===undefined||Buffer.byteLength(text)<=outputBytes)&&(outputChars===undefined||queryTextWeight(text)<=outputChars);
}

// Only the explicit owner-authorized query path selects fullContent. Runtime
// append-only sinks retain their existing write-time redaction unchanged.
export function normalizeQueryEvent(input, {fullContent = false} = {}) {
  const normal = normalizeTraceEvent(input);
  if (!fullContent) return normal;
  return {...input,...normal,correlation:input.correlation ?? {},data:input.data ?? {},...(input.sourceRef ? {sourceRef:input.sourceRef} : {})};
}

// Content pagination preserves every serialized character, including one very
// large record. Cursors are UTF-16 positions; never split a surrogate pair.
export function paginateQueryContent(value, {outputBytes, outputChars, contentOffset = 0, contentHash} = {}) {
  if (outputBytes === undefined) {if(contentOffset || contentHash !== undefined)throw Error('Content cursor requires output-bytes');return value;}
  if (!Number.isSafeInteger(outputBytes) || outputBytes < 2000 || outputBytes > 512*1024 || !Number.isSafeInteger(contentOffset) || contentOffset < 0) throw Error('Invalid content pagination');
  if(outputChars!==undefined&&(!Number.isSafeInteger(outputChars)||outputChars<2000||outputChars>512*1024))throw Error('Invalid character budget');
  const text=JSON.stringify(value);
  const hash=createHash('sha256').update(text).digest('hex');
  if(contentHash !== undefined && contentHash !== hash)throw Error('Content changed; restart this page from contentOffset=0');
  if(contentOffset>text.length || contentOffset && /[\uDC00-\uDFFF]/u.test(text[contentOffset]??'') && /[\uD800-\uDBFF]/u.test(text[contentOffset-1]))throw Error('Invalid content offset');
  if(contentOffset===0 && queryOutputFits(value,{outputBytes,outputChars}))return value;
  const base={schemaVersion:1,view:value.view,from:value.from,to:value.to,total:value.total,totalRows:value.totalRows,shown:value.shown,offset:value.offset,nextOffset:value.nextOffset,truncated:value.truncated,chunked:true,contentEncoding:'json-text',contentOffset,contentLength:text.length,contentHash:hash};
  const endAt=n=>n>contentOffset && /[\uDC00-\uDFFF]/u.test(text[n]??'') && /[\uD800-\uDBFF]/u.test(text[n-1])?n-1:n;
  const result=end=>({...base,nextContentOffset:end<text.length?end:null,contentFragment:text.slice(contentOffset,end)});
  let low=contentOffset,high=text.length;
  while(low<high){const middle=Math.ceil((low+high)/2);if(queryOutputFits(result(endAt(middle)),{outputBytes,outputChars}))low=middle;else high=middle-1;}
  const end=endAt(low);if(end===contentOffset&&end<text.length)throw Error('Content budget too small');
  return result(end);
}
