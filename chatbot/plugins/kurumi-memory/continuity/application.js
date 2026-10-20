// Document 25 P2. Composition-local synchronous adapters and atomic memory commands.
import {randomBytes} from 'node:crypto';
import {createAdapterRegistry} from '../../../packages/domain-adapters/index.js';
import {normalize} from '../model.js';
import {continuityPolicy} from './policy.js';
import {openContinuityStore} from './store.js';
import {digest, factDigest, canonical, limits, options, validateState} from './model.js';
import {assertContinuityArgs} from './tool-contract.js';
export function createContinuityRegistry() {
  const registry = createAdapterRegistry({domain: 'memory-continuity', policyMethods: ['evidence','fact','summary'], storeMethods: ['read','write','close']});
  registry.registerPolicy('current-owner', continuityPolicy); registry.registerStore('sqlite', openContinuityStore);
  return registry;
}
export function createContinuityApplication({registry = createContinuityRegistry(), policyAdapter = 'current-owner', storeAdapter = 'sqlite', config = {}, now = Date.now} = {}) {
  const selected = registry.resolve({policy: policyAdapter, store: storeAdapter}), cfg = options(config);
  const use = (location, action) => {const store = selected.openStore(location); try {return action(store);} finally {store.close();}};
  const source = (request, evidence) => ({origin: 'current_owner', messageId: request.messageId, sessionKey: request.sessionKey,
    sessionId: request.sessionId, runId: request.runId, at: new Date(request.at).toISOString(), rawHash: digest(request.raw), evidence});
  function change(store, args, request) {
    assertContinuityArgs(args);
    const at = now();
    if (!request || !/^\d{5,12}$/.test(request.ownerId) || typeof request.raw !== 'string' || !request.raw.trim() || request.raw.length > 2000
      || !request.messageId || !request.runId || !request.sessionId || !Number.isFinite(request.at)
      || at < request.at || at - request.at >= 300000 || request.sessionKey !== `agent:main:kurumi-qq:direct:${request.ownerId}`) throw Error('需要有效的本人当前记忆请求');
    const before = validateState(store.read(), request.ownerId), argsHash = digest(canonical(args)), rawHash = digest(request.raw);
    const previous = before.receipts.find(r => r.messageId === request.messageId);
    if (previous) {
      if (previous.rawHash !== rawHash || previous.argsHash !== argsHash || previous.generation !== before.generation) throw Error('该消息已有不同写入或已被遗忘边界作废');
      return {...previous.result, replayed: true};
    }
    if (request.generation !== before.generation) throw Error('记忆来源已因更正或遗忘失效');
    if (!Number.isSafeInteger(args.expectedRevision) || args.expectedRevision !== before.revision) throw Error('请先读取当前记忆revision，避免覆盖并发修改');
    const next = structuredClone(before), stamp = new Date(at).toISOString(), ids = [];
    next.summaries = next.summaries.filter(e => Date.parse(e.expiresAt) > at);
    let summarySaved = false, suppressed = false;
    const put = (item, explicit, target) => {
      const evidence = selected.policy.evidence(item.evidence ?? item.text, request), text = selected.policy.fact(item.text, evidence);
      const hashed = factDigest(text);
      if (!explicit && next.barriers.some(b => b.hash === hashed)) {suppressed = true; return;}
      if (!['fact','preference'].includes(item.kind ?? 'fact')) throw Error('未知事实类型');
      if (explicit) next.barriers = next.barriers.filter(b => b.hash !== hashed);
      const existing = target ?? next.facts.find(e => normalize(e.text) === normalize(text));
      const entry = {id: existing?.id ?? randomBytes(6).toString('hex'), text, kind: item.kind ?? existing?.kind ?? 'fact',
        createdAt: existing?.createdAt ?? stamp, updatedAt: stamp, source: source(request, evidence)};
      if (existing) next.facts.splice(next.facts.indexOf(existing), 1, entry); else next.facts.push(entry);
      ids.push(entry.id);
    };
    if (args.action === 'observe') {
      for (const fact of args.facts ?? []) put(fact, false);
      if (args.summary && !suppressed) {
        const evidence = selected.policy.evidence(args.summary.evidence, request), text = selected.policy.summary(args.summary.text);
        next.summaries.push({id: randomBytes(6).toString('hex'), text, kind: 'interaction_summary', createdAt: stamp, updatedAt: stamp,
          expiresAt: new Date(at + cfg.summaryTtlDays * 86400000).toISOString(), source: source(request, evidence)});
        next.summaries = next.summaries.slice(-limits.summaries); summarySaved = true;
      }
    } else if (['upsert','delete'].includes(args.action)) {
      const existing = args.id && next.facts.find(e => e.id === args.id);
      if (args.id && !existing) throw Error('记忆ID不存在，请先查询真实ID');
      if (args.action === 'delete' || (existing && normalize(existing.text) !== normalize(args.text))) {
        next.generation++; next.summaries = [];
        next.barriers = [...next.barriers.filter(b => b.hash !== factDigest(existing.text)), {hash: factDigest(existing.text), at: stamp}].slice(-limits.barriers);
      }
      if (args.action === 'delete') {next.facts.splice(next.facts.indexOf(existing), 1); ids.push(existing.id);}
      else put(args, true, existing);
    } else throw Error('未知记忆写入动作');
    if (next.facts.length > limits.facts) throw Error('长期记忆已满，请先合并或遗忘，不会静默淘汰');
    const result = {ok: true, action: args.action, revision: before.revision + 1, ids, summarySaved, suppressed};
    next.receipts.push({messageId: request.messageId, rawHash, argsHash, generation: next.generation, at: stamp, result});
    next.receipts = next.receipts.slice(-limits.receipts);
    store.write(validateState(next, request.ownerId), before.revision);
    return result;
  }
  function view(data, query = '', at = now()) {
    const q = normalize(query), facts = data.facts.filter(e => !q || normalize(e.text).includes(q));
    const summaries = data.summaries.filter(e => Date.parse(e.expiresAt) > at && (!q || normalize(e.text).includes(q)));
    return {ok: true, revision: data.revision, generation: data.generation, entries: facts, summaries,
      summaryTtlDays: cfg.summaryTtlDays, forgetting: '只处理有效记忆与本域摘要；原聊天和备份仍保留'};
  }
  return Object.freeze({...selected, config: cfg,
    read: location => use({...location, readonly: true}, store => view(validateState(store.read(), location.ownerId))),
    search: (location, query) => use({...location, readonly: true}, store => view(validateState(store.read(), location.ownerId), query)),
    change: (location, args, request) => use(location, store => change(store, args, request)),
    context(location, raw) {
      const data = this.read(location), terms = [...normalize(raw).matchAll(/[a-z0-9]{2,}|[\p{Script=Han}]{2}/gu)].map(m => m[0]);
      const score = text => terms.reduce((n, term) => n + Number(normalize(text).includes(term)), 0);
      const facts = [...data.entries].sort((a,b) => score(b.text) - score(a.text) || b.updatedAt.localeCompare(a.updatedAt));
      const result = {revision: data.revision, generation: data.generation, facts: [], recentSummaries: []};
      let used = JSON.stringify(result).length;
      for (const [target, entries] of [['facts', facts], ['recentSummaries', [...data.summaries].reverse()]]) for (const entry of entries) {
        const value = {id: entry.id, text: entry.text, kind: entry.kind, updatedAt: entry.updatedAt, ...(entry.expiresAt ? {expiresAt: entry.expiresAt} : {})};
        const size = JSON.stringify(value).length + 2;
        if (used + size > cfg.maxContextChars) continue;
        result[target].push(value); used += size;
      }
      return result;
    },
  });
}
