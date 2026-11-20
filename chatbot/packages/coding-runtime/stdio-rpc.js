// One owned process and a line-delimited JSON-RPC connection. Protocol decisions stay in the adapters.
import fs from 'node:fs';
import {spawn} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';

const bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
const rpcError = (code, message, facts = {}) => Object.assign(Error(message), {code, ...facts});

export function processIdentity(pid) {
  try {
    const fields = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').slice(1).join(') ').split(' ');
    return {pid: Number(pid), parent: Number(fields[1]), group: Number(fields[2]), session: Number(fields[3]), start: fields[19], state: fields[0], bootId};
  } catch { return null; }
}
export function sameProcess(identity) {
  const current = identity && processIdentity(identity.pid);
  return !!current && current.start === identity.start && (!identity.bootId || current.bootId === identity.bootId) && current.state !== 'Z';
}
export function descendants(pid) {
  const rows = fs.readdirSync('/proc').filter(n => /^\d+$/.test(n)).map(processIdentity).filter(Boolean);
  const ids = new Set([pid]);
  let size;
  do { size = ids.size; for (const row of rows) if (ids.has(row.parent)) ids.add(row.pid); } while (size !== ids.size);
  return rows.filter(row => ids.has(row.pid));
}

export class StdioRpc extends EventEmitter {
  constructor({command, args, cwd, env, stderrFile}, {protocol, jsonrpc = true}) {
    super();
    this.protocol = protocol; this.jsonrpc = jsonrpc; this.pending = new Map(); this.sequence = 0;
    this.child = spawn(command, args, {cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe']});
    this.identity = processIdentity(this.child.pid);
    this.closed = false;
    const stderr = fs.createWriteStream(stderrFile, {flags: 'a', mode: 0o600});
    this.child.stderr.pipe(stderr);
    this.child.stdin.on('error', () => {});
    stderr.on('error', () => this.failAll(this.error('log_failed', 'Private log failed')));
    this.exit = new Promise(resolve => {
      this.child.once('error', e => this.failAll(rpcError(e.code, 'Process failed')));
      this.child.once('close', (code, signal) => {
        this.closed = true; stderr.end();
        this.failAll(this.error('connection_closed', 'Connection closed'));
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
        catch { this.failAll(rpcError('invalid_protocol_frame', 'Invalid protocol frame')); }
      }
    });
  }
  error(suffix, message, facts) {return rpcError(`${this.protocol}_${suffix}`, message, facts);}
  failAll(error) {
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    this.pending.clear();
  }
  send(frame) {
    if (this.closed || this.child.stdin.destroyed) throw this.error('connection_closed', 'Connection closed');
    this.child.stdin.write(JSON.stringify(this.jsonrpc ? {jsonrpc: '2.0', ...frame} : frame) + '\n');
  }
  request(method, params, {timeoutMs = 45000, onResult} = {}) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs ? setTimeout(() => {
        this.pending.delete(id); reject(this.error('request_timeout', 'Control request timed out'));
      }, timeoutMs) : undefined;
      this.pending.set(id, {resolve, reject, timer, onResult});
      try { this.send({id, method, params}); }
      catch (error) { this.pending.delete(id); clearTimeout(timer); reject(error); }
    });
  }
  receive(frame) {
    if (frame.method && frame.id !== undefined) {
      void this.serverRequest(frame).catch(() => {
        try { this.send({id: frame.id, error: {code: -32603, message: 'Permission handler failed'}}); } catch { /* closed */ }
      });
    } else if (frame.method) this.notification(frame);
    else {
      const entry = this.pending.get(frame.id);
      if (!entry) return;
      this.pending.delete(frame.id); clearTimeout(entry.timer);
      if (frame.error) entry.reject(this.error('request_rejected', 'Request rejected', {rpcCode: frame.error.code}));
      else {
        try {entry.onResult?.(frame.result); entry.resolve(frame.result);}
        catch (error) {entry.reject(error);}
      }
    }
  }
  async serverRequest(frame) {this.send({id: frame.id, error: {code: -32601, message: 'Unsupported client method'}});}
  notification(frame) {this.emit('notification', frame);}
  captureOwned() {this.cancelledProcesses ??= this.identity && sameProcess(this.identity) ? descendants(this.identity.pid) : [];}
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
