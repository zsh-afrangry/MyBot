// Bounded headless CLI backend runner under the host Landlock write fence.
import fs from 'node:fs';
import {spawn} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {processIdentity, sameProcess, descendants} from './stdio-rpc.js';

export class CliClient extends EventEmitter {
  constructor({command, args = [], cwd, env, stderrFile, promptMode = 'stdin', promptFlag = '--prompt', model, backendArgs = []} = {}) {
    super();
    this.command = command;
    this.args = args;
    this.backendArgs = backendArgs;
    this.cwd = cwd;
    this.env = env;
    this.stderrFile = stderrFile;
    this.promptMode = promptMode;
    this.promptFlag = promptFlag;
    this.model = model;
    this.identity = null;
    this.child = null;
    this.closed = false;
    this.cancelRequested = false;
    this.cancelledProcesses = null;
  }

  async initialize() {
    if (typeof this.command !== 'string' || !this.command) {
      throw Object.assign(Error('cli_command_missing'), {code: 'cli_command_missing'});
    }
  }

  async open(cwd, {sessionId} = {}) {
    if (cwd) this.cwd = cwd;
    this.sessionId = sessionId ?? randomUUID();
    return this.sessionId;
  }

  prompt(text) {
    if (!this.sessionId || this.child || this.cancelRequested) {
      return Promise.reject(Object.assign(Error('cli_turn_unavailable'), {code: 'cli_turn_unavailable'}));
    }
    const extraPromptArgs = this.promptMode === 'arg'
      ? [text]
      : this.promptMode === 'flag'
        ? [this.promptFlag, text]
        : [];
    const spawnArgs = [...this.args, ...extraPromptArgs];

    return new Promise((resolve, reject) => {
      const stderr = fs.createWriteStream(this.stderrFile, {flags: 'a', mode: 0o600});
      const child = spawn(this.command, spawnArgs, {
        cwd: this.cwd,
        env: this.env,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.child = child;
      this.identity = processIdentity(child.pid);
      child.stderr.pipe(stderr, {end: false});
      child.stdin.on('error', () => {});
      stderr.on('error', () => {});

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        if (!chunk) return;
        this.emit('notification', {
          method: 'session/update',
          params: {
            sessionId: this.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {type: 'text', text: chunk},
            },
          },
        });
      });

      if (this.promptMode === 'stdin') {
        child.stdin.end(String(text) + '\n');
      } else {
        child.stdin.end();
      }

      let settled = false;
      child.once('error', error => {
        if (settled) return;
        settled = true;
        this.closed = true;
        stderr.end();
        reject(Object.assign(Error('cli_process_error'), {code: error.code ?? 'cli_execution_failed'}));
      });
      child.once('close', (code, signal) => {
        if (settled) return;
        settled = true;
        this.closed = true;
        stderr.end();
        if (this.cancelRequested) {
          resolve({stopReason: 'cancelled'});
          return;
        }
        if (code !== 0 || signal) {
          reject(Object.assign(Error(`cli_exited_${code ?? signal}`), {code: 'cli_execution_failed', exitCode: code, signal}));
          return;
        }
        resolve({stopReason: 'end_turn'});
      });
    });
  }

  captureOwned() {
    this.cancelledProcesses ??= this.identity && sameProcess(this.identity) ? descendants(this.identity.pid) : [];
  }

  async closeSession() {}

  signalOwned(sig) {
    if (sameProcess(this.identity)) {
      try { process.kill(-this.identity.pid, sig); } catch (e) { if (e.code !== 'ESRCH') throw e; }
    }
    for (const p of this.cancelledProcesses ?? []) {
      if (sameProcess(p)) {
        try { process.kill(p.pid, sig); } catch (e) { if (e.code !== 'ESRCH') throw e; }
      }
    }
  }

  cancel() {
    this.cancelRequested = true;
    this.captureOwned();
    this.signalOwned('SIGTERM');
  }

  async stop() {
    if (this.closed || !this.child) return;
    this.captureOwned();
    this.signalOwned('SIGTERM');
    await delay(150);
    this.signalOwned('SIGKILL');
  }

  async cancellationStopped() {
    this.cancelRequested = true;
    this.captureOwned();
    this.signalOwned('SIGTERM');
    for (let attempt = 0; attempt < 20; attempt++) {
      if (attempt === 10) this.signalOwned('SIGKILL');
      const procs = this.cancelledProcesses ?? [];
      if (!sameProcess(this.identity) && procs.every(p => !sameProcess(p))) return true;
      await delay(100);
    }
    return false;
  }
}
