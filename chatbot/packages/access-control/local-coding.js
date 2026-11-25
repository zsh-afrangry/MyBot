import {toolPermission} from './permissions.js';

export const LOCAL_CODING_AGENT = 'kurumi-acceptance';
export const LOCAL_CODING_PROJECT = 'kurumi-fusion';
export const LOCAL_CODING_TOOL = 'kurumi_code';
export const LOCAL_CODING_ACTIONS = Object.freeze(['list', 'start', 'status', 'result', 'diff', 'preview', 'cancel']);

export function validLocalCodingEnrollment(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => ['id', 'backend', 'expiresAt'].includes(key))
    && typeof value.id === 'string' && /^[a-z][a-z0-9-]{0,39}$/u.test(value.id)
    && typeof value.backend === 'string' && /^[a-z][a-z0-9-]{0,39}$/u.test(value.backend)
    && typeof value.expiresAt === 'string' && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/u.test(value.expiresAt)
    && Number.isFinite(Date.parse(value.expiresAt));
}

export function localCodingPermission(name, args) {
  if (name !== LOCAL_CODING_TOOL || !LOCAL_CODING_ACTIONS.includes(args?.action)) return undefined;
  return toolPermission(name, args);
}
