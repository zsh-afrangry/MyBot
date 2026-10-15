import {resolve} from 'node:path';
import {createListRegistry} from './adapters.js';
import {createListService} from './service.js';

export function stateRoot(env = process.env) {
  if (!env.OPENCLAW_STATE_DIR?.trim()) throw Error('OPENCLAW_STATE_DIR 必须显式配置');
  return resolve(env.OPENCLAW_STATE_DIR);
}

export function createListApplication({policyAdapter = 'default', storeAdapter = 'sqlite', registry = createListRegistry()} = {}) {
  const selected = registry.resolve({policy: policyAdapter, store: storeAdapter});
  return Object.freeze({...selected, manageList: createListService(selected.policy)});
}

// Explicit default composition for offline domain callers, not a second service.
export const manageList = createListApplication().manageList;
