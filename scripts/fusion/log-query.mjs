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
import {zstdDecompressSync} from 'node:zlib';
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
export function parseSnowLumaLine(line, file, lineNumber) {
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
      data: {level, senderLabel: inbound[1], text: inbound[3] ?? '', direction: 'inbound'},
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
      data: {level, recipientId: outbound[1], replyToId: outbound[2] ?? null, text: outbound[3] ?? '', direction: 'outbound'},
      sourceRef: sourceRef(file, lineNumber),
    });
  }

  if (detail.includes('[Bridge.Action]') || level === 'WARN' || level === 'ERROR') {
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

export function readSnowLumaLogs(root, from, to) {
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
      const parsed = parseSnowLumaLine(line, file, index + 1);
      if (parsed) {
        output.push(parsed);
        continuation = parsed.kind === 'qq.outbound' && parsed.data.text === '' ? parsed : undefined;
      } else if (continuation && line.trim() && !/^\d\d:\d\d:\d\d\s+/u.test(line)) {
        continuation.data.text = `${continuation.data.text}\n${line.trim()}`;
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

export function parseRuntimeLine(line, file, lineNumber) {
  let record;
  try { record = JSON.parse(line); } catch { return undefined; }
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

export function readRuntimeLog(file, from, to) {
  if (!fs.existsSync(file)) return [];
  return linesOf(file).map((line, index) => parseRuntimeLine(line, file, index + 1)).filter(Boolean)
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

export function parseReceiptLine(line, file, lineNumber) {
  let record;
  try { record = JSON.parse(line); } catch { return undefined; }
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

export function readReceiptFile(file, from, to) {
  if (!fs.existsSync(file)) return [];
  return linesOf(file).map((line, index) => parseReceiptLine(line, file, index + 1)).filter(Boolean)
    .filter((item) => item.epochMs >= from && item.epochMs <= to);
}

function transcriptText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((item) => item?.type === 'text').map((item) => item.text ?? '').join('\n');
}

function toolResultSummary(content) {
  const text = transcriptText(content);
  const parsed = parseJson(text);
  const nested = parsed?.result?.details ?? parsed?.result ?? parsed?.details ?? parsed;
  if (nested && typeof nested === 'object') {
    const summary = {};
    for (const key of ['ok', 'status', 'code', 'error', 'proposalId', 'reminder', 'reminderId', 'confirmationInstruction', 'idempotent']) {
      if (nested[key] !== undefined) summary[key] = nested[key];
    }
    return {summary: redactValue(summary), correlation: namedIds(parsed), textPreview: summarizeText(text)};
  }
  return {summary: {}, correlation: {}, textPreview: summarizeText(text)};
}

/** Wrapped calls name the real tool in `arguments.id` (`openclaw:<plugin>:<tool>`
 * or the bare tool name); results repeat it as `tool` (string or object). */
function wrappedToolName(value) {
  if (typeof value === 'string' && value.trim()) return value.split(':').at(-1);
  if (value && typeof value === 'object' && typeof value.name === 'string') return value.name;
  return undefined;
}

function shortError(value) {
  if (value === undefined || value === null || value === '') return undefined;
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

function transcriptEvents(dbFile, from, to, {expand = false} = {}) {
  const output = [];
  let db;
  try { db = new DatabaseSync(dbFile, {readOnly: true}); } catch { return {events: output, windows: []}; }
  try {
    let windows = [];
    try {
      windows = db.prepare(`SELECT session_id AS sessionId, session_key AS sessionKey,
        created_at AS createdAt, updated_at AS updatedAt, channel, account_id AS accountId,
        chat_type AS chatType, primary_conversation_id AS conversationId
        FROM session_windows WHERE updated_at >= ? AND created_at <= ?`).all(from, to);
    } catch { /* Older agent databases may not have session_windows. */ }
    let rows;
    try {
      rows = db.prepare(`SELECT session_id AS sessionId, seq, event_json AS eventJson,
        event_zstd AS eventZstd, created_at AS createdAt
        FROM transcript_events WHERE created_at BETWEEN ? AND ? ORDER BY created_at, seq`).all(from, to);
    } catch { return {events: output, windows}; }
    for (const row of rows) {
      let raw = row.eventJson;
      try { if (!raw && row.eventZstd) raw = zstdDecompressSync(row.eventZstd).toString('utf8'); } catch { continue; }
      let record;
      try { record = JSON.parse(raw); } catch { continue; }
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
      const push = (kind, data, correlation = baseCorrelation) => output.push(event({at, source: 'openclaw-session', kind, correlation, data, sourceRef: ref}));
      const contents = Array.isArray(message.content) ? message.content : [];
      // Session segment markers: /new keeps the sessionId, so it is only visible here.
      if (record.type === 'reset') push('session.reset', {reason: record.reason ?? null});
      else if (record.type === 'compaction') {
        push('session.compaction', {tokensBefore: record.tokensBefore ?? null, tokensAfter: record.tokensAfter ?? null,
          summaryChars: String(record.summary ?? '').length, fromHook: record.fromHook === true});
      } else if (record.type === 'custom' && record.customType === 'openclaw:prompt-error') {
        push('agent.prompt_error', {provider: record.data?.provider, model: record.data?.model, error: shortError(record.data?.error)});
      } else if (record.type === 'custom_message' && record.customType === 'openclaw:turn-aborted') {
        push('agent.turn_aborted', {});
      }
      if (message.role === 'user') {
        push('agent.inbound', {text: transcriptText(message.content), role: 'user'});
      } else if (message.role === 'assistant') {
        if (message.errorMessage) push('agent.model_error', {stopReason: message.stopReason ?? null, provider: message.provider, model: message.model, error: shortError(message.errorMessage)});
        for (const part of contents) {
          if (part?.type === 'toolCall' || part?.type === 'tool_use') {
            const argumentsValue = part.arguments ?? part.input ?? {};
            const ids = namedIds(argumentsValue);
            const declared = part.name ?? part.toolName ?? 'unknown';
            const actual = declared === 'tool_call' ? wrappedToolName(argumentsValue?.id) ?? declared : declared;
            push('agent.tool_call', {tool: actual, declaredTool: declared, arguments: redactValue(argumentsValue), ...(expand ? {expanded: {arguments: deepParseJson(argumentsValue)}} : {})},
              {...baseCorrelation, ...correlationFrom(ids), ...(part.id ? {toolCallId: String(part.id)} : {})});
          } else if (part?.type === 'text' && String(part.text ?? '').trim()) {
            push('agent.reply', {text: part.text, role: 'assistant'});
          }
        }
      } else if (message.role === 'toolResult' || message.role === 'tool') {
        const summary = toolResultSummary(message.content);
        const wrapper = parseJson(transcriptText(message.content));
        const details = message.details && typeof message.details === 'object' ? message.details : {};
        const declared = message.toolName ?? message.name ?? 'unknown';
        const tool = wrappedToolName(wrapper?.tool) ?? wrappedToolName(details.tool) ?? declared;
        const status = message.isError === true ? 'error' : 'ok';
        push('agent.tool_result', {tool, ...summary, declaredTool: declared, isError: message.isError === true, status,
          ...(details.status !== undefined ? {hostStatus: details.status} : {}),
          ...(details.error !== undefined ? {error: shortError(details.error)} : {}),
          ...(expand ? {expanded: {content: deepParseJson(transcriptText(message.content)), details: deepParseJson(details)}} : {})},
        {...baseCorrelation, ...correlationFrom(summary.correlation), ...(message.toolCallId ? {toolCallId: String(message.toolCallId)} : {})});
      } else if (message.role === 'custom' && message.customType === 'openclaw.nested-tool.v1') {
        // One record per real tool behind a `tool_call` wrapper; the parent ID is the outer call.
        const details = message.details ?? {};
        const result = details.result?.details && typeof details.result.details === 'object' ? details.result.details : {};
        const resultSummary = {};
        for (const key of ['ok', 'status', 'code', 'proposalId', 'reminderId', 'idempotent']) if (result[key] !== undefined && typeof result[key] !== 'object') resultSummary[key] = result[key];
        const startedAt = Number(details.startedAt);
        const endedAt = Number(details.timestamp ?? message.timestamp);
        push('agent.tool_nested', {tool: details.toolName ?? 'unknown', isError: details.isError === true, status: details.isError === true ? 'error' : 'ok',
          summary: redactValue(resultSummary), ...(result.error !== undefined ? {error: shortError(result.error)} : {}),
          ...(Number.isFinite(startedAt) && Number.isFinite(endedAt) && endedAt >= startedAt ? {durationMs: endedAt - startedAt} : {}),
          ...(expand ? {expanded: {input: deepParseJson(details.input), result: deepParseJson(details.result)}} : {})},
        {...baseCorrelation, ...correlationFrom({...namedIds(result), runId: details.runId ?? baseCorrelation.runId}),
          ...(details.toolCallId ? {toolCallId: String(details.toolCallId)} : {}),
          ...(details.parentToolCallId ? {parentToolCallId: String(details.parentToolCallId)} : {})});
      }
    }
    attachInboundRun(output);
    return {events: output, windows};
  } finally { db.close(); }
}

function agentDatabases(root) {
  const agents = path.join(root, 'agents');
  if (!fs.existsSync(agents)) return [];
  return fs.readdirSync(agents).map((id) => path.join(agents, id, 'agent', 'openclaw-agent.sqlite')).filter(fs.existsSync);
}

function readReminderDatabase(file, from, to) {
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
      output.push(event({at: row.createdAtUtc * 1000, source: 'personal-reminders', kind: 'reminder.proposal_state', correlation: correlationFrom(row), data: {...redactValue(row), snapshotOfCurrentState: true}, sourceRef: sourceRef(file, 0, {table: 'reminder_proposals'})}));
    });
    emitRows(`SELECT reminder_id AS reminderId, status, content, scheduled_at_utc AS scheduledAtUtc,
      cron_job_id AS cronJobId, created_at_utc AS createdAtUtc, updated_at_utc AS updatedAtUtc,
      dispatched_at_utc AS dispatchedAtUtc, delivered_at_utc AS deliveredAtUtc, failure_code AS failureCode
      FROM reminders WHERE updated_at_utc BETWEEN ? AND ?`, range, (row) => event({at: (row.deliveredAtUtc ?? row.updatedAtUtc ?? row.createdAtUtc) * 1000, source: 'personal-reminders', kind: row.status === 'delivered' ? 'reminder.delivered' : 'reminder.state', correlation: correlationFrom(row), data: {...redactValue(row), snapshotOfCurrentState: true}, sourceRef: sourceRef(file, 0, {table: 'reminders'})}));
    emitRows(`SELECT proposal_id AS proposalId, confirmation_message_id AS confirmationMessageId,
      issued_at_utc AS issuedAtUtc, consumed_at_utc AS consumedAtUtc, status, consumption_result AS result
      FROM approval_grants WHERE (issued_at_utc BETWEEN ? AND ?) OR (consumed_at_utc BETWEEN ? AND ?)`, [...range, ...range], (row) => event({at: (row.consumedAtUtc ?? row.issuedAtUtc) * 1000, source: 'personal-reminders', kind: 'confirmation.grant', correlation: correlationFrom(row), data: redactValue(row), sourceRef: sourceRef(file, 0, {table: 'approval_grants'})}));
    emitRows(`SELECT id, action, entity_type AS entityType, entity_id AS entityId,
      proposal_id AS proposalId, summary_json AS summaryJson, created_at_utc AS createdAtUtc
      FROM reminder_audit_log WHERE created_at_utc BETWEEN ? AND ?`, range, (row) => {
      const summary = parseJson(row.summaryJson);
      const kind = String(row.action ?? 'reminder.audit').replace(/_/gu, '.');
      const correlation = correlationFrom({...row, reminderId: row.entityType === 'reminder' ? row.entityId : undefined});
      return event({at: row.createdAtUtc * 1000, source: 'personal-reminders', kind, correlation, data: {action: row.action, entityType: row.entityType, summary: redactValue(summary)}, sourceRef: sourceRef(file, 0, {table: 'reminder_audit_log', id: row.id})});
    });
  } finally { db.close(); }
  return output.filter((item) => item.epochMs >= from && item.epochMs <= to);
}

/** Reminder-list audit is already bound to the trusted message at write time.
 * Scheduled digest events have a slot/cron identity and no inferred QQ turn. */
export function readReminderListDatabase(file, from, to) {
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
          count: details.count, settings: details.settings, reason: details.reason},
        sourceRef: sourceRef(file, 0, {table: 'audit', id: row.id})});
    });
  } finally { db.close(); }
}

function readTraceFile(file, from, to) {
  if (!fs.existsSync(file)) return [];
  return linesOf(file).flatMap((line, index) => {
    try {
      const value = JSON.parse(line);
      const parsed = normalizeTraceEvent({...value, sourceRef: value.sourceRef ?? sourceRef(file, index + 1)});
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

/** Runtime text logs usually have trace/span IDs but no QQ MessageSid. Add a
 * clearly documented time-window link so a message query can show adjacent
 * confirmation/Cron/warning records. Native session events remain authoritative. */
function attachRuntimeCorrelation(events) {
  const turns = events.filter((item) => item.kind === 'agent.inbound' && item.correlation.sessionKey);
  for (const turn of turns) {
    const next = turns.filter((candidate) => candidate.correlation.sessionKey === turn.correlation.sessionKey && candidate.epochMs > turn.epochMs + 1)
      .sort((a, b) => a.epochMs - b.epochMs)[0];
    const end = next?.epochMs ?? turn.epochMs + 120_000;
    for (const candidate of events) {
      if (candidate.source !== 'openclaw-runtime' || candidate.epochMs < turn.epochMs || candidate.epochMs >= end) continue;
      if (!candidate.correlation.sessionKey) {
        Object.assign(candidate.correlation, {sessionKey: turn.correlation.sessionKey, qqMessageId: turn.correlation.qqMessageId});
        candidate.data.correlationQuality = 'time-window';
      }
    }
  }
}

export function collectEvents({from, to, runtimeRoot = DEFAULT_RUNTIME_ROOT, snowlumaRoot = DEFAULT_SNOWLUMA_ROOT, sources, expand = false} = {}) {
  const wanted = sources ? new Set(sources) : undefined;
  const include = (name) => !wanted || wanted.has(name);
  const events = [];
  const windows = [];
  if (include('snowluma')) events.push(...readSnowLumaLogs(snowlumaRoot, from, to));
  if (include('openclaw-runtime')) events.push(...readRuntimeLog(path.join(runtimeRoot, 'runtime.log'), from, to));
  if (include('openclaw-receipt')) {
    for (const name of ['task-receipts.jsonl', 'reminder-receipts.jsonl', 'native-tool-receipts.jsonl']) events.push(...readReceiptFile(path.join(runtimeRoot, 'channel', name), from, to));
  }
  if (include('openclaw-session')) {
    for (const dbFile of agentDatabases(runtimeRoot)) {
      const result = transcriptEvents(dbFile, from, to, {expand});
      events.push(...result.events); windows.push(...result.windows);
    }
  } else if (include('snowluma')) {
    // QQ events still benefit from a session key when only the QQ source was requested.
    const mainDb = path.join(runtimeRoot, 'agents', 'main', 'agent', 'openclaw-agent.sqlite');
    const result = transcriptEvents(mainDb, from, to);
    windows.push(...result.windows);
  }
  if (include('personal-reminders')) events.push(...readReminderDatabase(path.join(runtimeRoot, 'state', 'personal-reminders', 'reminders.sqlite'), from, to));
  if (include('personal-reminder-list')) events.push(...readReminderListDatabase(path.join(runtimeRoot, 'state', 'personal-reminder-list', 'list.sqlite'), from, to));
  if (include('trace-events')) events.push(...readTraceFile(path.join(runtimeRoot, 'channel', 'trace-events.jsonl'), from, to));
  if (include('access-control')) events.push(...readTraceFile(path.join(runtimeRoot,'channel','access-events.jsonl'),from,to));
  if (include('papers')) {
    // Configured managed root, with a portable default for isolated tests/restores.
    let root = path.join(runtimeRoot, 'documents');
    try { root = JSON.parse(safeRead(path.join(runtimeRoot, 'openclaw.json'))).plugins.entries['kurumi-papers'].config.root ?? root; } catch {}
    events.push(...readTraceFile(path.join(root, 'events.jsonl'), from, to));
  }
  if (include('web-deepseek')) {
    // Only a configured trace file exists; the provider writes nothing by default.
    let file;
    try { file = JSON.parse(safeRead(path.join(runtimeRoot, 'openclaw.json'))).plugins.entries['kurumi-web-deepseek'].config.traceFile; } catch {}
    if (typeof file === 'string' && path.isAbsolute(file)) events.push(...readTraceFile(file, from, to));
  }
  if (include('knowledgemap')) {
    for (const file of ['trace.jsonl.1', 'trace.jsonl']) events.push(...readTraceFile(path.join(runtimeRoot, 'state', 'knowledgemap', file), from, to));
  }
  attachSessionCorrelation(events, windows);
  attachTurnCorrelation(events);
  attachRuntimeCorrelation(events);
  events.sort((a, b) => a.epochMs - b.epochMs || a.source.localeCompare(b.source) || a.kind.localeCompare(b.kind));
  return events;
}

function containsEvent(eventValue, text) {
  return JSON.stringify(eventValue).toLocaleLowerCase('zh-CN').includes(String(text).toLocaleLowerCase('zh-CN'));
}

export function filterEvents(events, filters = {}) {
  const idFilters = ['messageId', 'proposalId', 'runId', 'sessionKey', 'reminderId'];
  const requested = idFilters.filter((name) => filters[name]);
  if (!requested.length) return events.filter((item) => !filters.contains || containsEvent(item, filters.contains));
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
  return events.filter((item) => selected.has(item) && (!filters.contains || containsEvent(item, filters.contains)));
}

function usage() {
  return `用法：node scripts/fusion/log-query.mjs [选项]

  --from <时间>       起始时间（带时区 ISO；无时区按 Asia/Shanghai）
  --to <时间>         结束时间
  --contains <文本>   按事件内容筛选
  --message-id <ID>   按 QQ 消息 ID 筛选（自动带出同一链路的事件）
  --proposal-id <ID>  按提醒提案筛选
  --run-id <ID>       按后台/模型运行 ID 筛选
  --session-key <键>  按 OpenClaw 会话筛选
  --reminder-id <ID>  按提醒 ID 筛选
  --source <名称>     可重复；限制为适配器名称
  --exclude-source <名称> 可重复；排除适配器
  --kind <前缀>       可重复；只看这些事件类型，前缀匹配（如 agent.tool_）
  --exclude-kind <前缀> 可重复；排除事件类型，前缀匹配
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

const VALUE_FLAGS = ['--from', '--to', '--contains', '--message-id', '--proposal-id', '--run-id', '--session-key', '--reminder-id', '--source', '--exclude-source', '--kind', '--exclude-kind', '--runtime-root', '--snowluma-root', '--limit'];
const LIST_FLAGS = {'--source': 'sources', '--exclude-source': 'excludeSources', '--kind': 'kinds', '--exclude-kind': 'excludeKinds'};
const BOOLEAN_FLAGS = {'--json': 'json', '--raw': 'raw', '--expand': 'expand', '--full': 'expand', '--turns': 'turns', '--errors': 'errors', '--audit': 'audit'};

function parseArgs(argv) {
  const result = {sources: [], excludeSources: [], kinds: [], excludeKinds: []};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help') return {...result, help: true};
    if (BOOLEAN_FLAGS[arg]) { result[BOOLEAN_FLAGS[arg]] = true; continue; }
    const [flag, inline] = String(arg).split('=', 2);
    if (!VALUE_FLAGS.includes(flag)) throw new Error(`未知参数：${arg}`);
    const value = inline ?? argv[++index];
    if (value === undefined) throw new Error(`缺少参数值：${flag}`);
    const key = flag.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
    if (LIST_FLAGS[flag]) result[LIST_FLAGS[flag]].push(value); else result[key] = value;
  }
  if (['turns', 'errors', 'audit'].filter((name) => result[name]).length > 1) throw new Error('--turns、--errors、--audit 只能选一个');
  return result;
}

export function runCli(argv = process.argv.slice(2), now = Date.now()) {
  const args = parseArgs(argv);
  if (args.help) { console.log(usage()); return 0; }
  const from = parseQueryInstant(args.from, now - 60 * 60 * 1000);
  const to = parseQueryInstant(args.to, now);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) throw new Error('时间范围无效');
  const events = collectEvents({from, to, runtimeRoot: args.runtimeRoot ?? DEFAULT_RUNTIME_ROOT, snowlumaRoot: args.snowlumaRoot ?? DEFAULT_SNOWLUMA_ROOT, sources: args.sources.length ? args.sources : undefined, expand: Boolean(args.expand)});
  const rendered = renderQuery(events, {...args, from, to});
  console.log(args.json ? JSON.stringify(rendered.json, null, 2) : rendered.lines.join('\n'));
  return 0;
}

/**
 * Pure rendering for the CLI: correlation filters, then view filters, then the
 * selected view. The default JSON keeps schemaVersion 1 fields and only adds
 * `hiddenRaw` and `calls`; view modes add a `view` field with their own data.
 */
export function renderQuery(events, options = {}) {
  const {from, to, limit: rawLimit, raw = false, expand = false, turns, errors, audit} = options;
  const correlated = filterEvents(events, options);
  const viewFilters = {kinds: options.kinds ?? [], excludeKinds: options.excludeKinds ?? [], excludeSources: options.excludeSources ?? []};
  // --errors keeps native WARN/ERROR lines; they are often the only trace of a host failure.
  const values = applyViewFilters(correlated, {...viewFilters, raw: raw || Boolean(errors)});
  const hiddenRaw = applyViewFilters(correlated, {...viewFilters, raw: true}).filter((item) => RAW_KINDS.has(item.kind)).length
    - values.filter((item) => RAW_KINDS.has(item.kind)).length;
  const requestedLimit = Number(rawLimit ?? 500);
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(5000, Math.floor(requestedLimit))) : 500;
  const range = {from: new Date(from).toISOString(), to: new Date(to).toISOString()};
  const window = `（${localTime(from)} 至 ${localTime(to)}）`;
  const rawNote = hiddenRaw ? `，已隐藏原生日志 ${hiddenRaw} 行（--raw 显示）` : '';
  if (turns || audit) {
    const grouped = groupTurns(values);
    if (audit) {
      const rows = auditTurns(grouped.turns);
      const flagged = rows.filter((row) => row.flagged);
      return {
        json: {schemaVersion: 1, view: 'audit', ...range, total: rows.length, flagged: flagged.length, shown: Math.min(limit, rows.length), turns: rows.slice(0, limit)},
        lines: formatAudit(rows, {limit}).map((line, index) => index ? line : `审计 ${line}${window}`),
      };
    }
    const timeline = grouped.timeline.slice(0, limit);
    return {
      json: {schemaVersion: 1, view: 'turns', ...range, total: grouped.turns.length, shown: timeline.filter((item) => item.kind === 'turn').length, hiddenRaw, orphanEvents: grouped.orphanEvents, timeline},
      lines: [`回合 ${grouped.turns.length}${window}${rawNote}`, ...formatTurns({timeline, orphanEvents: grouped.orphanEvents}, {full: expand})],
    };
  }
  if (errors) {
    const found = collectErrors(values);
    const items = found.items.slice(0, limit);
    return {
      json: {schemaVersion: 1, view: 'errors', ...range, total: found.items.length, shown: items.length, counts: found.counts, items},
      lines: [`错误与拒绝 ${items.length}/${found.items.length}${window}`, ...formatErrors({items, counts: found.counts})],
    };
  }
  const selected = values.slice(0, limit);
  const calls = pairCalls(selected);
  return {
    json: {schemaVersion: 1, ...range, total: values.length, shown: selected.length, hiddenRaw, events: selected, calls},
    lines: [`链路事件 ${selected.length}/${values.length}${window}${rawNote}`, ...formatListing(selected, {expand, calls})],
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = runCli(); } catch (error) { console.error(`log-query: ${error.message}`); process.exitCode = 2; }
}
