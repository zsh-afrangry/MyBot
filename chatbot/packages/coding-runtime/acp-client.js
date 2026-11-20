// DSH ACP session, notifications and permission policy for the owned stdio peer.
import {StdioRpc} from './stdio-rpc.js';
export {processIdentity, sameProcess, descendants} from './stdio-rpc.js';

export class AcpClient extends StdioRpc {
  constructor({permission = async () => false, ...process}) {
    super(process, {protocol: 'acp'});
    this.calls = new Map(); this.permission = permission;
  }
  notification(frame) {
    const update = frame.params?.update;
    if (frame.method === 'session/update' && ['tool_call', 'tool_call_update'].includes(update?.sessionUpdate)) {
      const key = `${frame.params.sessionId}:${update.toolCallId}`;
      this.calls.set(key, {...this.calls.get(key), ...update});
    }
    super.notification(frame);
    if (update?.sessionUpdate === 'tool_call_update' && ['completed', 'failed'].includes(update.status)) this.calls.delete(`${frame.params.sessionId}:${update.toolCallId}`);
  }
  async serverRequest(frame) {
    if (frame.method !== 'session/request_permission') return super.serverRequest(frame);
    const p = frame.params ?? {}, prior = this.calls.get(`${p.sessionId}:${p.toolCall?.toolCallId ?? p.toolCallId}`);
    const call = prior ? {...prior, ...p.toolCall} : undefined;
    const correlated = !!call && p.sessionId === this.sessionId;
    // Audit even a malformed or uncorrelated request; it can never be approved.
    const decision = await this.permission(p, call, {requestId: frame.id, correlated});
    const allowed = correlated && decision === true;
    const selected = p.options?.find(option => option.kind === (allowed ? 'allow_once' : 'reject_once'));
    this.send({id: frame.id, result: {outcome: selected ? {outcome: 'selected', optionId: selected.optionId} : {outcome: 'cancelled'}}});
  }
  initialize() {
    return this.request('initialize', {protocolVersion: 1, clientCapabilities: {}, clientInfo: {name: 'kurumi-coding', version: '0.1.0'}});
  }
  async open(cwd, {sessionId, model} = {}) {
    const opened = await this.request(sessionId ? 'session/resume' : 'session/new', {cwd, mcpServers: [], ...(sessionId ? {sessionId} : {})});
    this.sessionId = sessionId ?? opened.sessionId;
    if (!this.sessionId) throw Object.assign(Error('ACP did not return a session'), {code: 'missing_external_session'});
    if (model) await this.request('session/set_config_option', {sessionId: this.sessionId, configId: 'model', value: JSON.stringify(model)});
    return this.sessionId;
  }
  prompt(text) {
    return this.request('session/prompt', {sessionId: this.sessionId, prompt: [{type: 'text', text}]}, {timeoutMs: 0});
  }
  closeSession() {return this.request('session/close', {sessionId: this.sessionId});}
  cancel() {
    this.captureOwned();
    if (this.sessionId && !this.closed) this.send({method: 'session/cancel', params: {sessionId: this.sessionId}});
  }
}
