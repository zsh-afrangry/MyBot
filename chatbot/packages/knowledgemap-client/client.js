// Fixed-origin asynchronous API client. Contract: docs/23_KnowledgeMap业务能力桥接.md.
import {readFileSync, statSync, mkdirSync, appendFileSync, existsSync, renameSync} from 'node:fs';
import {isAbsolute, join} from 'node:path';
import {createHash} from 'node:crypto';
import {normalizeTraceEvent} from '../../../scripts/fusion/lib/trace-events.mjs';

export class BridgeError extends Error {
  constructor(code, message, status = 0) {super(message); this.code = code; this.status = status;}
  toJSON() {return {ok: false, error: {code: this.code, message: this.message}};}
}
export const requestKey = (domain, request) => domain + ':' + createHash('sha256').update(`${request.sessionKey}:${request.messageId}`).digest('hex');

export class KnowledgeMapClient {
  constructor({baseUrl = 'http://127.0.0.1:3086', tokenFile, timeoutMs = 15000, fetchImpl = fetch, trace} = {}) {
    const url = new URL(baseUrl);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new BridgeError('invalid_config', '业务API必须是配置的本机固定地址');
    if (typeof tokenFile !== 'string' || !isAbsolute(tokenFile)) throw new BridgeError('invalid_config', '需要专用凭据文件的绝对路径');
    this.baseUrl = url.origin; this.tokenFile = tokenFile; this.timeoutMs = timeoutMs; this.fetchImpl = fetchImpl;
    this.trace = trace ?? (event => {
      if (!process.env.OPENCLAW_STATE_DIR) return;
      const dir = join(process.env.OPENCLAW_STATE_DIR, 'state', 'knowledgemap');
      mkdirSync(dir, {recursive: true, mode: 0o700});
      const file = join(dir, 'trace.jsonl');
      if (existsSync(file) && statSync(file).size >= 4 * 1024 * 1024) renameSync(file, file + '.1');
      const {runId, requestKey, itemId, ...data} = event;
      appendFileSync(file, JSON.stringify(normalizeTraceEvent({source: 'knowledgemap', kind: 'business.api',
        correlation: {runId, requestKey, businessId: itemId}, data})) + '\n', {mode: 0o600});
    });
  }
  async request(path, {method = 'GET', query = {}, body, key, runId, signal} = {}) {
    if (!/^\/api\/assistant\/[a-z]+(?:\/[a-z]+)?$/.test(path)) throw new BridgeError('invalid_path', '不允许任意API路径');
    if (!['GET', 'POST'].includes(method)) throw new BridgeError('invalid_method', '本轮不开放此HTTP动作');
    let token;
    try {
      if (statSync(this.tokenFile).mode & 0o077) throw Error();
      token = readFileSync(this.tokenFile, 'utf8').trim();
      if (!/^[\x21-\x7e]{32,256}$/.test(token)) throw Error();
    } catch {throw new BridgeError('credential_unavailable', '专用业务凭据不可用');}
    const url = new URL(path, this.baseUrl);
    for (const [name, value] of Object.entries(query)) if (value !== undefined && value !== null && value !== '') url.searchParams.set(name, String(value));
    const started = Date.now();
    let code = 'ok', status = 0, result;
    try {
      const response = await this.fetchImpl(url, {method, redirect: 'error',
        headers: {Authorization: 'Bearer ' + token, Accept: 'application/json',
          ...(body === undefined ? {} : {'Content-Type': 'application/json'}), ...(key ? {'Idempotency-Key': key} : {}),
          ...(runId ? {'X-Kurumi-Run-Id': runId} : {})},
        ...(body === undefined ? {} : {body: JSON.stringify(body)}),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs)});
      status = response.status;
      if (!response.headers.get('content-type')?.includes('json')) throw new BridgeError('invalid_response', '业务API未返回JSON', status);
      const reader = response.body?.getReader();
      let size = 0; const parts = [];
      if (!reader) throw new BridgeError('invalid_response', '业务API返回空响应', status);
      try {
        while (true) {
          const part = await reader.read(); if (part.done) break;
          size += part.value.length;
          if (size > 2 * 1024 * 1024) {await reader.cancel(); throw new BridgeError('invalid_response', '业务API响应超限', status);}
          parts.push(part.value);
        }
      } finally {reader.releaseLock();}
      try {result = JSON.parse(Buffer.concat(parts).toString('utf8'));}
      catch {throw new BridgeError('invalid_response', '业务API返回无效JSON', status);}
      if (!response.ok) {
        const detail = result?.detail;
        throw new BridgeError(typeof detail?.code === 'string' ? detail.code : 'api_rejected',
          typeof detail?.message === 'string' ? detail.message.slice(0, 240) : '业务API拒绝请求；请核对字段或刷新后重试', status);
      }
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new BridgeError('invalid_response', '业务API返回无效契约', status);
      return result;
    } catch (error) {
      const uncertain = method === 'POST' && (!(error instanceof BridgeError) || error.code === 'invalid_response' || status >= 500);
      const safe = !uncertain && error instanceof BridgeError ? error : new BridgeError(method === 'POST' ? 'write_result_unknown' : 'api_unavailable',
        method === 'POST' ? '未取得确定写入结果；仅可用相同参数重试核对，不能另建一条' : '业务API暂不可用，未读取到业务事实');
      code = safe.code; throw safe;
    } finally {
      try {this.trace({method, path, requestKey: key ?? null, runId: runId ?? null, code, status,
        durationMs: Date.now() - started, itemId: result?.item?.id ?? null});} catch { /* Observation failure cannot rewrite a committed business result. */ }
    }
  }
  async allTasks({history = false, query = '', signal} = {}) {
    const items = [], seen = new Set(); let skip = 0, snapshot;
    for (let page = 0; page < 50; page++) {
      const result = await this.request('/api/assistant/tasks', {query: {history, query, skip, limit: 200, snapshot}, signal});
      if (result.ok !== true || !Array.isArray(result.items) || !Number.isSafeInteger(result.total) || !/^[a-f0-9]{64}$/.test(result.snapshot ?? '')) throw new BridgeError('invalid_response', '事项列表契约不符');
      if (snapshot && result.snapshot !== snapshot) throw new BridgeError('list_changed', '列表在分页期间变化，请重新查询');
      snapshot = result.snapshot;
      for (const item of result.items) {
        if (!Number.isSafeInteger(item.id) || seen.has(item.id)) throw new BridgeError('invalid_response', '事项分页包含无效或重复ID');
        seen.add(item.id);
      }
      items.push(...result.items);
      if (!result.truncated) {
        if (items.length !== result.total) throw new BridgeError('list_changed', '列表在分页期间变化，请重新查询');
        return items;
      }
      if (!result.items.length) throw new BridgeError('invalid_response', '事项分页未前进');
      skip += result.items.length;
    }
    throw new BridgeError('list_too_large', '列表超出本轮读取上限，未声称返回完整列表');
  }
}

export function clientFromEnvironment(env = process.env) {
  return new KnowledgeMapClient({baseUrl: env.KURUMI_KM_BASE_URL ?? 'http://127.0.0.1:3086', tokenFile: env.KURUMI_KM_TOKEN_FILE});
}
