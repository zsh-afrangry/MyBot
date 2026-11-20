// Codex app-server over stdio. Only a single task thread and one active turn per process.
import {StdioRpc} from './stdio-rpc.js';

const idPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const validId = value => typeof value === 'string' && idPattern.test(value);
const validItem = value => typeof value === 'string' && /^[\w.:-]{1,192}$/.test(value);
const threadPolicy = {sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'user'};
const approvalKinds = new Map([
  ['item/commandExecution/requestApproval', 'execute'],
  ['item/fileChange/requestApproval', 'edit'],
  ['item/permissions/requestApproval', 'other'],
]);
const turnMethods = new Set(['turn/completed', 'item/started', 'item/completed']);

export class CodexClient extends StdioRpc {
  constructor({permission = async () => false, codexHome, ...process}) {
    super(process, {protocol: 'codex', jsonrpc: false});
    this.permission = permission;
    this.codexHome = codexHome;
  }
  async initialize() {
    const hello = await this.request('initialize', {clientInfo: {name: 'kurumi-coding', title: 'Kurumi', version: '0.1.0'}, capabilities: null});
    if (hello?.platformOs !== 'linux' || hello.codexHome !== this.codexHome) throw this.error('unexpected_host', 'Codex reported an unexpected state directory or platform');
    this.send({method: 'initialized'});
  }
  async open(cwd, {sessionId, model} = {}) {
    if (sessionId !== undefined && !validId(sessionId)) throw this.error('invalid_thread_id', 'Invalid stored thread ID');
    const opened = await this.request(sessionId ? 'thread/resume' : 'thread/start', {
      cwd, ...threadPolicy, ...(model ? {model} : {}), ...(sessionId ? {threadId: sessionId} : {ephemeral: false}),
    });
    const id = opened?.thread?.id;
    if (!validId(id) || (sessionId && id !== sessionId)) throw this.error('thread_mismatch', 'Codex did not bind the intended thread');
    if (opened.cwd !== cwd || opened.sandbox?.type !== 'workspaceWrite' || opened.sandbox.networkAccess !== false
      || !Array.isArray(opened.sandbox.writableRoots) || opened.sandbox.writableRoots.length !== 0 || opened.approvalPolicy !== threadPolicy.approvalPolicy
      || opened.approvalsReviewer !== threadPolicy.approvalsReviewer) throw this.error('policy_mismatch', 'Codex did not bind the intended workspace and approval policy');
    this.sessionId = id;
    return id;
  }
  prompt(text) {
    if (!this.sessionId || this.turn || this.cancelRequested) throw this.error('turn_unavailable', 'Codex turn unavailable');
    return new Promise((resolve, reject) => {
      const turn = {resolve, reject, early: []};
      this.turn = turn;
      void this.request('turn/start', {threadId: this.sessionId, input: [{type: 'text', text, text_elements: []}]}, {
        onResult: result => {
          if (!validId(result?.turn?.id)) throw this.error('invalid_turn_id', 'Codex did not return a turn ID');
          turn.id = result.turn.id;
          if (this.cancelRequested) this.interrupt(turn.id);
          for (const frame of turn.early) this.notification(frame);
          turn.early.length = 0;
        },
      }).catch(error => this.finish(turn, undefined, error));
    });
  }
  finish(turn, result, error) {
    if (this.turn !== turn) return;
    this.turn = undefined;
    if (error) turn.reject(error);
    else turn.resolve(result);
  }
  failAll(error) {
    super.failAll(error);
    if (this.turn) this.finish(this.turn, undefined, error);
  }
  notification(frame) {
    const p = frame.params, turn = this.turn;
    if (!turn || p?.threadId !== this.sessionId || !turnMethods.has(frame.method)) return;
    if (!turn.id) {
      if (turn.early.length >= 128) throw this.error('early_event_limit', 'Too many events before Codex acknowledged its turn');
      turn.early.push(frame);
      return;
    }
    if (frame.method === 'turn/completed') {
      if (p.turn?.id !== turn.id) return;
      const stopReason = ({completed: 'end_turn', interrupted: 'cancelled', failed: 'backend_failed'})[p.turn.status] ?? 'backend_incomplete';
      this.finish(turn, {stopReason, externalTurnId: turn.id});
      return;
    }
    if (p.turnId !== turn.id || !validItem(p.item?.id)) return;
    const item = p.item, completed = frame.method === 'item/completed';
    if (item.type === 'commandExecution') {
      const status = ({completed: 'completed', failed: 'failed', declined: 'failed'})[item.status] ?? 'in_progress';
      this.update({sessionUpdate: completed ? 'tool_call_update' : 'tool_call', toolCallId: item.id, kind: 'execute', status,
        ...(completed && typeof item.aggregatedOutput === 'string' ? {content: [{type: 'text', text: item.aggregatedOutput}]} : {})});
    } else if (completed && item.type === 'agentMessage' && typeof item.text === 'string') {
      this.update({sessionUpdate: 'agent_message_chunk', messageId: item.id, content: {type: 'text', text: item.text}});
    }
  }
  update(update) {
    // Keep the recorder's existing events independent of app-server methods and raw payloads.
    this.emit('notification', {method: 'session/update', params: {sessionId: this.sessionId, update}});
  }
  async serverRequest(frame) {
    const kind = approvalKinds.get(frame.method);
    if (!kind) return super.serverRequest(frame);
    const p = frame.params;
    await this.permission({...p, method: frame.method, sessionId: p?.threadId}, {
      toolCallId: p?.itemId, kind, rawInput: {cwd: p?.cwd, directory: p?.grantRoot, permissions: p?.permissions},
    }, {requestId: frame.id, correlated: Boolean(this.turn?.id && p?.threadId === this.sessionId && p?.turnId === this.turn.id && validItem(p?.itemId))});
    // The pilot never grants extra permissions, even if the request is well formed.
    const result = kind === 'other' ? {permissions: {}, scope: 'turn'} : {decision: 'decline'};
    this.send({id: frame.id, result});
  }
  closeSession() {return this.request('thread/unsubscribe', {threadId: this.sessionId});}
  interrupt(turnId) {
    void this.request('turn/interrupt', {threadId: this.sessionId, turnId}, {timeoutMs: 2500}).catch(() => {});
  }
  cancel() {
    this.captureOwned();
    if (this.cancelRequested) return;
    this.cancelRequested = true;
    if (this.turn?.id && !this.closed) this.interrupt(this.turn.id);
  }
}
