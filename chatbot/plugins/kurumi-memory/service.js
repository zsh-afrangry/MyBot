// Application mutation entry: explicit policy, exact replay, then revision-checked storage.
import {randomBytes} from 'node:crypto';
import {normalize, validateFact} from './model.js';
import {assertMemoryRequest} from './inbound.js';

/** @param {import('./contracts.js').Policy} policy */
export function createMemoryService(policy) {
  return function changeMemory(store, args, permit) {
    const key = JSON.stringify(args);
    if (permit?.result && permit.key === key) return permit.result;
    assertMemoryRequest(permit);
    const before = store.read(), entries = structuredClone(before.entries);
    let affected;
    if (args.action === 'upsert') {
      policy.authorize(args.action, permit);
      const text = validateFact(args.text);
      policy.checkText(text, permit);
      const existing = args.id ? entries.find(e => e.id === args.id) : entries.find(e => normalize(e.text) === normalize(text));
      policy.checkTarget(args, existing, permit);
      affected = {id: existing?.id ?? randomBytes(6).toString('hex'), text, updatedAt: new Date().toISOString(), source: 'owner_explicit'};
      if (existing) entries.splice(entries.indexOf(existing), 1, affected); else entries.push(affected);
    } else if (args.action === 'delete') {
      policy.authorize(args.action, permit);
      affected = entries.find(e => e.id === args.id);
      if (!affected) throw Error('记忆ID不存在');
      policy.checkTarget(args, affected, permit);
      entries.splice(entries.indexOf(affected), 1);
    } else throw Error('Unsupported memory change');
    const after = store.write({entries}, before.revision);
    permit.used = true;
    permit.key = key;
    permit.result = {ok: true, action: args.action, revision: after.revision, entry: affected};
    return permit.result;
  };
}
