// ACP stdio transport. No QQ, project policy, credentials loading or shell command construction.
import fs from 'node:fs';
import {spawn} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';

export function processIdentity(pid) {
  try {
    const fields = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').slice(1).join(') ').split(' ');
    return {pid: Number(pid), parent: Number(fields[1]), start: fields[19], state: fields[0]};
  } catch { return null; }
}
export function sameProcess(identity) {
  const current = identity && processIdentity(identity.pid);
  return !!current && current.start === identity.start && current.state !== 'Z';
}
export function descendants(pid) {
  const rows = fs.readdirSync('/proc').filter(n => /^\d+$/.test(n)).map(processIdentity).filter(Boolean);
  const ids = new Set([pid]);
  let size;
  do { size = ids.size; for (const row of rows) if (ids.has(row.parent)) ids.add(row.pid); } while (size !== ids.size);
  return rows.filter(row => ids.has(row.pid));
}

export class AcpClient extends EventEmitter {
  constructor({command, args, cwd, env, stderrFile, permission = async () => false}) {
    super();
    this.pending = new Map(); this.calls = new Map(); this.sequence = 0; this.permission = permission;
    this.child = spawn(command, args, {cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe']});
    this.identity = processIdentity(this.child.pid);
    this.errors = []; this.closed = false;
    const stderr = fs.createWriteStream(stderrFile, {flags: 'a', mode: 0o600});
    this.child.stderr.pipe(stderr);
    this.child.stdin.on('error', () => {});
    stderr.on('error', () => this.failAll(Object.assign(Error('ACP private log failed'), {code: 'acp_log_failed'})));
    this.exit = new Promise(resolve => {
      this.child.once('error', e => { this.failAll(Object.assign(Error('ACP process failed'), {code: e.code})); });
      this.child.once('close', (code, signal) => {
        this.closed = true; stderr.end();
        this.failAll(Object.assign(Error('ACP connection closed'), {code: 'acp_connection_closed'}));
        resolve({code, signal});
      });
    });
    let buffer = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', text => {
      buffer += text;
      let end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        try { this.receive(JSON.parse(line)); }
        catch { this.errors.push('invalid_protocol_frame'); this.failAll(Object.assign(Error('Invalid ACP frame'), {code: 'invalid_protocol_frame'})); }
      }
    });
  }
  failAll(error) {
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    this.pending.clear();
  }
  send(frame) {
    if (this.closed || this.child.stdin.destroyed) throw Object.assign(Error('ACP closed'), {code: 'acp_connection_closed'});
    this.child.stdin.write(JSON.stringify({jsonrpc: '2.0', ...frame}) + '\n');
  }
  request(method, params, {timeoutMs = 45000} = {}) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs ? setTimeout(() => {
        this.pending.delete(id); reject(Object.assign(Error('ACP control request timed out'), {code: 'acp_request_timeout'}));
      }, timeoutMs) : undefined;
      this.pending.set(id, {resolve, reject, timer});
      try { this.send({id, method, params}); }
      catch (error) { this.pending.delete(id); clearTimeout(timer); reject(error); }
    });
  }
  receive(frame) {
    if (frame.method && frame.id !== undefined) {
      void this.serverRequest(frame).catch(() => {
        try { this.send({id: frame.id, error: {code: -32603, message: 'Permission handler failed'}}); } catch { /* closed */ }
      });
    } else if (frame.method) {
      const update = frame.params?.update;
      if (frame.method === 'session/update' && update?.sessionUpdate === 'tool_call') {
        this.calls.set(`${frame.params.sessionId}:${update.toolCallId}`, update);
      }
      this.emit('notification', frame);
      if (update?.sessionUpdate === 'tool_call_update' && ['completed', 'failed'].includes(update.status)) this.calls.delete(`${frame.params.sessionId}:${update.toolCallId}`);
    } else {
      const entry = this.pending.get(frame.id);
      if (!entry) return;
      this.pending.delete(frame.id); clearTimeout(entry.timer);
      if (frame.error) entry.reject(Object.assign(Error('ACP request rejected'), {code: 'acp_request_rejected', rpcCode: frame.error.code}));
      else entry.resolve(frame.result);
    }
  }
  async serverRequest(frame) {
    if (frame.method !== 'session/request_permission') {
      this.send({id: frame.id, error: {code: -32601, message: 'Unsupported client method'}}); return;
    }
    const p = frame.params, call = this.calls.get(`${p.sessionId}:${p.toolCall?.toolCallId ?? p.toolCallId}`);
    const allowed = !!call && await this.permission(p, call);
    const selected = p.options?.find(option => option.kind === (allowed ? 'allow_once' : 'reject_once'));
    this.send({id: frame.id, result: {outcome: selected ? {outcome: 'selected', optionId: selected.optionId} : {outcome: 'cancelled'}}});
  }
  async initialize() {
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
  cancel() {
    this.cancelledProcesses ??= this.identity && sameProcess(this.identity) ? descendants(this.identity.pid) : [];
    if (this.sessionId && !this.closed) this.send({method: 'session/cancel', params: {sessionId: this.sessionId}});
  }
  async stop() {
    if (!this.closed) this.child.stdin.end();
    const owned = this.cancelledProcesses ?? (sameProcess(this.identity) ? descendants(this.identity.pid) : []);
    const signal = sig => {
      if (sameProcess(this.identity)) { try { process.kill(-this.identity.pid, sig); } catch (e) { if (e.code !== 'ESRCH') throw e; } }
      for (const identity of owned) if (sameProcess(identity)) try {process.kill(identity.pid, sig);} catch (e) {if (e.code !== 'ESRCH') throw e;}
    };
    const graceful = setTimeout(() => signal('SIGTERM'), 3000);
    const force = setTimeout(() => signal('SIGKILL'), 6000);
    try { return await this.exit; } finally { clearTimeout(graceful); clearTimeout(force); }
  }
  async cancellationStopped() {
    await this.stop();
    const signalOwned = signal => {for (const identity of this.cancelledProcesses ?? []) if (sameProcess(identity)) try {process.kill(identity.pid, signal);} catch (e) {if (e.code !== 'ESRCH') throw e;}};
    signalOwned('SIGTERM');
    for (let attempt = 0; attempt < 20; attempt++) {
      if (attempt === 10) signalOwned('SIGKILL');
      if ((this.cancelledProcesses ?? []).every(p => !sameProcess(p))) return true;
      await delay(100);
    }
    return false;
  }
}
