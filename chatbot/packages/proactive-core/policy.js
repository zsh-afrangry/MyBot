// N3 development foundation only. The composition root supplies trusted policy,
// actual host session identity and domain adapters; no production tools are granted.
import {createHash} from 'node:crypto';

export const error = code => Object.assign(new Error(code), {code});
export const digest = value => createHash('sha256').update(value).digest('hex');
export const time = value => {
  if (!Number.isSafeInteger(value) || value < 0) throw error('invalid_time');
  return value;
};
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const forbidden = new Set(['read','write','edit','apply_patch','exec','process','message','sessions_spawn','sessions_history','tool_call','dispatch_action']);
export function binding(value) {
  if (!object(value) || value.enabled !== true || value.role !== 'owner'
    || !/^qq:user:[0-9]{5,12}$/.test(value.subjectKey ?? '')
    || !Number.isSafeInteger(value.policyRevision) || value.policyRevision < 1
    || !/^[a-z][a-z0-9-]{0,63}$/.test(value.agentId ?? '')
    || typeof value.sessionKey !== 'string' || !value.sessionKey.startsWith('agent:'+value.agentId+':')
    || typeof value.sessionId !== 'string' || !value.sessionId || value.sessionId.length > 160
    || !Number.isSafeInteger(value.generation) || value.generation < 0
    || typeof value.notifyEnabled !== 'boolean'
    || !Array.isArray(value.tools) || value.tools.length > 32
    || value.tools.some(n => typeof n !== 'string' || !/^[a-z][a-z0-9_]{0,79}$/.test(n) || forbidden.has(n))
    || new Set(value.tools).size !== value.tools.length) throw error('invalid_wake_binding');
  const route = value.route;
  if (!object(route) || route.channel !== 'kurumi-qq' || route.accountId !== 'default'
    || route.to !== 'user:'+value.subjectKey.slice('qq:user:'.length)) throw error('invalid_wake_route');
  const night = value.night;
  if (!object(night) || ![night.startMinute,night.endMinute].every(n => Number.isInteger(n) && n >= 0 && n < 1440)
    || night.startMinute === night.endMinute || typeof night.timeZone !== 'string'
    || !Number.isSafeInteger(night.activityMaxAgeMs) || night.activityMaxAgeMs < 1) throw error('invalid_night_policy');
  try {new Intl.DateTimeFormat('en-GB',{timeZone:night.timeZone}).format(0);} catch {throw error('invalid_night_policy');}
  // Pick fields explicitly. Unrecognized caller/model fields never become authority.
  return {enabled:true,role:'owner',subjectKey:value.subjectKey,policyRevision:value.policyRevision,
    agentId:value.agentId,sessionKey:value.sessionKey,sessionId:value.sessionId,generation:value.generation,
    notifyEnabled:value.notifyEnabled,tools:[...value.tools].sort(),
    route:{channel:route.channel,accountId:route.accountId,to:route.to},
    night:{startMinute:night.startMinute,endMinute:night.endMinute,timeZone:night.timeZone,activityMaxAgeMs:night.activityMaxAgeMs}};
}
export const fingerprint = value => digest(JSON.stringify(binding(value)));
export function assertContactTime(policy, now, lastActivityAt) {
  time(now);
  const parts = new Intl.DateTimeFormat('en-GB',{timeZone:policy.timeZone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now);
  const minutes = Number(parts.find(p => p.type === 'hour').value)*60 + Number(parts.find(p => p.type === 'minute').value);
  const night = policy.startMinute < policy.endMinute
    ? minutes >= policy.startMinute && minutes < policy.endMinute
    : minutes >= policy.startMinute || minutes < policy.endMinute;
  if (night && (!Number.isSafeInteger(lastActivityAt) || now < lastActivityAt || now-lastActivityAt > policy.activityMaxAgeMs)) throw error('night_activity_required');
}
export function decision(value) {
  if (!object(value) || !['silent','notify'].includes(value.kind)
    || Object.keys(value).some(k => !['kind','text'].includes(k))
    || (value.kind === 'silent' && value.text !== undefined)) throw error('invalid_wake_decision');
  if (value.kind === 'silent') return {kind:'silent'};
  if (typeof value.text !== 'string' || !value.text.trim() || value.text.trim().length > 2000
    || ['NO_REPLY','HEARTBEAT_OK'].includes(value.text.trim())) throw error('invalid_wake_decision');
  return {kind:'notify',text:value.text.trim()};
}
