/**
 * Cross-module trace event contract used by the read-only log query layer.
 *
 * The runtime keeps its source logs and databases as the source of truth. This
 * module only normalizes events and, when a caller explicitly asks for it,
 * appends a private JSONL event to a configured trace sink. It never prints
 * credentials and it never turns on tracing by itself.
 */
import fs from 'node:fs';
import path from 'node:path';

export const TRACE_SCHEMA_VERSION = 1;

const SECRET_KEY = /(?:token|secret|password|passwd|authorization|cookie|api[_-]?key|credential|private[_-]?key)/iu;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/giu;
const API_KEY = /\b(?:sk|key|token)[-_][A-Za-z0-9._~-]{12,}\b/giu;

export function redactText(value) {
  return String(value)
    .replace(BEARER, 'Bearer [REDACTED]')
    .replace(API_KEY, '[REDACTED]');
}

export function redactValue(value, key = '') {
  if (SECRET_KEY.test(key)) return '[REDACTED]';
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redactValue(item, name)]));
  }
  return value;
}

export function epochMs(value, fallback = Date.now()) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 10_000_000_000 ? Math.floor(value * 1000) : Math.floor(value);
  }
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export function normalizeTraceEvent(input = {}) {
  const atMs = epochMs(input.epochMs ?? input.at ?? input.timestamp);
  const correlation = input.correlation && typeof input.correlation === 'object'
    ? redactValue(input.correlation)
    : {};
  return {
    schemaVersion: TRACE_SCHEMA_VERSION,
    at: new Date(atMs).toISOString(),
    epochMs: atMs,
    source: String(input.source ?? 'unknown'),
    kind: String(input.kind ?? 'log'),
    correlation,
    data: redactValue(input.data && typeof input.data === 'object' ? input.data : {}),
    ...(input.sourceRef ? {sourceRef: redactValue(input.sourceRef)} : {}),
  };
}

/**
 * Create a small append-only sink for modules that want to emit structured
 * events. The caller owns the path and must opt in; the file is private by
 * default and every line is independently parseable.
 */
export function createTraceSink(file, {mkdir = fs.mkdirSync, append = fs.appendFileSync, chmod = fs.chmodSync} = {}) {
  const target = path.resolve(file);
  return {
    file: target,
    emit(event) {
      mkdir(path.dirname(target), {recursive: true, mode: 0o700});
      const normalized = normalizeTraceEvent(event);
      append(target, `${JSON.stringify(normalized)}\n`, {encoding: 'utf8', mode: 0o600});
      try { chmod(target, 0o600); } catch { /* An existing read-only test sink may reject chmod. */ }
      return normalized;
    },
  };
}

export function summarizeText(value, limit = 320) {
  const text = redactText(String(value ?? '')).replace(/\s+/gu, ' ').trim();
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

export function correlationFrom(value = {}) {
  const names = [
    'sessionId', 'sessionKey', 'runId', 'traceId', 'spanId', 'parentSpanId',
    'qqMessageId', 'replyToId', 'proposalId', 'payloadHash', 'reminderId',
    'cronJobId', 'taskId', 'conversationId', 'senderId', 'recipientId', 'eventKey',
  ];
  const result = {};
  for (const name of names) {
    const candidate = value[name];
    if (candidate !== undefined && candidate !== null && String(candidate).trim()) result[name] = String(candidate);
  }
  return result;
}
