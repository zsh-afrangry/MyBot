// Task-owned ACP result capture and safe presentation. No QQ, shell execution or model-supplied paths.
import {redactText} from '../../packages/observability/index.js';
import {fail} from './policy.js';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const textContent = content => Array.isArray(content) ? content.map(block => {
  const item = block.type === 'content' ? block.content : block;
  return item?.type === 'text' && typeof item.text === 'string' ? item.text : '';
}).filter(Boolean).join('\n') : '';

// Redact whole assembled text BEFORE slicing; a credential may cross ACP chunks or page boundaries.
export function resultText(text) {
  return redactText(String(text ?? ''))
    .replace(/-----BEGIN [^-\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\n]*PRIVATE KEY-----|$)/g, '[REDACTED PRIVATE KEY]')
    .replace(/^.*\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|authorization|cookie)\b["']?\s*[:=].*$/gim, '[REDACTED credential field]')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

export class CodingResultRecorder {
  constructor(store, taskId, roundId, sessionId) {
    this.store = store; this.taskId = taskId; this.roundId = roundId; this.sessionId = sessionId; this.tools = new Map();
  }
  capture(frame) {
    if (frame.method !== 'session/update' || frame.params?.sessionId !== this.sessionId) return;
    const update = frame.params.update;
    if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text' && typeof update.content.text === 'string') {
      this.store.appendResultEvent(this.taskId, this.roundId, {kind: 'agent_report', messageId: update.messageId, text: update.content.text});
    } else if (['tool_call', 'tool_call_update'].includes(update?.sessionUpdate) && typeof update.toolCallId === 'string') {
      const prior = this.tools.get(update.toolCallId) ?? {};
      // Installed DSH emits kind=other, title=bash. Other tool outputs (file reads, searches) stay private to DSH.
      const execution = prior.execution || update.kind === 'execute' || update.title === 'bash';
      const event = {kind: 'tool', toolCallId: update.toolCallId, execution,
        title: execution ? (update.title === 'bash' || prior.title === 'bash' ? 'bash' : 'execute') : 'other',
        status: ['pending', 'in_progress', 'completed', 'failed'].includes(update.status) ? update.status : prior.status ?? 'pending',
        ...(execution && Array.isArray(update.content) ? {text: textContent(update.content)} : {})};
      this.tools.set(update.toolCallId, {...prior, ...event});
      this.store.appendResultEvent(this.taskId, this.roundId, event);
    }
  }
}

export function readCodingResult(store, task, {roundId = task.executionRoundId, section = 'execution', offset = 0, limit = 4000} = {}) {
  if (!['execution', 'agent_report'].includes(section) || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 12000) throw fail('invalid_coding_result_page');
  if (roundId === undefined) return {available: false, reason: 'result_not_recorded', taskId: task.id};
  if (typeof roundId !== 'string' || !UUID.test(roundId)) throw fail('invalid_coding_result_round');
  const round = store.result(task.id, roundId);
  if (!round) throw fail('unknown_coding_result_round');
  const tools = new Map(); let report = '', messageId;
  for (const event of store.resultEvents(task.id, roundId)) {
    if (event.kind === 'tool') tools.set(event.toolCallId, {...tools.get(event.toolCallId), ...event});
    if (event.kind === 'agent_report') {
      if (event.messageId !== undefined && event.messageId !== messageId) {report = ''; messageId = event.messageId;}
      report += event.text;
    }
  }
  const executions = [...tools.values()].filter(tool => tool.execution);
  const assembled = section === 'agent_report' ? report : executions.filter(tool => tool.text !== undefined).map(tool =>
    `[${tool.title} / ${tool.toolCallId} / ${tool.status}]\n${tool.text}`).join('\n\n');
  const safe = Array.from(resultText(assembled));
  if (offset > safe.length) throw fail('invalid_coding_result_page');
  return {available: true, taskId: task.id, roundId, currentRound: roundId === task.executionRoundId,
    state: round.state, startedAt: round.startedAt, finishedAt: round.finishedAt, interruptedAt: round.interruptedAt, externalSessionId: round.externalSessionId,
    stopReason: round.stopReason, reason: round.reason, verifiedCommit: round.verifiedCommit, changedFiles: (round.changedFiles ?? []).map(resultText),
    hostChecks: round.hostChecks, agentReportAvailable: report.length > 0,
    executionTools: executions.map(({toolCallId, title, status, text}) => ({toolCallId, title, status, outputRecorded: text !== undefined})),
    page: {section, source: section === 'execution' ? 'acp_execution_tool_results' : 'agent_report_not_host_verification',
      text: safe.slice(offset, offset + limit).join(''), offset, nextOffset: offset + limit < safe.length ? offset + limit : null, totalChars: safe.length}};
}
