// Compatibility export; shared technical-output policy. Contract: docs/18.
export {noTextProjection} from '../../chatbot/packages/observability/query-privacy.js';
import {normalizeTraceEvent} from '../../chatbot/packages/observability/index.js';
import {createHash} from 'node:crypto';

// Only the explicit owner-authorized query path selects fullContent. Runtime
// append-only sinks retain their existing write-time redaction unchanged.
export function normalizeQueryEvent(input, {fullContent = false} = {}) {
  const normal = normalizeTraceEvent(input);
  if (!fullContent) return normal;
  return {...input,...normal,correlation:input.correlation ?? {},data:input.data ?? {},...(input.sourceRef ? {sourceRef:input.sourceRef} : {})};
}

// Content pagination preserves every serialized character, including one very
// large record. Cursors are UTF-16 positions; never split a surrogate pair.
export function paginateQueryContent(value, {outputBytes, contentOffset = 0, contentHash} = {}) {
  if (outputBytes === undefined) {if(contentOffset || contentHash !== undefined)throw Error('Content cursor requires output-bytes');return value;}
  if (!Number.isSafeInteger(outputBytes) || outputBytes < 2000 || outputBytes > 512*1024 || !Number.isSafeInteger(contentOffset) || contentOffset < 0) throw Error('Invalid content pagination');
  const text=JSON.stringify(value);
  const hash=createHash('sha256').update(text).digest('hex');
  if(contentHash !== undefined && contentHash !== hash)throw Error('Content changed; restart this page from contentOffset=0');
  if(contentOffset>text.length || contentOffset && /[\uDC00-\uDFFF]/u.test(text[contentOffset]??'') && /[\uD800-\uDBFF]/u.test(text[contentOffset-1]))throw Error('Invalid content offset');
  if(contentOffset===0 && Buffer.byteLength(text)<=outputBytes)return value;
  const base={schemaVersion:1,view:value.view,from:value.from,to:value.to,total:value.total,totalRows:value.totalRows,shown:value.shown,offset:value.offset,nextOffset:value.nextOffset,truncated:value.truncated,chunked:true,contentEncoding:'json-text',contentOffset,contentLength:text.length,contentHash:hash};
  const endAt=n=>n>contentOffset && /[\uDC00-\uDFFF]/u.test(text[n]??'') && /[\uD800-\uDBFF]/u.test(text[n-1])?n-1:n;
  const result=end=>({...base,nextContentOffset:end<text.length?end:null,contentFragment:text.slice(contentOffset,end)});
  let low=contentOffset,high=text.length;
  while(low<high){const middle=Math.ceil((low+high)/2);if(Buffer.byteLength(JSON.stringify(result(endAt(middle))))<=outputBytes)low=middle;else high=middle-1;}
  const end=endAt(low);if(end===contentOffset&&end<text.length)throw Error('Content budget too small');
  return result(end);
}
