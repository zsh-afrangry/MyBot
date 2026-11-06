// Read-only ToolResult adapter. Follow protocol envelopes, never arbitrary
// business children (a retrieved document containing "ok":false is not a failure).
import {redactValue} from '../../chatbot/packages/observability/index.js';
import {createHash} from 'node:crypto';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const failureStatus = value => ['error', 'failed', 'rejected', 'blocked'].includes(value);
const FIELDS = ['ok', 'status', 'code', 'proposalId', 'payloadHash', 'reminderId', 'draftId',
  'grantId', 'idempotent', 'requiresUserInput'];

function json(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return undefined; }
}

export function normalizeToolResult(value) {
  const layers = [];
  const visit = (input, depth = 0) => {
    if (depth > 8) return;
    const node = json(input);
    if (!object(node)) return;
    layers.push(node);
    // Host wrapper -> ToolResult -> business details / JSON text blocks.
    if (object(node.result)) visit(node.result, depth + 1);
    if (object(node.details)) visit(node.details, depth + 1);
    if (Array.isArray(node.content)) for (const part of node.content) {
      if (part?.type === 'text') visit(part.text, depth + 1);
    }
  };
  visit(value);
  const summary = {};
  for (const node of layers) for (const key of FIELDS) {
    if (['string', 'number', 'boolean'].includes(typeof node[key])) summary[key] = node[key];
  }
  for (const node of layers) for (const key of ['reminder', 'confirmationInstruction', 'error']) {
    if (node[key] !== undefined) summary[key] = node[key];
  }
  const bad = layers.filter(node => node.isError === true || node.ok === false || failureStatus(node.status));
  const errorNode = [...bad, ...layers.filter(node => node.error != null)].at(-1);
  if (bad.length) {
    summary.ok = false;
    const failed = bad.at(-1);
    if (failed.code) summary.code = failed.code;
    if (failureStatus(failed.status)) summary.status = failed.status;
  }
  const nestedError = errorNode?.error;
  const error = object(nestedError)
    ? {code: nestedError.code, message: nestedError.message}
    : nestedError;
  if (error != null) summary.error = error;
  if (!summary.code && object(nestedError) && typeof nestedError.code === 'string') summary.code = nestedError.code;
  if (!summary.code) {
    // A host hook can expose a machine identifier as the prefix of its block
    // reason. Extract only that identifier; never promote free text to a code.
    for (const node of layers) for (const key of ['deniedReason', 'blockReason', ...(node.status === 'blocked' ? ['reason'] : [])]) {
      if (typeof node[key] === 'string') summary.code ??= /^([A-Z][A-Z0-9_]{2,80})(?=[:：\s]|$)/u.exec(node[key])?.[1];
    }
  }
  // Preserve a clarification barrier even when another protocol layer omits it.
  if (layers.some(node => node.requiresUserInput === true)) summary.requiresUserInput = true;
  const canonical = input => Array.isArray(input) ? input.map(canonical)
    : object(input) ? Object.fromEntries(Object.keys(input).sort().map(key => [key, canonical(input[key])])) : input;
  const business = [...layers].reverse().find(node => !Array.isArray(node.content) && !object(node.details) && !object(node.result));
  const targets = new Map();
  for (const node of layers) for (const item of Array.isArray(node.results) ? node.results : []) {
    if (!object(item) || !item.proposalId || !item.payloadHash || !item.domain) continue;
    targets.set(JSON.stringify([item.domain, item.proposalId, item.payloadHash]), Object.fromEntries(
      ['domain', ...FIELDS].filter(key => ['string', 'number', 'boolean'].includes(typeof item[key])).map(key => [key, item[key]])));
  }
  const businessLayers = layers.filter(node => !object(node.result) && !object(node.details) && !Array.isArray(node.content)
    && !['toolResult', 'tool'].includes(node.role));
  const businessOutcome = businessLayers.some(node => node.ok === false || failureStatus(node.status)) ? 'error'
    : businessLayers.some(node => node.ok === true || ['ok', 'success', 'succeeded'].includes(node.status)) ? 'ok' : 'unknown';
  return {
    businessOutcome,
    summary: redactValue(summary),
    ...(error != null ? {error: redactValue(error)} : {}),
    resultConflict: layers.some(node => node.ok === true) && bad.length > 0,
    structuredOutcome: layers.some(node => typeof node.ok === 'boolean' || typeof node.status === 'string'),
    // Full structured response equality can be checked without printing its
    // private values. A different hash alone does not identify which field changed.
    ...(business ? {resultFingerprint: createHash('sha256').update(JSON.stringify(canonical(business))).digest('hex')} : {}),
    ...(targets.size ? {targetResults: redactValue([...targets.values()])} : {}),
  };
}
