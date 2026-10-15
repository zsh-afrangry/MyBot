import {createMemoryRegistry} from './adapters.js';
import {createMemoryService} from './service.js';

export function createMemoryApplication({policyAdapter = 'explicit', storeAdapter = 'memory-file', registry = createMemoryRegistry()} = {}) {
  const selected = registry.resolve({policy: policyAdapter, store: storeAdapter});
  const change = createMemoryService(selected.policy);
  return Object.freeze({...selected,
    read(workspace) {
      const store = selected.openStore({workspace});
      try {return store.read();} finally {store.close();}
    },
    changeMemory(workspace, args, request) {
      const store = selected.openStore({workspace});
      try {return change(store, args, request);} finally {store.close();}
    },
  });
}
export const changeMemory = createMemoryApplication().changeMemory;
