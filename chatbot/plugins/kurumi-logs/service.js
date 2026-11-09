// Read-only query orchestration. Only the fixed CLI adapter opens diagnostic sources.
import {settings,queryOptions,LogQueryError,RESULT_BYTES} from './policy.js';
import {readQuery} from './query.js';
export function technicalResult(value, q, maxBytes = RESULT_BYTES - 1800) {
  if (!value || value.schemaVersion !== 1 || !Number.isSafeInteger(value.total) || value.total < 0) throw new LogQueryError('invalid_response');
  const key = ['errors','overview'].includes(q.view) ? 'items' : 'events';
  if (!value.chunked && q.view !== 'stats' && !Array.isArray(value[key])) throw new LogQueryError('invalid_response');
  const result={status:'ok',coverage:'stored_events_only',queriedSources:q.sources,...value};
  // The backend paginates serialized content before crossing the child boundary.
  // No field allowlist, character filter, deletion of calls or silent row trimming.
  if (Buffer.byteLength(JSON.stringify(result)) > maxBytes) throw new LogQueryError('output_limit');
  return result;
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
