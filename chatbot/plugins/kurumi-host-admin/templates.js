import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {parseSystemctlShow, serviceTargetPattern} from './policy.js';

const execFileAsync = promisify(execFile);
const CLEAN_ENV = Object.freeze({PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8'});
const truncate = (text, max = 2048) => {
  const s = String(text ?? '');
  return s.length <= max ? s : s.slice(0, max);
};

export function createProcessRunner({timeoutMs = 15000} = {}) {
  return {
    async run({command, args}) {
      try {
        const {stdout, stderr} = await execFileAsync(command, args, {
          shell: false,
          timeout: timeoutMs,
          maxBuffer: 64 * 1024,
          encoding: 'utf8',
          env: CLEAN_ENV,
        });
        return {ok: true, exitCode: 0, signal: null, timedOut: false, stdout: truncate(stdout, 8192), stderr: truncate(stderr)};
      } catch (error) {
        const timedOut = Boolean(error?.killed && (error?.signal === 'SIGTERM' || error?.code === 'ETIMEDOUT'));
        const exitCode = typeof error?.code === 'number' ? error.code : null;
        return {
          ok: false,
          exitCode,
          signal: typeof error?.signal === 'string' ? error.signal : null,
          timedOut,
          stdout: truncate(error?.stdout ?? '', 8192),
          stderr: truncate(error?.stderr ?? ''),
        };
      }
    },
  };
}

export const TEMPLATES = Object.freeze({
  'service.restart': Object.freeze({
    validateTarget(target) {
      return typeof target === 'string'
        && serviceTargetPattern.test(target)
        && !target.startsWith('.')
        && !target.startsWith('-')
        && !target.includes('..');
    },
    commandSpec(action, cfg) {
      return {
        command: cfg.sudoCommand,
        args: ['-n', '--', cfg.systemctlCommand, 'restart', action.target],
      };
    },
    async inspect(action, cfg, runner) {
      const res = await runner.run({
        command: cfg.systemctlCommand,
        args: [
          'show', '--no-pager',
          '--property=LoadState,ActiveState,SubState,MainPID,ExecMainStartTimestamp,UnitFileState',
          '--', action.target,
        ],
      });
      if (!res.ok) {
        return {
          available: false,
          code: res.timedOut ? 'systemctl_inspect_timeout' : 'systemctl_inspect_failed',
          exitCode: res.exitCode,
        };
      }
      const parsed = parseSystemctlShow(res.stdout);
      if (!parsed.ActiveState) {
        return {available: false, code: 'systemctl_inspect_invalid', exitCode: 0};
      }
      return {available: true, ...parsed};
    },
    verifyOutcome(beforeState, afterState, execResult) {
      if (!execResult) {
        return {state: 'unknown', code: 'host_admin_exec_unknown', verification: {executed: false}};
      }
      if (execResult.timedOut) {
        return {state: 'unknown', code: 'host_admin_exec_timeout', verification: {executed: false, timedOut: true}};
      }
      if (execResult.exitCode !== 0) {
        return {
          state: 'failed',
          code: 'host_admin_sudo_failed',
          verification: {executed: false, exitCode: execResult.exitCode},
        };
      }
      if (!afterState?.available) {
        return {
          state: 'unknown',
          code: 'host_admin_post_check_unavailable',
          verification: {executed: true, exitCode: 0, afterAvailable: false},
        };
      }
      const active = afterState.ActiveState === 'active';
      const pidChanged = beforeState?.available && beforeState.MainPID !== undefined && afterState.MainPID !== undefined
        ? beforeState.MainPID !== afterState.MainPID : null;
      const startedAtChanged = beforeState?.available && beforeState.ExecMainStartTimestamp !== undefined
        && afterState.ExecMainStartTimestamp !== undefined
        ? beforeState.ExecMainStartTimestamp !== afterState.ExecMainStartTimestamp : null;
      if (!active) {
        return {
          state: 'failed',
          code: 'host_admin_post_check_failed',
          verification: {executed: true, exitCode: 0, active: false, pidChanged, startedAtChanged},
        };
      }
      return {
        state: 'succeeded',
        verification: {executed: true, exitCode: 0, active: true, pidChanged, startedAtChanged},
      };
    },
  }),
});

export function getTemplate(name) {
  return Object.hasOwn(TEMPLATES, name) ? TEMPLATES[name] : null;
}

export function validateTemplateTarget(name, target) {
  const template = getTemplate(name);
  return Boolean(template && template.validateTarget(target));
}
