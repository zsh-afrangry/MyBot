// Constrain OpenClaw's native exec parameters after trusted identity authorization.
// This is an ordinary-file write fence, not network or process isolation. Contract: docs/28.
import fs from 'node:fs';
import path from 'node:path';
import {confinedProcess, probeWriteFence, fencedDirectory} from '../coding-runtime/write-fence.js';

const fail = code => {throw Object.assign(Error(code), {code});};
const inside = (file, root) => file === root || file.startsWith(root + path.sep);
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
const fields = new Set(['command', 'workdir', 'env', 'timeoutSeconds', 'host', 'node', 'ask', 'pty', 'elevated', 'background', 'yieldMs']);

export function confineOwnerExec(params, config) {
  try {
    if (!config) fail('owner_exec_disabled');
    if (!params || typeof params !== 'object' || Array.isArray(params)
      || Object.keys(params).some(key => !fields.has(key))
      || typeof params.command !== 'string' || !params.command.trim() || params.command.includes('\0')) fail('invalid_owner_exec_parameters');
    // No caller-selected launcher, environment injection, remote host, PTY, or background tool mode.
    if (params.host != null && !['auto', 'gateway'].includes(params.host)) fail('owner_exec_host_not_allowed');
    if (params.node != null || params.elevated === true || params.pty === true || params.background === true) fail('owner_exec_mode_not_allowed');
    if (params.env != null && (typeof params.env !== 'object' || Array.isArray(params.env) || Object.keys(params.env).length)) fail('owner_exec_environment_not_allowed');
    const {writeBoundary: boundary} = config;
    probeWriteFence(boundary); // Missing/failed enforcement denies; never launch without it.
    if (typeof config.workdir !== 'string' || !path.isAbsolute(config.workdir)
      || typeof config.timeoutSeconds !== 'number' || !Number.isFinite(config.timeoutSeconds) || config.timeoutSeconds <= 0) fail('invalid_owner_exec_configuration');
    const requested = params.workdir ?? config.workdir;
    if (typeof requested !== 'string' || !requested || requested.includes('\0')) fail('invalid_owner_exec_workdir');
    const workdir = fs.realpathSync(path.resolve(config.workdir, requested));
    if (!inside(workdir, boundary.root) || !fs.statSync(workdir).isDirectory()) fail('owner_exec_workdir_outside_boundary');
    const timeout = params.timeoutSeconds ?? config.timeoutSeconds;
    if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0 || timeout > config.timeoutSeconds) fail('owner_exec_timeout_out_of_range');
    const home = fencedDirectory(boundary, 'state/owner-exec');
    // env -i is inside Landlock, before the payload shell starts. Login/startup files and
    // inherited provider credentials cannot become part of the payload environment.
    const process = confinedProcess(boundary, '/usr/bin/env', ['-i',
      'PATH=/usr/local/bin:/usr/bin:/bin', 'LANG=C.UTF-8', `HOME=${home}`,
      `TMPDIR=${path.join(boundary.root, 'state', 'tmp')}`, `TMP=${path.join(boundary.root, 'state', 'tmp')}`,
      `TEMP=${path.join(boundary.root, 'state', 'tmp')}`, `XDG_CACHE_HOME=${path.join(home, 'cache')}`,
      '/bin/bash', '--noprofile', '--norc', '-c', `cd -- ${quote(workdir)} &&\n${params.command}`], workdir);
    return {params: {command: [process.command, ...process.args].map(quote).join(' '), workdir,
      host: 'gateway', elevated: false, pty: false, background: false, timeoutSeconds: timeout},
      scope: {writeRoot: boundary.root, workdir, timeoutSeconds: timeout}};
  } catch (error) {
    return {block: true, blockReason: error?.code?.startsWith('owner_exec_') || error?.code?.startsWith('invalid_owner_exec_')
      ? error.code : 'owner_exec_boundary_unavailable'};
  }
}
