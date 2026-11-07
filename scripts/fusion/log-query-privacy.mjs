// Output allowlist, applied AFTER parsing/correlation/auditing. This is data
// minimization, not anonymization: retained opaque IDs can still identify people.
const containers = new Set(['events', 'calls', 'timeline', 'turns', 'items', 'access', 'nestedToolCallIds',
  'denied', 'retries', 'failures', 'recoveries', 'clarificationRetries', 'correlation', 'data', 'summary',
  'diagnostics', 'functions', 'schemas', 'tools', 'fingerprints', 'targetResults', 'modelTurns', 'models', 'usage', 'sources', 'settings', 'ids']);
const identifiers = new Set(['id', 'receiptId', 'sessionId', 'sessionKey', 'session', 'runId', 'traceId', 'spanId', 'parentSpanId',
  'qqMessageId', 'replyToId', 'proposalId', 'payloadHash', 'reminderId', 'cronJobId', 'taskId', 'conversationId',
  'senderId', 'recipientId', 'eventKey', 'draftId', 'grantId', 'confirmationMessageId', 'sourceMessageId',
  'presentationMessageId', 'toolCallId', 'parentToolCallId', 'failedToolCallId', 'recoveredToolCallId',
  'barrierToolCallId', 'loadId', 'sha256', 'resultFingerprint', 'ledgerId']);
const labels = new Set(['source', 'kind', 'view', 'tool', 'declaredTool', 'outcome', 'errorCode', 'code',
  'status', 'hostStatus', 'decision', 'permission', 'domain', 'actionKind', 'action', 'failureCode',
  'consumptionResult', 'lastStatus', 'lastDeliveryStatus', 'scheduleKind', 'sessionTarget', 'correlationQuality',
  'metadataTrust', 'replyToSource', 'ingressKind', 'fingerprintScope', 'component', 'name', 'consistency', 'table', 'finalOutcome', 'storage', 'executionOutcome', 'businessOutcome', 'textCompleteness', 'model', 'provider', 'stopReason', 'payloadKind', 'reason', 'deliveryState', 'knownCode', 'method', 'resource', 'cache', 'direction', 'storedComparison']);
const dates = new Set(['at', 'from', 'to', 'snapshotAt', 'scheduleAt', 'recordedAt']);
const facts = new Set(['schemaVersion', 'epochMs', 'durationMs', 'count', 'total', 'shown', 'hiddenRaw', 'orphanEvents',
  'flagged', 'textLength', 'displayTruncated', 'limit', 'offset', 'nextOffset', 'truncated', 'noText', 'enabled', 'ok', 'isError', 'idempotent',
  'requiresUserInput', 'resultConflict', 'structuredOutcome', 'snapshotOfCurrentState', 'partialPage',
  'attempts', 'failures', 'outbound', 'errors', 'denied', 'aborted', 'pid', 'quoteLoaded', 'replyToAvailableToAgent',
  'replyToIsQuote', 'isTailDispatch', 'loadedSurfaceKnown', 'activeProcessVerified', 'createdAtMs', 'updatedAtMs', 'nextRunAtMs', 'lastRunAtMs', 'presentationOrder',
  'createdAtUtc', 'updatedAtUtc', 'committedAtUtc', 'expiresAtUtc', 'issuedAtUtc', 'consumedAtUtc', 'presentedAtUtc', 'sentAtUtc',
  'scheduledAtUtc', 'dispatchedAtUtc', 'deliveredAtUtc', 'version', 'generation', 'revision', 'revisionBefore', 'revisionAfter', 'summaries', 'bytes', 'nameVersion', 'available', 'metadataOnly', 'totalRows', 'hiddenKnown', 'failureRate', 'averageDurationMs', 'measured', 'startedAtMs', 'finishedAtMs', 'exitCodeAvailable', 'exitCode', 'known', 'usageAvailable', 'input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens', 'inputTokens', 'outputTokens', 'fallbackKnown', 'cacheHit', 'stale', 'resultCount', 'missing', 'compacted', 'tokensBefore', 'tokensAfter', 'summaryChars']);
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_:.+-]{1,500}$/u.test(value);
const label = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,120}$/u.test(value);

export function noTextProjection(value, key = '') {
  if (value === null) return !key || containers.has(key) || identifiers.has(key) || labels.has(key) || dates.has(key) || facts.has(key) ? null : undefined;
  if (facts.has(key) && (typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value))) return value;
  if (identifiers.has(key)) return identifier(value) ? value : undefined;
  if (labels.has(key)) return label(value) ? value : undefined;
  if (dates.has(key)) return typeof value === 'string' && /^\d{4}-\d\d-\d\dT/u.test(value) && Number.isFinite(Date.parse(value)) ? value : undefined;
  if (key === 'counts') return Object.fromEntries(Object.entries(value ?? {}).filter(([code, count]) => label(code) && Number.isFinite(count)));
  if (key && !containers.has(key)) return undefined;
  if (Array.isArray(value)) return value.flatMap(item => {
    const projected = typeof item === 'string' ? (identifier(item) ? item : undefined) : noTextProjection(item);
    return projected === undefined ? [] : [projected];
  });
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).flatMap(([name, item]) => {
    const projected = noTextProjection(item, name);
    return projected === undefined ? [] : [[name, projected]];
  }));
  return undefined;
}
