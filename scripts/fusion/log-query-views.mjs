/**
 * Presentation layer for log-query: view filters, tool-call pairing, turn
 * grouping, error and audit views. Input is the normalized event list from
 * log-query.mjs; nothing here reads files or calls services, so every view is
 * testable with synthetic events.
 */
import {summarizeText} from '../../chatbot/packages/observability/index.js';

/** Unclassified native log lines; hidden unless --raw or an explicit --kind asks for them. */
export const RAW_KINDS = new Set(['openclaw.log', 'snowluma.log']);
const CALL_KINDS = new Set(['agent.tool_call', 'agent.tool_result', 'agent.tool_nested', 'access.tool']);
const WRAPPERS = new Set(['tool_call']);
const OUTCOME = {ok: '成功', error: '失败', deny: '拒绝', pending: '未返回'};
// Member events stay out of the JSON form of a call; --expand reads them here.
const MEMBERS = new WeakMap();

/** Parse JSON-in-string layers (tool results are often JSON text inside JSON). */
export function deepParseJson(value, layers = 0) {
  if (typeof value === 'string') {
    const text = value.trim();
    if (layers < 8 && text && ['{', '[', '"'].includes(text[0])) {
      try { return deepParseJson(JSON.parse(text), layers + 1); } catch { return value; }
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => deepParseJson(item, layers));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, deepParseJson(item, layers)]));
  return value;
}

export function localTime(epoch) {
  return new Intl.DateTimeFormat('zh-CN', {timeZone: 'Asia/Shanghai', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'}).format(new Date(epoch)).replace(/\//gu, '-');
}

/** Prefix match: `agent.tool_` selects agent.tool_call/result/nested. A trailing `*` is optional. */
export function matchesKind(kind, patterns = []) {
  return patterns.some((pattern) => kind.startsWith(String(pattern).replace(/\*$/u, '')));
}

export function applyViewFilters(events, {kinds = [], excludeKinds = [], excludeSources = [], raw = false} = {}) {
  return events.filter((item) => (raw || !RAW_KINDS.has(item.kind) || (kinds.length && matchesKind(item.kind, kinds)))
    && (!kinds.length || matchesKind(item.kind, kinds))
    && !matchesKind(item.kind, excludeKinds)
    && !excludeSources.includes(item.source));
}

function errorText(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') return String(value.code ?? value.message ?? '');
  return String(value);
}

/** Heuristic class for free-text tool errors; explicit codes always win. */
export function classifyError(text) {
  if (!text) return 'tool_error';
  if (/invalid argument|validation|schema|参数|缺少|必须|二选一|不存在|不能|只能/iu.test(text)) return 'validation';
  if (/timeout|timed out|超时/iu.test(text)) return 'timeout';
  return 'tool_error';
}

const failed = (item) => item && (item.data.isError === true || item.data.summary?.ok === false
  || ['error', 'failed'].includes(item.data.summary?.status));

/**
 * One row per model tool call. The outer `toolCallId` keys the call and its
 * result; nested real-tool records point back through `parentToolCallId`, and
 * access decisions carry either the outer or the nested ID.
 */
export function pairCalls(events) {
  const calls = new Map();
  const entry = (id) => {
    if (!calls.has(id)) calls.set(id, {call: undefined, result: undefined, nested: [], access: []});
    return calls.get(id);
  };
  const nestedParent = new Map();
  for (const item of events) {
    if (item.kind === 'agent.tool_nested' && item.correlation.toolCallId && item.correlation.parentToolCallId) nestedParent.set(item.correlation.toolCallId, item.correlation.parentToolCallId);
  }
  for (const item of events) {
    const id = item.correlation.toolCallId;
    if (!id || !CALL_KINDS.has(item.kind)) continue;
    if (item.kind === 'agent.tool_call') entry(id).call = item;
    else if (item.kind === 'agent.tool_result') entry(id).result = item;
    else if (item.kind === 'agent.tool_nested') entry(item.correlation.parentToolCallId ?? id).nested.push(item);
    else entry(nestedParent.get(id) ?? id).access.push(item);
  }
  return [...calls.entries()].map(([toolCallId, parts]) => {
    const {call, result, nested, access} = parts;
    const members = [call, ...access, ...nested, result].filter(Boolean);
    const first = members.reduce((min, item) => item.epochMs < min.epochMs ? item : min);
    const real = access.find((item) => !WRAPPERS.has(item.data.tool));
    const tool = nested[0]?.data.tool ?? call?.data.tool ?? result?.data.tool ?? real?.data.tool ?? access[0]?.data.tool ?? 'unknown';
    const declaredTool = call?.data.declaredTool ?? result?.data.declaredTool ?? access.find((item) => WRAPPERS.has(item.data.tool))?.data.tool ?? tool;
    const denied = access.find((item) => item.data.decision === 'deny');
    const blocked = result?.data.hostStatus === 'blocked';
    const error = !denied && !blocked && (failed(result) || nested.some(failed));
    const outcome = denied || blocked ? 'deny' : error ? 'error' : result || nested.length ? 'ok' : 'pending';
    let errorCode;
    if (denied) errorCode = denied.data.code ?? 'denied';
    else if (blocked) errorCode = 'blocked';
    else if (error) {
      const source = nested.find(failed) ?? result;
      const code = source?.data.summary?.code;
      errorCode = typeof code === 'string' && code ? code : classifyError(errorText(source?.data.error ?? result?.data.error));
    }
    const nestedDuration = nested.map((item) => item.data.durationMs).filter(Number.isFinite);
    const durationMs = nestedDuration.length ? Math.max(...nestedDuration) : call && result ? result.epochMs - call.epochMs : undefined;
    const correlation = {...first.correlation, ...call?.correlation, toolCallId};
    delete correlation.parentToolCallId;
    const row = {
      kind: 'tool.call', at: first.at, epochMs: first.epochMs, toolCallId, tool, declaredTool, outcome,
      ...(errorCode ? {errorCode} : {}),
      ...(durationMs !== undefined ? {durationMs} : {}),
      access: access.map((item) => ({tool: item.data.tool, decision: item.data.decision, code: item.data.code})),
      nestedToolCallIds: nested.map((item) => item.correlation.toolCallId).filter(Boolean),
      correlation,
    };
    MEMBERS.set(row, members);
    return row;
  }).sort((a, b) => a.epochMs - b.epochMs);
}

export function callMembers(row) { return MEMBERS.get(row) ?? []; }

const sessionOf = (item) => item.correlation.sessionKey ?? item.correlation.sessionId;
const MARKERS = new Set(['session.reset', 'session.compaction']);

/**
 * Turn = one agent.inbound up to the next inbound (or /new) in the same session.
 * Membership prefers runId, then the QQ message/reply ID, then time order, so a
 * QQ inbound logged a moment before its transcript entry still lands in its own turn.
 */
export function groupTurns(events, calls = pairCalls(events)) {
  const anchors = events.filter((item) => item.kind === 'agent.inbound');
  const markers = events.filter((item) => MARKERS.has(item.kind));
  const turns = anchors.map((item) => ({
    kind: 'turn', at: item.at, epochMs: item.epochMs, session: sessionOf(item) ?? null,
    runId: item.correlation.runId ?? null, qqMessageId: item.correlation.qqMessageId ?? null,
    userText: item.data.text ?? '', replies: [], outbound: 0, calls: [], errors: 0, denied: 0, aborted: false,
  }));
  const byRun = new Map(turns.filter((turn) => turn.runId).map((turn) => [turn.runId, turn]));
  const byMessage = new Map(turns.filter((turn) => turn.qqMessageId).map((turn) => [turn.qqMessageId, turn]));
  const boundaries = [...turns.map((turn) => ({turn, epochMs: turn.epochMs, session: turn.session})),
    ...markers.map((item) => ({turn: null, epochMs: item.epochMs, session: sessionOf(item)}))]
    .sort((a, b) => a.epochMs - b.epochMs);
  const byTime = (item) => {
    const session = sessionOf(item);
    let found;
    for (const boundary of boundaries) {
      if (boundary.epochMs > item.epochMs + 500) break;
      if (!session || !boundary.session || boundary.session === session) found = boundary;
    }
    return found?.turn ?? undefined;
  };
  const owner = (item) => byRun.get(item.correlation.runId) ?? byMessage.get(item.correlation.qqMessageId)
    ?? byMessage.get(item.correlation.replyToId) ?? byTime(item);
  let orphanEvents = 0;
  for (const call of calls) {
    const turn = owner(call);
    if (!turn) { orphanEvents += 1; continue; }
    turn.calls.push(call);
    if (call.outcome === 'error') turn.errors += 1;
    if (call.outcome === 'deny') turn.denied += 1;
  }
  for (const item of events) {
    if (!['agent.reply', 'qq.outbound', 'agent.turn_aborted', 'agent.model_error', 'agent.prompt_error'].includes(item.kind)) continue;
    const turn = owner(item);
    if (!turn) { orphanEvents += 1; continue; }
    if (item.kind === 'agent.reply') turn.replies.push(item.data.text ?? '');
    else if (item.kind === 'qq.outbound') turn.outbound += 1;
    else if (item.kind === 'agent.turn_aborted') turn.aborted = true;
    else turn.errors += 1;
  }
  const timeline = [...turns, ...markers.map((item) => ({kind: item.kind, at: item.at, epochMs: item.epochMs, session: sessionOf(item) ?? null, data: item.data}))]
    .sort((a, b) => a.epochMs - b.epochMs);
  return {turns, markers: timeline.filter((item) => item.kind !== 'turn'), timeline, orphanEvents};
}

const WARN_LEVELS = new Set(['WARN', 'ERROR', 'FATAL']);

/** Some native lines put message text where the subsystem goes; a code must stay an identifier, never log text. */
function subsystemCode(value) {
  const text = String(value ?? '').trim();
  if (/^[\w./-]{1,48}$/u.test(text)) return text;
  const bracket = /^\[([\w./-]{1,48})\]/u.exec(text);
  if (bracket) return bracket[1];
  try { const parsed = JSON.parse(text); if (/^[\w./-]{1,48}$/u.test(String(parsed?.module ?? parsed?.subsystem ?? ''))) return parsed.module ?? parsed.subsystem; } catch {}
  return text.startsWith('(node:') ? 'node' : 'openclaw';
}

/** Classify one non-call event for --errors; undefined means not an error. */
function eventError(item) {
  const data = item.data ?? {};
  if (item.kind === 'agent.model_error') return {type: 'model_error', code: `model_${data.stopReason ?? 'error'}`};
  if (item.kind === 'agent.prompt_error') return {type: 'model_error', code: 'prompt_error'};
  if (item.kind === 'agent.turn_aborted') return {type: 'turn_aborted', code: 'turn_aborted'};
  if (item.kind === 'access.tool' && data.decision === 'deny') return {type: 'access_denied', code: data.code ?? 'denied'};
  if (item.source === 'openclaw-runtime' && WARN_LEVELS.has(String(data.level ?? '').toUpperCase())) return {type: 'host_warning', code: item.kind === 'openclaw.log' ? `${subsystemCode(data.subsystem)}:${String(data.level).toUpperCase()}` : item.kind};
  if (item.source === 'snowluma' && WARN_LEVELS.has(String(data.level ?? '').toUpperCase())) return {type: 'host_warning', code: `snowluma:${String(data.level).toUpperCase()}`};
  const http = Number(data.httpStatus);
  if (Number.isFinite(http) && (http < 200 || http >= 300)) return {type: 'business_error', code: `http_${http}`};
  if (data.ok === false || ['error', 'failed'].includes(data.status) || data.failureCode) {
    const code = String(data.code ?? data.failureCode ?? data.error ?? data.status ?? 'failed');
    return {type: 'business_error', code: /^[\w.:-]{1,60}$/u.test(code) ? code : 'business_error'};
  }
  return undefined;
}

/** Failed/denied calls plus host warnings and failed backend records, with counts by code. */
export function collectErrors(events, calls = pairCalls(events)) {
  const items = calls.filter((call) => call.outcome === 'error' || call.outcome === 'deny').map((call) => ({
    type: call.outcome === 'deny' ? 'access_denied' : call.errorCode === 'validation' ? 'validation' : 'tool_error',
    code: call.errorCode, at: call.at, epochMs: call.epochMs, tool: call.tool, toolCallId: call.toolCallId, correlation: call.correlation,
  }));
  for (const item of events) {
    if (CALL_KINDS.has(item.kind) && item.correlation.toolCallId) continue;
    const found = eventError(item);
    if (found) items.push({...found, at: item.at, epochMs: item.epochMs, kind: item.kind, source: item.source, correlation: item.correlation, sourceRef: item.sourceRef});
  }
  items.sort((a, b) => a.epochMs - b.epochMs);
  const counts = {};
  for (const item of items) counts[item.code] = (counts[item.code] ?? 0) + 1;
  return {items, counts};
}

/** Per turn: denied tools (overreach attempts) and consecutive retries of the same tool after a failure. */
export function auditTurns(turns) {
  return turns.map((turn) => {
    const retries = [];
    let run = [];
    const flush = () => {
      if (run.length >= 2 && run.slice(0, -1).some((call) => call.outcome !== 'ok')) {
        retries.push({tool: run[0].tool, attempts: run.length, failures: run.filter((call) => call.outcome !== 'ok').length, finalOutcome: run.at(-1).outcome});
      }
      run = [];
    };
    for (const call of turn.calls) {
      if (run.length && run[0].tool !== call.tool) flush();
      run.push(call);
    }
    flush();
    const denied = turn.calls.filter((call) => call.outcome === 'deny').map((call) => ({tool: call.tool, code: call.errorCode, toolCallId: call.toolCallId}));
    return {at: turn.at, epochMs: turn.epochMs, session: turn.session, runId: turn.runId, qqMessageId: turn.qqMessageId,
      tools: turn.calls.map((call) => call.tool), denied, retries, flagged: denied.length > 0 || retries.length > 0};
  });
}

const idsText = (correlation = {}, names) => Object.entries(correlation)
  .filter(([key, value]) => value && (!names || names.includes(key))).map(([key, value]) => `${key}=${value}`).join(' ');
const clip = (value, limit, full) => full ? summarizeText(value, Number.MAX_SAFE_INTEGER) : summarizeText(value, limit);

function markerText(item) {
  const data = item.data ?? {};
  return item.kind === 'session.reset' ? `/new 新会话（${data.reason ?? '未知'}）`
    : `上下文压缩 tokens ${data.tokensBefore ?? '?'}→${data.tokensAfter ?? '?'}，摘要 ${data.summaryChars ?? 0} 字`;
}

export function formatEvent(eventValue, {full = false} = {}) {
  const ids = idsText(eventValue.correlation);
  const data = eventValue.data;
  const body = eventValue.source === 'access-control'
    ? [data.tool, data.permission, data.decision, data.code].filter(Boolean).join(' ')
    : eventValue.source === 'web-deepseek'
    ? [data.tool, data.status, data.code, data.httpStatus, data.resultCount ?? data.chars, `${data.durationMs}ms`].filter((value) => value !== undefined && value !== null && value !== '').join(' ')
    : MARKERS.has(eventValue.kind) ? markerText(eventValue)
    : data.text ?? data.textPreview ?? data.content ?? data.message ?? data.tool ?? data.result ?? '';
  const suffix = body ? ` | ${clip(typeof body === 'string' ? body : JSON.stringify(body), 260, full)}` : '';
  return `${localTime(eventValue.epochMs)} [${eventValue.kind}] ${eventValue.source}${ids ? ` (${ids})` : ''}${suffix}`;
}

function callSummary(call) {
  return [call.tool + (call.declaredTool !== call.tool ? `（经 ${call.declaredTool}）` : ''), OUTCOME[call.outcome],
    call.errorCode, call.durationMs !== undefined ? `${call.durationMs}ms` : undefined].filter(Boolean).join(' ');
}

function expandedLines(call) {
  return callMembers(call).filter((item) => item.data.expanded).flatMap((item) => [
    `    ${item.kind}:`, ...JSON.stringify(item.data.expanded, null, 2).split('\n').map((line) => `      ${line}`)]);
}

export function formatCall(call, {expand = false} = {}) {
  const access = call.access.length ? ` 访问=${call.access.map((item) => `${item.tool}:${item.decision}${item.decision === 'deny' ? `:${item.code}` : ''}`).join(',')}` : '';
  const ids = idsText(call.correlation, ['runId', 'qqMessageId', 'toolCallId']);
  return [`${localTime(call.epochMs)} [tool.call] ${callSummary(call)}${access}${ids ? ` (${ids})` : ''}`, ...(expand ? expandedLines(call) : [])];
}

/** Default text listing: the call/result/nested/access rows of one call collapse into one line. */
export function formatListing(events, {expand = false, calls = pairCalls(events)} = {}) {
  const owner = new Map();
  for (const call of calls) for (const item of callMembers(call)) owner.set(item, call);
  const printed = new Set();
  const lines = [];
  for (const item of events) {
    const call = owner.get(item);
    if (!call) { lines.push(formatEvent(item, {full: expand})); continue; }
    if (printed.has(call)) continue;
    printed.add(call);
    lines.push(...formatCall(call, {expand}));
  }
  return lines;
}

export function formatTurns({timeline, orphanEvents}, {full = false} = {}) {
  const lines = [];
  for (const item of timeline) {
    if (item.kind !== 'turn') { lines.push(`${localTime(item.epochMs)} ── ${markerText(item)} ──${item.session ? ` ${item.session}` : ''}`); continue; }
    lines.push(`${localTime(item.epochMs)} 回合${item.runId || item.qqMessageId ? ` (${idsText({runId: item.runId, qqMessageId: item.qqMessageId})})` : ''}`);
    lines.push(`  用户：${clip(item.userText, 200, full)}`);
    for (const call of item.calls) lines.push(`  工具：${callSummary(call)}`);
    for (const reply of item.replies) lines.push(`  回复：${clip(reply, 200, full)}`);
    if (item.outbound) lines.push(`  QQ 发出 ${item.outbound} 条`);
    if (item.aborted) lines.push('  （本回合中断）');
  }
  if (orphanEvents) lines.push(`（另有 ${orphanEvents} 条调用或回复不在本时间窗的任何回合内）`);
  return lines;
}

export function formatErrors({items, counts}) {
  const summary = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([code, count]) => `${code}×${count}`).join('，');
  return [`按错误码：${summary || '无'}`, ...items.map((item) => `${localTime(item.epochMs)} [${item.type}] ${item.code} ${item.tool ?? item.kind}${idsText(item.correlation, ['runId', 'qqMessageId', 'toolCallId']) ? ` (${idsText(item.correlation, ['runId', 'qqMessageId', 'toolCallId'])})` : ''}`)];
}

/** Text lists only flagged turns; the JSON view keeps every row. */
export function formatAudit(rows, {limit = Infinity} = {}) {
  const flagged = rows.filter((row) => row.flagged);
  return [`${rows.length} 个回合，${flagged.length} 个需要注意`, ...flagged.slice(0, limit).map((row) => {
    const notes = [
      ...row.denied.map((item) => `拒绝 ${item.tool}:${item.code}`),
      ...row.retries.map((item) => `重试 ${item.tool}×${item.attempts}（失败 ${item.failures}，最终${OUTCOME[item.finalOutcome]}）`),
    ];
    return `${localTime(row.epochMs)}${row.runId ? ` runId=${row.runId}` : ''} 工具=[${row.tools.join(',')}]${notes.length ? ` 注意：${notes.join('；')}` : ''}`;
  })];
}
