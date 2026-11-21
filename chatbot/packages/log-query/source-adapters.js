/**
 * Read-only cross-module event query.
 *
 * Sources are deliberately adapters: SnowLuma and OpenClaw keep their own
 * native logs, while this command presents a stable event envelope. A future
 * module can either add an adapter here or emit the same envelope through
 * chatbot/packages/observability/index.js; no business operation is performed by this command.
 */
import fs from 'node:fs';
import {createHash} from 'node:crypto';
const lineIdentity=value=>createHash('sha256').update(value).digest('hex');
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {readDeliveryRows,replyFeedbackData} from '../qq-delivery/private-text-feedback.js';
import {readImageFeedback} from '../qq-delivery/image-feedback.js';
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
  try { return fs.readFileSync(file, 'utf8'); } catch (error) { if(error.code==='ENOENT')return '';throw error; }
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
  const event = input => normalizeQueryEvent({...input,eventId:lineIdentity(line),...(options.fullContent && options.expand ? {original:line} : {})},options);
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
  const event = input => normalizeQueryEvent({...input,eventId:lineIdentity(line),...(options.fullContent && options.expand ? {original:record} : {})},options);
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
  const event = input => normalizeQueryEvent({...input,eventId:lineIdentity(line),...(options.fullContent && options.expand ? {original:record} : {})},options);
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

function transcriptEvents(dbFile, from, to, {expand = false, fullContent = false, privateSessionKey} = {}) {
  const event = input => normalizeQueryEvent(input,{fullContent});
  const output = [];
  try {
    const {rows, windows} = readHostRecords(dbFile, {from, to, sessionKey: privateSessionKey});
    const privateWindows = privateSessionKey && windows.filter(window => window.sessionKey === privateSessionKey
      && window.channel === 'kurumi-qq' && window.accountId === 'default' && window.chatType === 'direct');
    const privateIds = privateWindows && new Set(privateWindows.map(window => window.sessionId));
    for (const row of rows) {
      if (privateIds && !privateIds.has(row.sessionId)) continue;
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
    return {events: output, windows: privateWindows || windows};
  } catch (error) { if(error.code==='ENOENT')return {events:output,windows:[]};throw error; }
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
  if(!fs.existsSync(file))return output;
  db = new DatabaseSync(file, {readOnly: true});
  try {
    const emitRows = (sql, params, make) => {
      let rows = [];
      try { rows = db.prepare(sql).all(...params); } catch (error) { options.onIssue?.(error);return; }
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
    db.exec('PRAGMA busy_timeout=2000; BEGIN');
    const result=db.prepare(`SELECT id,at_ms,action,item_id,qq_message_id,session_key,run_id,details_json
      FROM audit WHERE at_ms BETWEEN ? AND ? ORDER BY at_ms,id`).all(from, to).map(row => {
      const details = JSON.parse(row.details_json);
      return event({at: row.at_ms, source: 'personal-reminder-list', kind: `reminder-list.${row.action}`,
        correlation: correlationFrom({qqMessageId: row.qq_message_id, sessionKey: row.session_key,
          runId: row.run_id??details.generation?.runId??details.runId, sessionId:details.generation?.sessionId,
          reminderId: row.item_id, eventKey: details.evidence?.eventKey ?? details.slotKey, cronJobId: details.cronJobId}),
        data: row.action==='feedback' ? details : {action: row.action, status: details.after?.status, previousStatus: details.before?.status,
          count: details.count, settings: details.settings, reason: details.reason,code:details.code,
          ...(row.action==='notice.generation_failed'?{exceptionRecordedInAudit:details.error!==undefined,validationRecordedInAudit:details.validation!==undefined,
            generationReferenceRecorded:!!details.generation?.runId}:{}),
          ...(options.fullContent ? {details} : {})},
        sourceRef: sourceRef(file, 0, {table: 'audit', id: row.id})});
    });
    // The delivery ledger is a different source record from the append-only
    // audit. Expose both, preserving historical contradictions rather than
    // rewriting old delivered audits or treating either as proof of body receipt.
    if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='deliveries'").get()){
      for(const row of db.prepare('SELECT * FROM deliveries WHERE updated_ms BETWEEN ? AND ? ORDER BY updated_ms,slot_key').all(from,to)){
        const inconsistent=row.status==='delivered'&&!row.text?.trim();
        result.push(event({at:row.updated_ms,source:'personal-reminder-list',kind:'reminder-list.delivery_state',
          correlation:correlationFrom({eventKey:row.slot_key,cronJobId:row.cron_job_id}),
          data:{status:row.status,textLength:(row.text??'').length,bodyPresent:!!row.text?.trim(),snapshotOfCurrentState:true,updatedAtMs:row.updated_ms,
            ...(inconsistent?{ok:false,code:'digest_delivered_without_body'}:{}),...(options.fullContent?{ledger:{...row}}:{})},
          sourceRef:sourceRef(file,0,{table:'deliveries',id:row.slot_key})}));
      }
    }
    db.exec('COMMIT');return result;
  } finally { db.close(); }
}

function readTraceFile(file, from, to, options = {}) {
  if (!fs.existsSync(file)) return [];
  return linesOf(file).flatMap((line, index) => {
    try {
      const value = JSON.parse(line);
      const parsed = normalizeQueryEvent({...value,eventId:value.eventId??lineIdentity(line), sourceRef: value.sourceRef ?? sourceRef(file, index + 1)},options);
      return parsed.epochMs >= from && parsed.epochMs <= to ? [parsed] : [];
    } catch (error) { if(line.trim())options.onIssue?.(error);return []; }
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
    db.exec('PRAGMA busy_timeout=2000; BEGIN');
    const events = readDeliveryRows(db,from,to).map(row => {
      const feedback = replyFeedbackData(row);
      return event({at: row.at, source: 'channel-delivery', kind: 'qq.delivery_state',
        correlation: correlationFrom({qqMessageId: row.message_id == null || row.id.startsWith('pdf:') ? undefined : String(row.message_id),
          eventKey:row.delivery_key, recipientId:row.peer, senderId:row.bot, runId:feedback.runId}),
        data: {ledgerId: row.id, status: row.status, snapshotOfCurrentState: true, ...feedback},
        sourceRef: sourceRef(file, 0, row.delivery_key ? {table:'qq_reply_parts',id:row.id} : {table:'outbound'})});
    });
    for (const image of readImageFeedback(db, from, to, options.messageId)) {
      events.push(event({...image, source: 'channel-delivery', kind: 'qq.image_feedback',
        sourceRef: sourceRef(file, 0, {table: 'qq_image_feedback', id: image.correlation.eventKey})}));
    }
    db.exec('COMMIT');
    return events;
  } finally { db.close(); }
}


export {transcriptEvents,agentDatabases,readReminderDatabase,readTraceFile,attachSessionCorrelation,safeRead};
