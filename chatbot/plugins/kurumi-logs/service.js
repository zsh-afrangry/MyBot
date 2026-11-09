// Read-only query orchestration. Only the fixed CLI adapter opens diagnostic sources.
import {noTextProjection} from '../../packages/observability/query-privacy.js';
import {settings,queryOptions,LogQueryError,RESULT_BYTES} from './policy.js';
import {readQuery} from './query.js';
export function technicalResult(value, q, maxBytes = RESULT_BYTES - 1800) {
  if (!value || value.schemaVersion !== 1 || !Number.isSafeInteger(value.total) || value.total < 0) throw new LogQueryError('invalid_response');
  const result = noTextProjection(value);
  delete result.calls;
  const key = q.view === 'errors' ? 'items' : 'events';
  if (q.view !== 'stats' && !Array.isArray(result[key])) throw new LogQueryError('invalid_response');
  const original = result[key]?.length;
  while (Buffer.byteLength(JSON.stringify(result)) > maxBytes) {
    if (!result[key]?.length) throw new LogQueryError('output_limit');
    result[key].pop();
  }
  if (original !== undefined) {
    const shown = result[key].length;
    if (original > 0 && shown === 0) throw new LogQueryError('output_limit');
    result.shown = shown;
    result.nextOffset = q.offset + shown < result.totalRows ? q.offset + shown : null;
    result.truncated = result.nextOffset !== null;
  }
  return {status:'ok',coverage:'stored_events_only',queriedSources:q.sources,...result};
}
export class LogQueryService {
  #busy = false;
  constructor(config, {read = readQuery, now = Date.now} = {}) { this.config=settings(config); this.read=read; this.now=now; }
  async query(args, {signal} = {}) {
    const q = queryOptions(args,this.now()); signal?.throwIfAborted();
    if (this.#busy) throw new LogQueryError('busy');
    this.#busy = true;
    try { const value = await this.read(this.config,q,{signal}); signal?.throwIfAborted(); return technicalResult(value,q); }
    finally { this.#busy = false; }
  }
}
