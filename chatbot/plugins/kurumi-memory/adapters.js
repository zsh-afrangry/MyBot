import {createAdapterRegistry} from '../../packages/domain-adapters/index.js';
import {defaultMemoryPolicy} from './policy.js';
import {readMemory, writeMemory} from './store.js';

/** @returns {import('../../packages/domain-adapters/index.js').AdapterRegistry<import('./contracts.js').Policy, import('./contracts.js').Store, import('./contracts.js').StoreOptions>} */
export function createMemoryRegistry() {
  const registry = createAdapterRegistry({domain: 'memory',
    policyMethods: ['intent', 'authorize', 'checkText', 'checkTarget'], storeMethods: ['read', 'write', 'close']});
  registry.registerPolicy('explicit', defaultMemoryPolicy);
  registry.registerStore('memory-file', ({workspace}) => ({
    read: () => readMemory(workspace), write: (data, revision) => writeMemory(workspace, data, revision), close() {},
  }));
  return registry;
}
