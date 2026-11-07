// Inspect/stop only a persisted, detached task process tree. No caller-selected PIDs or shared-service operations.
import fs from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {processIdentity, sameProcess, descendants} from './acp-client.js';
const key = p => `${p.pid}:${p.start}:${p.bootId ?? ''}`;
const unique = rows => [...new Map(rows.map(p => [key(p), p])).values()];

export function inspectOwnedRuntime(identity, known = [], cwd) {
  const alive = known.filter(sameProcess);
  if (!identity) return {verified: alive.length === 0, stopped: alive.length === 0, processes: alive, reason: alive.length ? 'missing_runtime_identity' : undefined};
  const current = processIdentity(identity.pid);
  if (current && (current.start !== identity.start || (identity.bootId && current.bootId !== identity.bootId))) {
    return {verified: false, stopped: false, processes: alive, reason: 'runtime_pid_reused'};
  }
  const rootAlive = sameProcess(identity);
  if (rootAlive) {
    let actualCwd;
    try {actualCwd = fs.readlinkSync(`/proc/${identity.pid}/cwd`);} catch {}
    if (current.group !== identity.pid || current.session !== identity.pid || actualCwd !== cwd) {
      return {verified: false, stopped: false, processes: alive, reason: 'runtime_ownership_changed'};
    }
  }
  const group = fs.readdirSync('/proc').filter(n => /^\d+$/.test(n)).map(processIdentity)
    .filter(p => p && p.state !== 'Z' && p.group === identity.pid && p.session === identity.pid);
  // After the group leader dies, a previously recorded live member anchors continuity.
  // A bare reused numeric group ID is never enough to signal another process.
  const anchored = rootAlive || alive.some(p => group.some(q => key(p) === key(q)));
  if (group.length && !anchored) return {verified: false, stopped: false, processes: alive, reason: 'runtime_group_unverified'};
  const processes = unique([...alive, ...group, ...(rootAlive ? descendants(identity.pid).filter(sameProcess) : [])]);
  return {verified: true, stopped: processes.length === 0, processes, rootAlive};
}

export async function stopOwnedRuntime(identity, known, cwd) {
  let recorded = known ?? [];
  for (let attempt = 0; attempt < 25; attempt++) {
    const state = inspectOwnedRuntime(identity, recorded, cwd);
    if (!state.verified || state.stopped) return state;
    recorded = unique([...recorded, ...state.processes]);
    if (attempt === 0 || attempt === 12) {
      for (const p of state.processes.toReversed()) if (sameProcess(p)) {
        try {process.kill(p.pid, attempt === 0 ? 'SIGTERM' : 'SIGKILL');}
        catch (error) {if (error.code !== 'ESRCH') return {...state, verified: false, reason: 'runtime_stop_failed'};}
      }
    }
    await delay(100);
  }
  return {...inspectOwnedRuntime(identity, recorded, cwd), stopped: false, reason: 'runtime_stop_not_verified'};
}
