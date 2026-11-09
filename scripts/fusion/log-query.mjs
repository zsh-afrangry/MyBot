#!/usr/bin/env node

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
import {readHostRecords} from '../../chatbot/packages/session-records/index.js';
import {fileURLToPath} from 'node:url';
import {
  correlationFrom,
  epochMs,
  normalizeTraceEvent,
  redactValue,
  summarizeText,
} from '../../chatbot/packages/observability/index.js';
import {
  applyViewFilters,
  auditTurns,
  collectErrors,
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
import {noTextProjection,normalizeQueryEvent,paginateQueryContent} from './log-query-privacy.mjs';
import {stateSnapshot,readCronRuns,knownWarning,selectRecentTurns,queryStatistics,tabularEvents,followQueries,readStoredQQMessages} from './log-query-diagnostics.mjs';

export {formatEvent};

export const DEFAULT_RUNTIME_ROOT = '/home/afrangry/.openclaw-fusion';
export const DEFAULT_SNOWLUMA_ROOT = '/home/afrangry/snowluma';
const SHANGHAI_OFFSET = '+08:00';

function parseJson(value) {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (!text || !['{', '['].includes(text[0])) return value;
  try { return JSON.parse(text); } catch { return value; }
}

function safeRead(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function linesOf(file) {
  const text = safeRead(file);
  return text ? text.split(/\r?\n/u) : [];
}

function sourceRef(file, line, extra = {}) {
  return {path: file, line, ...extra};
}

function event(input) {
  return normalizeTraceEvent(input);
}

function parseLocalDateTime(value) {
  if (typeof value === 'number') return epochMs(value);
  const text = String(value ?? '').trim();
  if (!text) return NaN;
  if (/^\d{4}-\d\d-\d\d \d\d:\d\d(?::\d\d(?:\.\d+)?)?$/u.test(text)) {
    return Date.parse(text.replace(' ', 'T') + SHANGHAI_OFFSET);
  }
  const withoutZone = /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?$/u.test(text);
  const parsed = Date.parse(withoutZone ? `${text}${SHANGHAI_OFFSET}` : text);
  return Number.isFinite(parsed) ? parsed : NaN;
}

export function parseQueryInstant(value, fallback) {
  const parsed = parseLocalDateTime(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseSnowLumaDate(file, time) {
  const match = path.basename(file).match(/snowluma-(\d{4}-\d\d-\d\d)\.log$/u);
  if (!match) return parseLocalDateTime(time);
  return Date.parse(`${match[1]}T${time}${SHANGHAI_OFFSET}`);
}

// Kept as a pure line parser so unit tests and future file tailers can reuse it.
export function parseSnowLumaLine(line, file, lineNumber, options = {}) {
  const event = input => normalizeQueryEvent({...input,...(options.fullContent && options.expand ? {original:line} : {})},options);
  const match = String(line).match(/^(\d\d:\d\d:\d\d)\s+(\S+)\s+(.*)$/u);
  if (!match) return undefined;
  const [, clock, level, detail] = match;
  const at = parseSnowLumaDate(file, clock);
  if (!Number.isFinite(at)) return undefined;

  const inbound = detail.match(/\[Event\]\s+私聊\s+\[([^\]]+)\]\s*:\s*ID:([+-]?\d+)\s*(.*)$/u);
  if (inbound) {
    const sender = inbound[1].match(/\((\d+)\)/u)?.[1];
    return event({
      at,
      source: 'snowluma',
      kind: 'qq.inbound',
      correlation: correlationFrom({qqMessageId: inbound[2], senderId: sender}),
      data: {level, senderLabel: inbound[1], text: inbound[3] ?? '', direction: 'inbound', textCompleteness: 'preview-unknown'},
      sourceRef: sourceRef(file, lineNumber),
    });
  }

  const outbound = detail.match(/\[OneBot\]\s+私聊\s+(\d+)\s+\|\s+发送：(?:\[回复:([+-]?\d+)\]\s*)?(.*)$/u);
  if (outbound) {
    return event({
      at,
      source: 'snowluma',
      kind: 'qq.outbound',
      correlation: correlationFrom({recipientId: outbound[1], replyToId: outbound[2]}),
      data: {level, recipientId: outbound[1], replyToId: outbound[2] ?? null, text: outbound[3] ?? '', direction: 'outbound', textCompleteness: 'preview-unknown'},
      sourceRef: sourceRef(file, lineNumber),
    });
  }

  if (options.fullContent || detail.includes('[Bridge.Action]') || level === 'WARN' || level === 'ERROR') {
    return event({
      at,
      source: 'snowluma',
      kind: 'snowluma.log',
      data: {level, message: detail},
      sourceRef: sourceRef(file, lineNumber),
    });
  }
  return undefined;
}

export function readSnowLumaLogs(root, from, to, options = {}) {
  const dir = path.join(root, 'runtime', 'logs');
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir)
    .filter((name) => /^snowluma-\d{4}-\d\d-\d\d\.log$/u.test(name))
    .map((name) => path.join(dir, name))
    .sort();
  const output = [];
  for (const file of files) {
    let continuation;
    linesOf(file).forEach((line, index) => {
      const parsed = parseSnowLumaLine(line, file, index + 1, options);
      if (parsed) {
        output.push(parsed);
        continuation = ['qq.outbound', 'qq.inbound'].includes(parsed.kind) || options.fullContent && parsed.kind === 'snowluma.log' ? parsed : undefined;
      } else if (continuation && line.trim() && !/^\d\d:\d\d:\d\d\s+/u.test(line)) {
        const key=continuation.kind==='snowluma.log'?'message':'text';
        continuation.data[key] = `${continuation.data[key]}\n${options.fullContent ? line : line.trim()}`;
        if(options.fullContent && options.expand)continuation.original+='\n'+line;
      } else if (/^\d\d:\d\d:\d\d\s+/u.test(line)) {
        continuation = undefined;
      }
    });
  }
  return output.filter((item) => item.epochMs >= from && item.epochMs <= to);
}

function runtimeMessage(record) {
  const value = record?.message ?? record?.['2'] ?? record?.['1'] ?? '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function runtimeCorrelation(record, nested) {
  const extra = record?.['1'] && typeof record['1'] === 'object' ? record['1'] : {};
  const correlation = correlationFrom({...record, ...extra, ...(nested && typeof nested === 'object' ? nested : {})});
  if (record?.jobId && !correlation.cronJobId) correlation.cronJobId = String(record.jobId);
  if (extra?.jobId && !correlation.cronJobId) correlation.cronJobId = String(extra.jobId);
  if (nested?.jobId && !correlation.cronJobId) correlation.cronJobId = String(nested.jobId);
  if (record?.declarationKey) correlation.eventKey = String(record.declarationKey);
  if (extra?.declarationKey) correlation.eventKey = String(extra.declarationKey);
  if (nested?.declarationKey) correlation.eventKey = String(nested.declarationKey);
  return correlation;
}

export function parseRuntimeLine(line, file, lineNumber, options = {}) {
  let record;
  try { record = JSON.parse(line); } catch { return undefined; }
  const event = input => normalizeQueryEvent({...input,...(options.fullContent && options.expand ? {original:record} : {})},options);
  const at = parseLocalDateTime(record.time ?? record._meta?.date ?? record._meta?.runtimeDate);
  if (!Number.isFinite(at)) return undefined;
  const subsystem = parseJson(record['0'])?.subsystem ?? String(record['0'] ?? 'openclaw');
  const message = runtimeMessage(record);
  const nested = parseJson(message);
  let kind = 'openclaw.log';
  const data = {subsystem, message: nested ?? message};
  const level = record._meta?.logLevelName;
  if (typeof level === 'string') data.level = level;
  if (nested?.component === 'personal-confirmation') kind = 'confirmation.recorded';
  else if (/personal-weather reminder reconciler:/u.test(message)) {
    kind = 'reminder.reconcile';
    const counts = {};
    for (const pair of message.matchAll(/(scanned|adopted|delivered|failed|retries|unknown|warnings)=(\d+)/gu)) counts[pair[1]] = Number(pair[2]);
    data.counts = counts;
  } else if (/cron: job added/u.test(message)) kind = 'cron.job_added';
  else if (/^tool-search:/u.test(message)) kind = 'agent.tool_search';
  else if (subsystem === 'outbound/session') kind = 'outbound.session_warning';
  return event({
    at,
    source: 'openclaw-runtime',
    kind,
    correlation: runtimeCorrelation(record, nested),
    data,
    sourceRef: sourceRef(file, lineNumber),
  });
}

export function readRuntimeLog(file, from, to, options = {}) {
  if (!fs.existsSync(file)) return [];
  return linesOf(file).map((line, index) => parseRuntimeLine(line, file, index + 1, options)).filter(Boolean)
    .filter((item) => item.epochMs >= from && item.epochMs <= to);
}

function namedIds(value, result = {}) {
  if (Array.isArray(value)) {
    for (const item of value) namedIds(item, result);
    return result;
  }
  if (!value || typeof value !== 'object') return result;
  for (const [key, child] of Object.entries(value)) {
    if (['sessionId', 'sessionKey', 'runId', 'traceId', 'spanId', 'parentSpanId', 'qqMessageId', 'messageId', 'replyToId', 'proposalId', 'payloadHash', 'reminderId', 'cronJobId', 'jobId', 'taskId', 'conversationId'].includes(key) && (typeof child === 'string' || typeof child === 'number')) {
      const name = key === 'messageId' ? 'qqMessageId' : key === 'jobId' ? 'cronJobId' : key;
      result[name] ??= String(child);
    }
    namedIds(child, result);
  }
  return result;
}

function receiptData(record) {
  const data = {};
  for (const key of ['action', 'kind', 'projectId', 'tool', 'error', 'ok', 'status']) {
    if (record[key] !== undefined) data[key] = record[key];
  }
  if (record.result && typeof record.result === 'object') {
    data.resultKeys = Object.keys(record.result);
    if (record.result.status !== undefined) data.resultStatus = record.result.status;
    if (record.result.ok !== undefined) data.resultOk = record.result.ok;
  }
  return data;
}

export function parseReceiptLine(line, file, lineNumber, options = {}) {
  let record;
  try { record = JSON.parse(line); } catch { return undefined; }
  const event = input => normalizeQueryEvent({...input,...(options.fullContent && options.expand ? {original:record} : {})},options);
  const at = epochMs(record.at ?? record.timestamp ?? record.createdAt);
  const base = path.basename(file);
  const sourceName = base.replace(/-receipts\.jsonl$/u, '');
  const kind = sourceName === 'reminder' ? 'reminder.receipt'
    : sourceName === 'task' ? 'task.receipt'
      : sourceName === 'native-tool' ? 'tool.receipt' : 'channel.receipt';
  return event({
    at,
    source: 'openclaw-receipt',
    kind,
    correlation: correlationFrom(namedIds(record)),
    data: receiptData(record),
    sourceRef: sourceRef(file, lineNumber),
  });
}

export function readReceiptFile(file, from, to, options = {}) {
  if (!fs.existsSync(file)) return [];
  return linesOf(file).map((line, index) => parseReceiptLine(line, file, index + 1, options)).filter(Boolean)
    .filter((item) => item.epochMs >= from && item.epochMs <= to);
}

function transcriptText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((item) => item?.type === 'text').map((item) => item.text ?? '').join('\n');
}

function toolResultSummary(message, {fullContent = false} = {}) {
  const text = transcriptText(message.content);
  return {...normalizeToolResult({...message, content: Array.isArray(message.content) ? message.content : [{type: 'text', text}]}),
    correlation: namedIds(parseJson(text)), textPreview: fullContent ? text : summarizeText(text)};
}

/** Wrapped calls name the real tool in `arguments.id` (`openclaw:<plugin>:<tool>`
 * or the bare tool name); results repeat it as `tool` (string or object). */
function wrappedToolName(value) {
  if (typeof value === 'string' && value.trim()) return value.split(':').at(-1);
  if (value && typeof value === 'object' && typeof value.name === 'string') return value.name;
  return undefined;
}

function shortError(value, {fullContent = false} = {}) {
  if (value === undefined || value === null || value === '') return undefined;
  if (fullContent) return value;
  if (typeof value === 'object') return redactValue({code: value.code, message: value.message === undefined ? undefined : summarizeText(value.message, 160)});
  return summarizeText(value, 160);
}

/** User entries carry no runId; the run that answers them does. Bind each
 * inbound to the next runId in the same session window, stopping at /new. */
function attachInboundRun(events) {
  const pending = new Map();
  for (const item of events) {
    const session = item.correlation.sessionId;
    if (!session) continue;
    if (item.kind === 'agent.inbound') {
      if (!item.correlation.runId) pending.set(session, [...(pending.get(session) ?? []), item]);
    } else if (item.kind === 'session.reset') pending.delete(session);
    else if (item.correlation.runId && pending.has(session)) {
      for (const inbound of pending.get(session)) inbound.correlation.runId = item.correlation.runId;
      pending.delete(session);
    }
  }
}

function transcriptEvents(dbFile, from, to, {expand = false, fullContent = false} = {}) {
  const event = input => normalizeQueryEvent(input,{fullContent});
  const output = [];
  try {
    const {rows, windows} = readHostRecords(dbFile, {from, to});
    for (const row of rows) {
      const record = row.record;
      const message = record.message ?? {};
      const window = windows.find((candidate) => candidate.sessionId === row.sessionId);
      const baseCorrelation = correlationFrom({
        sessionId: row.sessionId,
        sessionKey: window?.sessionKey,
        runId: record.__openclaw?.runId ?? message.__openclaw?.runId ?? record.data?.runId,
        conversationId: window?.conversationId,
      });
      const at = record.timestamp ?? row.createdAt;
      const ref = sourceRef(dbFile, row.seq, {table: 'transcript_events', sessionId: row.sessionId});
      const push = (kind, data, correlation = baseCorrelation) => output.push(event({at, source: 'openclaw-session', kind, correlation, data, sourceRef: ref,...(fullContent && expand ? {original:record} : {})}));
      const contents = Array.isArray(message.content) ? message.content : [];
      // Session segment markers: /new keeps the sessionId, so it is only visible here.
      if(record.type==='model_change')push('session.model_change',{provider:record.provider,model:record.modelId,fallbackKnown:false});
      else if (record.type === 'reset') push('session.reset', {reason: record.reason ?? null});
      else if (record.type === 'compaction') {
        push('session.compaction', {tokensBefore: record.tokensBefore ?? null, tokensAfter: record.tokensAfter ?? null,
          summaryChars: String(record.summary ?? '').length, fromHook: record.fromHook === true});
      } else if (record.type === 'custom' && record.customType === 'openclaw:prompt-error') {
        push('agent.prompt_error', {provider: record.data?.provider, model: record.data?.model, error: shortError(record.data?.error,{fullContent})});
      } else if (record.type === 'custom_message' && record.customType === 'openclaw:turn-aborted') {
        push('agent.turn_aborted', {});
      }
      if (message.role === 'user') {
        push('agent.inbound', {text: transcriptText(message.content), role: 'user'});
      } else if (message.role === 'assistant') {
        const usage=message.usage;
        if(usage||message.provider||message.model){
          const counters={};for(const key of ['input','output','cacheRead','cacheWrite','totalTokens','inputTokens','outputTokens'])if(Number.isFinite(usage?.[key]))counters[key]=usage[key];
          push('agent.model_usage',{provider:message.provider,model:message.model,stopReason:message.stopReason??null,usage:counters,usageAvailable:!!usage});
        }
        if (message.errorMessage) push('agent.model_error', {stopReason: message.stopReason ?? null, provider: message.provider, model: message.model, error: shortError(message.errorMessage,{fullContent})});
        for (const part of contents) {
          if (part?.type === 'toolCall' || part?.type === 'tool_use') {
            const argumentsValue = part.arguments ?? part.input ?? {};
            const ids = namedIds(argumentsValue);
            const declared = part.name ?? part.toolName ?? 'unknown';
            const actual = ['tool_call', 'dispatch_action'].includes(declared) ? wrappedToolName(argumentsValue?.id) ?? declared : declared;
            push('agent.tool_call', {tool: actual, declaredTool: declared, arguments: fullContent ? argumentsValue : redactValue(argumentsValue), ...(expand ? {expanded: {arguments: deepParseJson(argumentsValue)}} : {})},
              {...baseCorrelation, ...correlationFrom(ids), ...(part.id ? {toolCallId: String(part.id)} : {})});
          } else if (part?.type === 'text' && String(part.text ?? '').trim()) {
            push('agent.reply', {text: part.text, role: 'assistant'});
          }
        }
      } else if (message.role === 'toolResult' || message.role === 'tool') {
        const summary = toolResultSummary(message,{fullContent});
        const wrapper = parseJson(transcriptText(message.content));
        const details = message.details && typeof message.details === 'object' ? message.details : {};
        const declared = message.toolName ?? message.name ?? 'unknown';
        const tool = wrappedToolName(wrapper?.tool) ?? wrappedToolName(details.tool) ?? declared;
        const status = message.isError === true ? 'error' : 'ok';
        push('agent.tool_result', {tool, ...summary, declaredTool: declared, isError: message.isError === true, status,
          ...(details.status !== undefined ? {hostStatus: details.status} : {}),
          ...(details.error !== undefined ? {error: shortError(details.error,{fullContent})} : {}),
          ...(expand ? {expanded: {content: deepParseJson(transcriptText(message.content)), details: deepParseJson(details)}} : {})},
        {...baseCorrelation, ...correlationFrom(summary.correlation), ...(message.toolCallId ? {toolCallId: String(message.toolCallId)} : {})});
      } else if (message.role === 'custom' && message.customType === 'openclaw.nested-tool.v1') {
        // One record per real tool behind a `tool_call` wrapper; the parent ID is the outer call.
        const details = message.details ?? {};
        const result = details.result ?? {};
        const normalized = normalizeToolResult(result);
        const startedAt = Number(details.startedAt);
        const endedAt = Number(details.timestamp ?? message.timestamp);
        push('agent.tool_nested', {tool: details.toolName ?? 'unknown', isError: details.isError === true, status: details.isError === true ? 'error' : 'ok',
          ...normalized,
          ...(Number.isFinite(startedAt) && Number.isFinite(endedAt) && endedAt >= startedAt ? {durationMs: endedAt - startedAt} : {}),
          ...(expand ? {expanded: {input: deepParseJson(details.input), result: deepParseJson(details.result)}} : {})},
        {...baseCorrelation, ...correlationFrom({...namedIds(result), runId: details.runId ?? baseCorrelation.runId}),
          ...(details.toolCallId ? {toolCallId: String(details.toolCallId)} : {}),
          ...(details.parentToolCallId ? {parentToolCallId: String(details.parentToolCallId)} : {})});
      }
    }
    attachInboundRun(output);
    return {events: output, windows};
  } catch { return {events: output, windows: []}; }
}

function agentDatabases(root) {
  const agents = path.join(root, 'agents');
  if (!fs.existsSync(agents)) return [];
  return fs.readdirSync(agents).map((id) => path.join(agents, id, 'agent', 'openclaw-agent.sqlite')).filter(fs.existsSync);
}

function readReminderDatabase(file, from, to, options = {}) {
  const event = input => normalizeQueryEvent(input,options);
  const retain = value => options.fullContent ? value : redactValue(value);
  const output = [];
  let db;
  try { db = new DatabaseSync(file, {readOnly: true}); } catch { return output; }
  try {
    const emitRows = (sql, params, make) => {
      let rows = [];
      try { rows = db.prepare(sql).all(...params); } catch { return; }
      for (const row of rows) {
        const made = make(row);
        if (made) output.push(made);
      }
    };
    const range = [from / 1000, to / 1000];
    emitRows(`SELECT proposal_id AS proposalId, kind, status, payload_hash AS payloadHash,
      expires_at_utc AS expiresAtUtc, created_at_utc AS createdAtUtc, committed_at_utc AS committedAtUtc,
      result_reminder_id AS reminderId FROM reminder_proposals
      WHERE (created_at_utc BETWEEN ? AND ?) OR (committed_at_utc BETWEEN ? AND ?)`, [...range, ...range], (row) => {
      output.push(event({at: row.createdAtUtc * 1000, source: 'personal-reminders', kind: 'reminder.proposal_state', correlation: correlationFrom(row), data: {...retain(row), snapshotOfCurrentState: true}, sourceRef: sourceRef(file, 0, {table: 'reminder_proposals'})}));
    });
    emitRows(`SELECT reminder_id AS reminderId, status, content, scheduled_at_utc AS scheduledAtUtc,
      cron_job_id AS cronJobId, created_at_utc AS createdAtUtc, updated_at_utc AS updatedAtUtc,
      dispatched_at_utc AS dispatchedAtUtc, delivered_at_utc AS deliveredAtUtc, failure_code AS failureCode
      FROM reminders WHERE updated_at_utc BETWEEN ? AND ?`, range, (row) => event({at: (row.deliveredAtUtc ?? row.updatedAtUtc ?? row.createdAtUtc) * 1000, source: 'personal-reminders', kind: row.status === 'delivered' ? 'reminder.delivered' : 'reminder.state', correlation: correlationFrom(row), data: {...retain(row), snapshotOfCurrentState: true}, sourceRef: sourceRef(file, 0, {table: 'reminders'})}));
    emitRows(`SELECT proposal_id AS proposalId, confirmation_message_id AS confirmationMessageId,
      issued_at_utc AS issuedAtUtc, consumed_at_utc AS consumedAtUtc, status, consumption_result AS result
      FROM approval_grants WHERE (issued_at_utc BETWEEN ? AND ?) OR (consumed_at_utc BETWEEN ? AND ?)`, [...range, ...range], (row) => event({at: (row.consumedAtUtc ?? row.issuedAtUtc) * 1000, source: 'personal-reminders', kind: 'confirmation.grant', correlation: correlationFrom(row), data: retain(row), sourceRef: sourceRef(file, 0, {table: 'approval_grants'})}));
    emitRows(`SELECT id, action, entity_type AS entityType, entity_id AS entityId,
      proposal_id AS proposalId, summary_json AS summaryJson, created_at_utc AS createdAtUtc
      FROM reminder_audit_log WHERE created_at_utc BETWEEN ? AND ?`, range, (row) => {
      const summary = parseJson(row.summaryJson);
      const kind = String(row.action ?? 'reminder.audit').replace(/_/gu, '.');
      const correlation = correlationFrom({...row, reminderId: row.entityType === 'reminder' ? row.entityId : undefined});
      return event({at: row.createdAtUtc * 1000, source: 'personal-reminders', kind, correlation, data: {action: row.action, entityType: row.entityType, summary: retain(summary)}, sourceRef: sourceRef(file, 0, {table: 'reminder_audit_log', id: row.id})});
    });
  } finally { db.close(); }
  return output.filter((item) => item.epochMs >= from && item.epochMs <= to);
}

/** Reminder-list audit is already bound to the trusted message at write time.
 * Scheduled digest events have a slot/cron identity and no inferred QQ turn. */
export function readReminderListDatabase(file, from, to, options = {}) {
  const event = input => normalizeQueryEvent(input,options);
  if (!fs.existsSync(file)) return [];
  const db = new DatabaseSync(file, {readOnly: true});
  try {
    return db.prepare(`SELECT id,at_ms,action,item_id,qq_message_id,session_key,run_id,details_json
      FROM audit WHERE at_ms BETWEEN ? AND ? ORDER BY at_ms,id`).all(from, to).map(row => {
      const details = JSON.parse(row.details_json);
      return event({at: row.at_ms, source: 'personal-reminder-list', kind: `reminder-list.${row.action}`,
        correlation: correlationFrom({qqMessageId: row.qq_message_id, sessionKey: row.session_key,
          runId: row.run_id, reminderId: row.item_id, eventKey: details.slotKey, cronJobId: details.cronJobId}),
        data: {action: row.action, status: details.after?.status, previousStatus: details.before?.status,
          count: details.count, settings: details.settings, reason: details.reason,...(options.fullContent ? {details} : {})},
        sourceRef: sourceRef(file, 0, {table: 'audit', id: row.id})});
    });
  } finally { db.close(); }
}

function readTraceFile(file, from, to, options = {}) {
  if (!fs.existsSync(file)) return [];
  return linesOf(file).flatMap((line, index) => {
    try {
      const value = JSON.parse(line);
      const parsed = normalizeQueryEvent({...value, sourceRef: value.sourceRef ?? sourceRef(file, index + 1)},options);
      return parsed.epochMs >= from && parsed.epochMs <= to ? [parsed] : [];
    } catch { return []; }
  });
}

function attachSessionCorrelation(events, windows) {
  const candidates = windows.filter((window) => window.channel === 'kurumi-qq');
  for (const item of events) {
    if (!['qq.inbound', 'qq.outbound'].includes(item.kind) || item.correlation.sessionKey) continue;
    const peer = item.correlation.senderId ?? item.correlation.recipientId;
    const matches = candidates.filter((window) => {
      const owner = String(window.sessionKey ?? '').split(':').at(-1);
      return (!peer || peer === owner) && item.epochMs >= Number(window.createdAt) && item.epochMs <= Number(window.updatedAt);
    });
    const match = matches.sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt))[0];
    if (match) {
      Object.assign(item.correlation, correlationFrom({sessionId: match.sessionId, sessionKey: match.sessionKey, conversationId: match.conversationId}));
    }
  }
}

/** Associate platform messages with the OpenClaw turn that handled them. The
 * native transcript does not repeat MessageSid, so this uses the already
 * validated session, the message text and a short time window. */
export function attachTurnCorrelation(events) {
  const bySession = new Map();
  for (const item of events) {
    const key = item.correlation.sessionKey;
    if (!key) continue;
    const list = bySession.get(key) ?? [];
    list.push(item);
    bySession.set(key, list);
  }
  for (const list of bySession.values()) {
    list.sort((a, b) => a.epochMs - b.epochMs);
    const inbound = list.filter((item) => item.kind === 'qq.inbound');
    for (const item of list.filter((candidate) => candidate.kind === 'agent.inbound')) {
      const text = String(item.data?.text ?? '').trim();
      const platform = inbound
        .filter((candidate) => Math.abs(candidate.epochMs - item.epochMs) <= 3_000
          && (!text || String(candidate.data?.text ?? '').trim() === text))
        .sort((a, b) => Math.abs(a.epochMs - item.epochMs) - Math.abs(b.epochMs - item.epochMs))[0];
      if (!platform) continue;
      const nextInbound = list.find((candidate) => candidate.kind === 'agent.inbound' && candidate.epochMs > item.epochMs + 1);
      const end = nextInbound?.epochMs ?? item.epochMs + 120_000;
      const ids = {qqMessageId: platform.correlation.qqMessageId};
      for (const candidate of list) {
        if (candidate.epochMs >= item.epochMs - 500 && candidate.epochMs < end && !candidate.correlation.qqMessageId) Object.assign(candidate.correlation, ids);
      }
    }
  }
}

const RUNTIME_WINDOW_MS = 120_000;

/** Runtime text logs usually have trace/span IDs but no QQ MessageSid. Add a
 * clearly documented time-window link so a message query can show adjacent
 * confirmation/Cron/warning records. Native session events remain authoritative.
 * Each unkeyed line goes to the nearest preceding turn, at most 120s back: a
 * daily Cron turn must not absorb a day of other jobs' runtime lines. */
export function attachRuntimeCorrelation(events) {
  const byTime = (a, b) => a.epochMs - b.epochMs;
  const turns = events.filter((item) => item.kind === 'agent.inbound' && item.correlation.sessionKey).sort(byTime);
  const runtime = events.filter((item) => item.source === 'openclaw-runtime' && !item.correlation.sessionKey).sort(byTime);
  let index = -1;
  for (const candidate of runtime) {
    while (index + 1 < turns.length && turns[index + 1].epochMs <= candidate.epochMs) index += 1;
    const turn = turns[index];
    if (!turn || candidate.epochMs >= turn.epochMs + RUNTIME_WINDOW_MS) continue;
    Object.assign(candidate.correlation, {sessionKey: turn.correlation.sessionKey, qqMessageId: turn.correlation.qqMessageId});
    candidate.data.correlationQuality = 'time-window';
  }
}

/** Current outbound ledger state, not a history of transitions or user read receipt. */
export function readChannelDelivery(file, from, to, options = {}) {
  const event = input => normalizeQueryEvent(input,options);
  if (!fs.existsSync(file)) return [];
  const db = new DatabaseSync(file, {readOnly: true});
  try {
    return db.prepare('SELECT id, status, message_id, at FROM outbound WHERE at BETWEEN ? AND ? ORDER BY at, id').all(from, to)
      .map(row => event({at: row.at, source: 'channel-delivery', kind: 'qq.delivery_state',
        correlation: correlationFrom({qqMessageId: row.message_id == null ? undefined : String(row.message_id)}),
        data: {ledgerId: row.id, status: row.status, snapshotOfCurrentState: true},
        sourceRef: sourceRef(file, 0, {table: 'outbound'})}));
  } finally { db.close(); }
}

/** Spread-free append: `push(...list)` overflows the call stack once a source yields ~100k rows. */
function append(target, items) {
  for (const item of items) target.push(item);
}

export function collectEvents({from, to, runtimeRoot = DEFAULT_RUNTIME_ROOT, snowlumaRoot = DEFAULT_SNOWLUMA_ROOT, sources, expand = false, fullContent = false, messageId,peer} = {}) {
  const contentOptions={expand,fullContent};
  const wanted = sources ? new Set(sources) : undefined;
  const include = (name) => !wanted || wanted.has(name);
  const events = [];
  const windows = [];
  if (include('cron-runs')) append(events, readCronRuns(runtimeRoot,from,to,contentOptions));
  if (include('channel-delivery')) append(events, readChannelDelivery(path.join(runtimeRoot, 'channel', 'channel.sqlite'), from, to,contentOptions));
  if (include('snowluma')) append(events, readSnowLumaLogs(snowlumaRoot, from, to,contentOptions));
  if (include('openclaw-runtime') && fs.existsSync(runtimeRoot)) {
    for(const name of fs.readdirSync(runtimeRoot).filter(n=>/^runtime(?:\.\d+)?\.log$/u.test(n)).sort())append(events,readRuntimeLog(path.join(runtimeRoot,name),from,to,contentOptions));
  }
  if (include('openclaw-receipt')) {
    for (const name of ['task-receipts.jsonl', 'reminder-receipts.jsonl', 'native-tool-receipts.jsonl']) append(events, readReceiptFile(path.join(runtimeRoot, 'channel', name), from, to,contentOptions));
  }
  if (include('openclaw-session')) {
    for (const dbFile of agentDatabases(runtimeRoot)) {
      const result = transcriptEvents(dbFile, from, to, contentOptions);
      append(events, result.events); append(windows, result.windows);
    }
  } else if (include('snowluma')) {
    // QQ events still benefit from a session key when only the QQ source was requested.
    const mainDb = path.join(runtimeRoot, 'agents', 'main', 'agent', 'openclaw-agent.sqlite');
    const result = transcriptEvents(mainDb, from, to);
    append(windows, result.windows);
  }
  if (include('personal-reminders')) append(events, readReminderDatabase(path.join(runtimeRoot, 'state', 'personal-reminders', 'reminders.sqlite'), from, to,contentOptions));
  if (include('personal-reminder-list')) append(events, readReminderListDatabase(path.join(runtimeRoot, 'state', 'personal-reminder-list', 'list.sqlite'), from, to,contentOptions));
  for (const [source, basename] of [['trace-events','trace-events.jsonl'],['e7','e7-events.jsonl'],['kurumi-memory','memory-events.jsonl']]) {
    if (include(source)) for (const suffix of ['.1','']) append(events,readTraceFile(path.join(runtimeRoot,'channel',basename+suffix),from,to,contentOptions));
  }
  if (include('access-control')) append(events, readTraceFile(path.join(runtimeRoot,'channel','access-events.jsonl'),from,to,contentOptions));
  if (include('papers')) {
    // Configured managed root, with a portable default for isolated tests/restores.
    let root = path.join(runtimeRoot, 'documents');
    try { root = JSON.parse(safeRead(path.join(runtimeRoot, 'openclaw.json'))).plugins.entries['kurumi-papers'].config.root ?? root; } catch {}
    append(events, readTraceFile(path.join(root, 'events.jsonl'), from, to,contentOptions));
  }
  if (include('web-deepseek')) {
    // Only a configured trace file exists; the provider writes nothing by default.
    let file;
    try { file = JSON.parse(safeRead(path.join(runtimeRoot, 'openclaw.json'))).plugins.entries['kurumi-web-deepseek'].config.traceFile; } catch {}
    if (typeof file === 'string' && path.isAbsolute(file)) append(events, readTraceFile(file, from, to,contentOptions));
  }
  if (include('knowledgemap')) {
    for (const file of ['trace.jsonl.1', 'trace.jsonl']) append(events, readTraceFile(path.join(runtimeRoot, 'state', 'knowledgemap', file), from, to,contentOptions));
  }
  if (include('proactive')) {
    for (const file of ['trace.jsonl.1','trace.jsonl']) append(events,readTraceFile(path.join(runtimeRoot,'state','proactive',file),from,to,contentOptions));
  }
  if(wanted?.has('snowluma-messages')) append(events,readStoredQQMessages(snowlumaRoot,runtimeRoot,from,to,{messageId,peer,expand,previews:events.filter(e=>e.source==='snowluma')}));
  attachSessionCorrelation(events, windows);
  attachTurnCorrelation(events);
  attachRuntimeCorrelation(events);
  events.sort((a, b) => a.epochMs - b.epochMs || a.source.localeCompare(b.source) || a.kind.localeCompare(b.kind));
  return events;
}

function containsEvent(eventValue, text) {
  return JSON.stringify(eventValue).toLocaleLowerCase('zh-CN').includes(String(text).toLocaleLowerCase('zh-CN'));
}

function matchesQuery(item,filters) {
  if(filters.levels?.length && !filters.levels.some(level=>String(item.data?.level ?? '').toUpperCase()===String(level).toUpperCase()))return false;
  if(filters.contains && !containsEvent(item,filters.contains))return false;
  const terms=filters.keywords ?? [];
  return !terms.length || (filters.keywordMode==='all' ? terms.every(term=>containsEvent(item,term)) : terms.some(term=>containsEvent(item,term)));
}

export function filterEvents(events, filters = {}) {
  if(filters.peer){
    if(!/^\d{5,12}$/.test(filters.peer))throw Error('Invalid peer');
    events=events.filter(e=>e.correlation.senderId===filters.peer||e.correlation.recipientId===filters.peer||String(e.correlation.sessionKey??'').endsWith(':kurumi-qq:direct:'+filters.peer));
  }
  if(filters.lastTurns!==undefined)events=selectRecentTurns(events,Number(filters.lastTurns));
  const idFilters = ['messageId', 'proposalId', 'runId', 'sessionKey', 'reminderId'];
  const requested = idFilters.filter((name) => filters[name]);
  if (!requested.length) return events.filter((item) => matchesQuery(item,filters));
  const seeds = events.filter((item) => requested.every((name) => Object.values(item.correlation).some((value) => String(value) === String(filters[name]))));
  const selected = new Set(seeds);
  // Correlation closure joins a QQ turn to its tool result and a reminder
  // proposal to its committed/delivered record without broadening to every
  // event in the conversation's session.
  // A nested tool's parentToolCallId names the outer call, so both IDs share
  // the toolCallId namespace.
  const keys = ['qqMessageId', 'replyToId', 'proposalId', 'payloadHash', 'reminderId', 'cronJobId', 'eventKey', 'runId', 'taskId', 'toolCallId'];
  const namespace = (key) => key === 'parentToolCallId' ? 'toolCallId' : key;
  const joinValues = (item) => [...keys, 'parentToolCallId'].filter((key) => item.correlation[key]).map((key) => `${namespace(key)}\u0000${item.correlation[key]}`);
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
  return `用法：node scripts/fusion/log-query.mjs [选项]

  --from <时间>       起始时间（带时区 ISO；无时区按 Asia/Shanghai）
  --to <时间>         结束时间
  --since <30m|2h|30d|all> 相对时间窗或全部留存历史，不与--from组合
  --peer <QQ>         只看对应私聊/可信收发账号，不推测身份
  --last-turns <N>    当前时间窗内最近N个模型回合
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

const VALUE_FLAGS = ['--from', '--to', '--contains', '--message-id', '--proposal-id', '--run-id', '--session-key', '--reminder-id', '--source', '--exclude-source', '--kind', '--exclude-kind', '--runtime-root', '--snowluma-root', '--limit', '--since', '--peer', '--last-turns', '--snapshot', '--format', '--fields', '--offset', '--interval','--keyword','--keyword-mode','--level','--context-before','--context-after','--output-bytes','--content-offset','--content-hash'];
const LIST_FLAGS = {'--source': 'sources', '--exclude-source': 'excludeSources', '--kind': 'kinds', '--exclude-kind': 'excludeKinds','--keyword':'keywords','--level':'levels'};
const BOOLEAN_FLAGS = {'--no-text': 'noText', '--json': 'json', '--raw': 'raw', '--expand': 'expand', '--full': 'expand', '--turns': 'turns', '--errors': 'errors', '--audit': 'audit', '--stats':'stats', '--follow':'follow', '--show-known':'showKnown','--full-content':'fullContent'};

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
  if (['turns', 'errors', 'audit', 'stats', 'snapshot'].filter((name) => result[name]).length > 1) throw new Error('turns/errors/audit/stats/snapshot只能选一个');
  if(result.format&&!['text','table','markdown'].includes(result.format))throw Error('Invalid format');
  if((result.fields||result.format&&result.format!=='text')&&(result.turns||result.errors||result.audit||result.stats||result.snapshot))throw Error('Table formatting requires event view');
  if(result.since&&result.from)throw Error('since and from are mutually exclusive');
  if(result.snapshot&&(result.peer||result.lastTurns||result.contains||result.messageId||result.runId||result.sessionKey||result.proposalId||result.reminderId||result.sources.length||result.kinds.length))throw Error('snapshot is current owner state; event filters cannot be combined');
  if(result.follow&&(result.snapshot||result.lastTurns||result.offset||result.to))throw Error('follow cannot combine snapshot/last-turns/offset/to');
  if(result.keywordMode && !['any','all'].includes(result.keywordMode))throw Error('Invalid keyword mode');
  for(const name of ['contextBefore','contextAfter','contentOffset','outputBytes'])if(result[name]!==undefined){result[name]=Number(result[name]);if(!Number.isSafeInteger(result[name])||result[name]<0||['contextBefore','contextAfter'].includes(name)&&result[name]>1000)throw Error('Invalid '+name);}
  if((result.contextBefore||result.contextAfter)&&(result.stats||result.turns||result.audit||result.snapshot))throw Error('Context requires events/errors view');
  return result;
}

export function runCli(argv = process.argv.slice(2), now = Date.now()) {
  const args = parseArgs(argv);
  if (args.help) { console.log(usage()); return 0; }
  const duration=args.since && args.since!=='all'?parseDuration(args.since):60*60*1000;
  const from = parseQueryInstant(args.from, args.since==='all'?0:now - duration),to = parseQueryInstant(args.to, now);
  if ((args.from&&!Number.isFinite(parseQueryInstant(args.from,NaN)))||(args.to&&!Number.isFinite(parseQueryInstant(args.to,NaN)))||!Number.isFinite(from)||!Number.isFinite(to)||from>to)throw Error('时间范围无效');
  const runtimeRoot=args.runtimeRoot??DEFAULT_RUNTIME_ROOT;
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
      json: addQueryContext({schemaVersion: 1, view: 'errors', ...range, total: found.items.length, shown: items.length, counts: found.counts, hiddenKnown, ...page(found.items), items,...(found.recordCount!==undefined?{recordCount:found.recordCount,correlationGroups:found.correlationGroups,countBasis:found.countBasis}:{})},events,items.flatMap(item=>item.details??[]),options),
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
  const rendered = renderQueryInternal(events, options);
  const value = rendered.json;
  const annotate = item => {
    if (!item || typeof item !== 'object') return;
    if (item.data && typeof item.data.text === 'string') {
      item.data = {...item.data, textLength: item.data.text.length, displayTruncated: !options.expand && item.data.text.length > 260};
    }
  };
  for (const item of value.events ?? []) annotate(item);
  if (options.fullContent && !options.expand) {
    const surface=event=>{const {original,...rest}=event;const {expanded,...data}=rest.data??{};return {...rest,...(rest.data?{data}:{})};};
    if(value.events)value.events=value.events.map(surface);
    if(value.contextEvents)value.contextEvents=value.contextEvents.map(surface);
    if(value.items)value.items=value.items.map(item=>({...item,...(item.details?{details:item.details.map(surface)}:{})}));
    value.detailsExpanded=false;
  } else if(options.fullContent)value.detailsExpanded=true;
  if (options.noText) {
    const projected = noTextProjection({...value, noText: true});
    const paged=paginateQueryContent(projected,options);
    return {json: paged, lines: [JSON.stringify(paged, null, 2)]};
  }
  const paged=paginateQueryContent(value,options);
  if(paged!==value)return {json:paged,lines:[JSON.stringify(paged)]};
  if(options.fields||options.format==='table'||options.format==='markdown')rendered.lines=tabularEvents(value.events??[],options);
  if(value.hiddenKnown)rendered.lines.push('已折叠明确识别的可选目录警告 '+value.hiddenKnown+' 条（--show-known 展开）。');
  if (value.truncated) rendered.lines.push('结果已截短：固定--from/--to后使用--offset '+value.nextOffset+'，或缩小时间范围/提高--limit。');
  return rendered;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await runCli(); } catch (error) { console.error(`log-query: ${error.message}`); process.exitCode = 2; }
}
