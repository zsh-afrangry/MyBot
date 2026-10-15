import {createAdapterRegistry} from '../../packages/domain-adapters/index.js';
import {defaultListPolicy} from './policy.js';
import {ListStore} from './store.js';

// Persistent composition root: register additional implementations HERE so the
// independently launched fixed runner and host can resolve the same store ID.
/** @returns {import('../../packages/domain-adapters/index.js').AdapterRegistry<import('./contracts.js').Policy, import('./contracts.js').Store, import('./contracts.js').StoreOptions>} */
export function createListRegistry() {
  const registry = createAdapterRegistry({domain: 'reminder-list',
    policyMethods: ['intent', 'hasListName', 'wantsContinuousEntry', 'isContinuationCandidate', 'isStandaloneReminder', 'authorize', 'checkText', 'checkFacts', 'checkSchedule'],
    storeMethods: ['now', 'close', 'transaction', 'expire', 'settings', 'get', 'select', 'request', 'recordRequest', 'changeSchedule', 'addItem', 'changeItem', 'claimDigest', 'observeDeliveries', 'markUnobserved'],
  });
  registry.registerPolicy('default', defaultListPolicy);
  registry.registerStore('sqlite', options => new ListStore(options));
  return registry;
}
