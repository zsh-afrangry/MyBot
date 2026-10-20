// Execution contracts: policies cannot switch off freshness or replay protection.
import {PERMIT_TTL_MS} from '../../packages/trusted-inbound/index.js';
export function assertCurrentRequest(request, now) {
  if (!request || !Number.isFinite(request.at) || now < request.at || now - request.at >= PERMIT_TTL_MS
    || typeof request.messageId !== 'string' || !request.messageId || typeof request.sessionKey !== 'string' || !request.sessionKey) throw Error('需要有效的本人当前请求');
}
export function listRequestKey(request) {return `${request.sessionKey}:${request.messageId}`;}
export function checkRequestReplay(previousHash, nextHash) {
  if (previousHash !== nextHash) throw Error('本次消息已经执行过一项维护，请用新消息提出下一项');
}
