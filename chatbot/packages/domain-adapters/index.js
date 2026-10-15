// Explicit composition-local registries. No global lifecycle or storage fallback.
function identifier(value) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(value)) throw Error('Invalid adapter identity');
  return value;
}
function methods(value, names, label) {
  if (!value || names.some(name => typeof value[name] !== 'function' || value[name].constructor?.name === 'AsyncFunction')) throw Error(`Invalid synchronous ${label} contract`);
  return value;
}

export function createAdapterRegistry({domain, policyMethods, storeMethods}) {
  identifier(domain);
  policyMethods = [...policyMethods]; storeMethods = [...storeMethods];
  const policies = new Map(), stores = new Map();
  function register(map, id, value) {
    identifier(id);
    if (map.has(id)) throw Error(`Duplicate ${domain} adapter: ${id}`);
    map.set(id, value);
    return () => {if (map.get(id) === value) map.delete(id);};
  }
  return Object.freeze({
    registerPolicy(id, policy) {
      methods(policy, policyMethods, `${domain} policy`);
      // A resolved application owns a fixed method table even after unregister.
      const selected = Object.freeze(Object.fromEntries(policyMethods.map(name => {
        const method = policy[name].bind(policy);
        return [name, (...args) => {
          const result = method(...args);
          if (result?.then) {Promise.resolve(result).catch(() => {}); throw Error(`Async ${domain} policies are unsupported`);}
          return result;
        }];
      })));
      return register(policies, id, selected);
    },
    registerStore(id, open) {
      if (typeof open !== 'function') throw Error(`Invalid ${domain} store factory`);
      return register(stores, id, open);
    },
    ids() {return {policies: [...policies.keys()].sort(), stores: [...stores.keys()].sort()};},
    resolve({policy: policyId, store: storeId}) {
      const policy = policies.get(policyId), open = stores.get(storeId);
      if (!policy || !open) throw Error(`Unavailable ${domain} adapter selection`);
      return Object.freeze({policy, policyId, storeId,
        openStore(options) {
          const store = open(options);
          try {
            if (store?.then) {
              Promise.resolve(store).then(value => value?.close?.()).catch(() => {});
              throw Error(`Async ${domain} stores are unsupported`);
            }
            return methods(store, storeMethods, `${domain} store`);
          } catch (error) {try {store?.close?.();} catch {} throw error;}
        },
      });
    },
  });
}
