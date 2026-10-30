// Append-only private permission evidence; public summaries contain counts and closed-vocabulary fields only.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {digest} from './policy.js';

const within = (file, root) => file === root || file.startsWith(root + path.sep);
function requestedPaths(call, params) {
  const paths = new Set();
  const visit = (value, key = '') => {
    if (Array.isArray(value)) {for (const item of value) visit(item, key);}
    else if (value && typeof value === 'object') {for (const [name, item] of Object.entries(value)) visit(item, name);}
    else if (typeof value === 'string' && /^(path|filePath|file_path|cwd|directory|target|source)$/i.test(key) && path.isAbsolute(value)) paths.add(path.resolve(value));
  };
  visit(call?.rawInput); visit(call?.locations); visit(params?.toolCall?.locations);
  return [...paths].sort();
}
export class PermissionAudit {
  constructor(directory, task, boundary) {
    this.file = path.join(directory, 'permission-requests.jsonl'); this.task = task; this.boundary = boundary;
    this.rows = fs.existsSync(this.file) ? fs.readFileSync(this.file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  }
  reject(params, call, context, roundId) {
    const requestKey = digest(JSON.stringify([roundId, context?.requestId ?? randomUUID()]));
    const duplicate = this.rows.find(row => row.requestKey === requestKey);
    if (duplicate) return {duplicate: true, summary: this.summary()};
    const paths = requestedPaths(call, params), input = call?.rawInput?.arguments ?? call?.rawInput;
    const mode = input?.sandbox_permissions;
    const requestedMode = ['workspace-write', 'danger-full-access', 'read-only'].includes(mode) ? mode : 'unknown';
    const scope = paths.length ? (paths.every(file => within(file, this.boundary.root)) ? 'inside_test_root' : 'outside_test_root') : 'unknown';
    const kind = ['read', 'edit', 'delete', 'move', 'search', 'execute', 'fetch'].includes(call?.kind) ? call.kind : 'other';
    const row = {schemaVersion: 1, requestKey, at: new Date().toISOString(), taskId: this.task.id, projectId: this.task.projectId,
      externalSessionId: params?.sessionId, roundId, requestId: context?.requestId, toolCallId: call?.toolCallId ?? params?.toolCall?.toolCallId ?? params?.toolCallId,
      correlated: context?.correlated === true, kind, requestedMode, scope, requestedPaths: paths,
      scopeSource: 'structured_paths_only_command_effects_not_inferred', decision: 'rejected', decisionSource: 'owner_test_folder_only',
      reviewState: 'awaiting_owner_policy_review', params, ...(call ? {call} : {})};
    // Retain request/reason privately, including unknown or uncorrelated requests. Never grant extra access.
    fs.appendFileSync(this.file, JSON.stringify(row) + '\n', {mode: 0o600}); fs.chmodSync(this.file, 0o600);
    this.rows.push(row); return {duplicate: false, summary: this.summary()};
  }
  summary() {
    const byKind = {}, byScope = {}, byMode = {};
    for (const row of this.rows) {
      byKind[row.kind] = (byKind[row.kind] ?? 0) + 1; byScope[row.scope] = (byScope[row.scope] ?? 0) + 1; byMode[row.requestedMode] = (byMode[row.requestedMode] ?? 0) + 1;
    }
    return {requests: this.rows.length, rejected: this.rows.length, approved: 0, byKind, byScope, byMode,
      firstAt: this.rows[0]?.at, lastAt: this.rows.at(-1)?.at, privateAuditFile: this.file};
  }
}
