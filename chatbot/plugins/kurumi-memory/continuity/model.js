// Document 25 P2. Bounded personal memory; facts and model summaries stay distinct.
import {createHash} from 'node:crypto';
import {validateFact, normalize, CREDENTIAL_PATTERN} from '../model.js';
export const STATE_RELATIVE = '.kurumi-memory/state.sqlite';
export const MEMORY_NOTICE = '# 个人记忆\n\n<!-- KURUMI_MEMORY_CONTINUITY_V2 -->\n长期事实及有限期近期摘要由 kurumi_memory 管理，唯一事实保存在 .kurumi-memory/state.sqlite。\n本文件不保存正文；仅本人授权回合可通过工具和受限上下文读取。原聊天与备份另行保留。\n';
export const digest = value => createHash('sha256').update(String(value)).digest('hex');
export const factDigest = text => digest(normalize(text));
export const canonical = value => JSON.stringify((function sort(item) {
  if (Array.isArray(item)) return item.map(sort);
  if (item && typeof item === 'object') return Object.fromEntries(Object.keys(item).sort().filter(k => item[k] !== undefined).map(k => [k, sort(item[k])]));
  return item;
})(value));
export const limits = Object.freeze({facts: 128, summaries: 32, receipts: 256, barriers: 256});
const id = /^[a-f0-9]{12}$/, hash = /^[a-f0-9]{64}$/;
const date = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value));
const exactKeys = (value, names) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => names.includes(key));
export function options(value = {}) {
  const result = {summaryTtlDays: 7, maxContextChars: 6000, ...value};
  if (!exactKeys(result, ['enabled','summaryTtlDays','maxContextChars'])
    || !Number.isInteger(result.summaryTtlDays) || result.summaryTtlDays < 1 || result.summaryTtlDays > 30
    || !Number.isInteger(result.maxContextChars) || result.maxContextChars < 2000 || result.maxContextChars > 12000) throw Error('Invalid personal memory configuration');
  return result;
}
export function safeText(value, max = 300) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\r\n\0]/u.test(value)) throw Error('记忆文字或来源长度不合法');
  const trimmed = value.trim();
  // Scan the complete value before chunking. Chunk-only validation could miss
  // a credential marker split at a 300-character boundary.
  if (CREDENTIAL_PATTERN.test(trimmed)) throw Error('不将凭证保存为长期记忆');
  // Reuse the fact format checks for summaries/evidence longer than 300 chars.
  for (let at = 0; at < trimmed.length; at += 200) validateFact(trimmed.slice(at, at + 300));
  return trimmed;
}
export function emptyState(ownerId, revision = 0) {
  return {version: 2, ownerId, revision, generation: 0, facts: [], summaries: [], barriers: [], receipts: [], importedFrom: null};
}
export function validateState(data, ownerId) {
  const invalid = () => {throw Error('Invalid personal memory state');};
  if (!exactKeys(data, ['version','ownerId','revision','generation','facts','summaries','barriers','receipts','importedFrom'])
    || data.version !== 2 || !/^\d{5,12}$/.test(data.ownerId) || (ownerId && data.ownerId !== ownerId)
    || !Number.isSafeInteger(data.revision) || data.revision < 0 || !Number.isSafeInteger(data.generation) || data.generation < 0) invalid();
  for (const [key, maximum] of Object.entries(limits)) if (!Array.isArray(data[key]) || data[key].length > maximum) invalid();
  const seen = new Set();
  for (const [kind, entries] of [['fact', data.facts], ['summary', data.summaries]]) for (const entry of entries) {
    if (!exactKeys(entry, ['id','text','kind','createdAt','updatedAt','expiresAt','source']) || !id.test(entry.id) || seen.has(entry.id)
      || !date(entry.createdAt) || !date(entry.updatedAt)) invalid();
    seen.add(entry.id); safeText(entry.text, kind === 'fact' ? 300 : 600);
    if (kind === 'fact' ? !['fact','preference'].includes(entry.kind) || entry.expiresAt !== undefined
      : entry.kind !== 'interaction_summary' || !date(entry.expiresAt) || Date.parse(entry.expiresAt) <= Date.parse(entry.createdAt)) invalid();
    const source = entry.source;
    if (!exactKeys(source, ['origin','messageId','sessionKey','sessionId','runId','at','rawHash','evidence'])
      || !['current_owner','legacy_explicit'].includes(source?.origin) || !hash.test(source.rawHash)
      || source.sessionKey !== `agent:main:kurumi-qq:direct:${data.ownerId}` || !date(source.at)
      || ['messageId','sessionId','runId'].some(k => typeof source[k] !== 'string' || !source[k] || source[k].length > 128)) invalid();
    safeText(source.evidence);
  }
  for (const barrier of data.barriers) if (!exactKeys(barrier, ['hash','at']) || !hash.test(barrier.hash) || !date(barrier.at)) invalid();
  for (const receipt of data.receipts) if (!exactKeys(receipt, ['messageId','rawHash','argsHash','generation','at','result'])
    || typeof receipt.messageId !== 'string' || receipt.messageId.length > 128 || !hash.test(receipt.rawHash) || !hash.test(receipt.argsHash)
    || !date(receipt.at) || !Number.isSafeInteger(receipt.generation) || receipt.generation < 0
    || !exactKeys(receipt.result, ['ok','action','revision','ids','summarySaved','suppressed']) || receipt.result.ok !== true
    || !['observe','upsert','delete'].includes(receipt.result.action) || !Number.isSafeInteger(receipt.result.revision)
    || !Array.isArray(receipt.result.ids) || receipt.result.ids.some(value => !id.test(value))
    || typeof receipt.result.summarySaved !== 'boolean' || typeof receipt.result.suppressed !== 'boolean') invalid();
  if (data.importedFrom !== null && (!exactKeys(data.importedFrom, ['sha256','revision','entries']) || !hash.test(data.importedFrom.sha256)
    || !Number.isSafeInteger(data.importedFrom.revision) || data.importedFrom.revision < 0
    || !Number.isInteger(data.importedFrom.entries) || data.importedFrom.entries < 0 || data.importedFrom.entries > 64)) invalid();
  return data;
}
