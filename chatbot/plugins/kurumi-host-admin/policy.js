import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const DOMAIN = 'host_sudo';
export const TOOL = 'kurumi_host_admin';
export const DEFAULT_SUDO_COMMAND = '/usr/bin/sudo';
export const DEFAULT_SYSTEMCTL_COMMAND = '/usr/bin/systemctl';
export const DEFAULT_TIMEOUT_MS = 15000;
export const DEFAULT_PROPOSAL_TTL_SECONDS = 1800;

export const proposalIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
export const actionIdPattern = /^[a-z][a-z0-9_.-]{0,63}$/u;
export const serviceTargetPattern = /^[a-zA-Z0-9@_.-]{1,128}\.service$/u;

export const sha256 = value => createHash('sha256').update(value).digest('hex');

export class HostAdminError extends Error {
  constructor(code = 'host_admin_failed') {
    super(code);
    this.code = code;
  }
}

export function fail(code) {
  throw new HostAdminError(code);
}

export function assertFields(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !keys.includes(key))) {
    fail('invalid_host_admin_arguments');
  }
}

function validateTextField(value, maxLength, code) {
  if (typeof value !== 'string') fail(code);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength || /[\x00-\x1f\x7f]/u.test(trimmed)) fail(code);
  return trimmed;
}

export function validateExecutablePath(file, code, verifyOnDisk = true) {
  if (typeof file !== 'string' || !file || !path.isAbsolute(file) || path.resolve(file) !== file
    || /[\x00-\x1f\x7f]/u.test(file)) {
    fail(code);
  }
  if (verifyOnDisk) {
    try {
      if (!fs.statSync(file).isFile()) fail(code);
      fs.accessSync(file, fs.constants.X_OK);
    } catch (error) {
      if (error instanceof HostAdminError) throw error;
      fail(code);
    }
  }
  return file;
}

export function validateHostAdminConfig(config, validateTemplateTarget, {verifyExecutables = true} = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) fail('invalid_host_admin_config');
  const allowedTop = ['sudoCommand', 'systemctlCommand', 'timeoutMs', 'proposalTtlSeconds', 'actions'];
  if (Object.keys(config).some(key => !allowedTop.includes(key))) fail('invalid_host_admin_config');

  const sudoCommand = validateExecutablePath(
    config.sudoCommand ?? DEFAULT_SUDO_COMMAND, 'invalid_host_admin_command', verifyExecutables);
  const systemctlCommand = validateExecutablePath(
    config.systemctlCommand ?? DEFAULT_SYSTEMCTL_COMMAND, 'invalid_host_admin_command', verifyExecutables);

  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) fail('invalid_host_admin_config');

  const proposalTtlSeconds = config.proposalTtlSeconds ?? DEFAULT_PROPOSAL_TTL_SECONDS;
  if (!Number.isSafeInteger(proposalTtlSeconds) || proposalTtlSeconds < 60 || proposalTtlSeconds > 86400) {
    fail('invalid_host_admin_config');
  }

  if (!Array.isArray(config.actions) || config.actions.length === 0 || config.actions.length > 32) {
    fail('invalid_host_admin_actions');
  }

  const actions = [];
  const byId = new Map();
  const allowedItem = ['id', 'template', 'target', 'label', 'impact', 'leaseEligible'];

  for (const raw of config.actions) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)
      || Object.keys(raw).some(key => !allowedItem.includes(key))) {
      fail('invalid_host_admin_actions');
    }
    if (typeof raw.id !== 'string' || !actionIdPattern.test(raw.id) || byId.has(raw.id)) {
      fail('invalid_host_admin_actions');
    }
    if (typeof raw.template !== 'string' || !validateTemplateTarget(raw.template, raw.target)) {
      fail('invalid_host_admin_actions');
    }
    if (raw.leaseEligible !== undefined && typeof raw.leaseEligible !== 'boolean') {
      fail('invalid_host_admin_actions');
    }
    const action = Object.freeze({
      id: raw.id,
      template: raw.template,
      target: raw.target,
      label: validateTextField(raw.label, 80, 'invalid_host_admin_actions'),
      impact: validateTextField(raw.impact, 200, 'invalid_host_admin_actions'),
      leaseEligible: raw.leaseEligible === true,
    });
    actions.push(action);
    byId.set(action.id, action);
  }

  return Object.freeze({sudoCommand, systemctlCommand, timeoutMs, proposalTtlSeconds, actions: Object.freeze(actions), byId});
}

export function parseSystemctlShow(stdout) {
  const fields = {};
  const allowed = new Set(['LoadState', 'ActiveState', 'SubState', 'MainPID', 'ExecMainStartTimestamp', 'UnitFileState']);
  for (const line of String(stdout ?? '').split(/\r?\n/u)) {
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    if (allowed.has(key)) fields[key] = line.slice(idx + 1).trim();
  }
  return fields;
}

export function formatServiceState(state) {
  if (!state || state.available !== true) return '当前状态无法读取（提交后会再次核对）';
  const active = state.ActiveState || 'unknown';
  const sub = state.SubState ? `（${state.SubState}）` : '';
  const pid = state.MainPID && state.MainPID !== '0' ? `，PID ${state.MainPID}` : '';
  if (active === 'active') return `运行中${sub}${pid}`;
  if (active === 'inactive') return `未运行${sub}`;
  if (active === 'failed') return `异常退出${sub}`;
  return `${active}${sub}${pid}`;
}

export function buildActionPreview(action, beforeState) {
  const lines = [
    '受控系统操作待确认',
    `操作：${action.label}（${action.target}）`,
    `当前状态：${formatServiceState(beforeState)}`,
    `影响提示：${action.impact}`,
    '执行范围：仅执行本次已登记动作，不开放其他提权命令。',
  ];
  return {previewText: lines.join('\n'), presentationFacts: lines};
}
