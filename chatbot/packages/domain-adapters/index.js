// Explicit composition-local registries. No global lifecycle or storage fallback.
function identifier(value) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(value)) throw Error('Invalid adapter identity');
  return value;
}
function methods(value, names, label) {
  if (!value || names.some(name => typeof value[name] !== 'function' || value[name].constructor?.name === 'AsyncFunction')) throw Error(`Invalid synchronous ${label} contract`);
  return value;
}
function isThenable(value) {return value != null && typeof value.then === 'function';}
function synchronousMethods(value, names, label) {
  methods(value, names, label);
  return Object.freeze(Object.fromEntries(names.map(name => {
    const method = value[name].bind(value);
    return [name, (...args) => {
      const result = method(...args);
      if (isThenable(result)) {
        Promise.resolve(result).catch(() => {});
        throw Error(`Async ${label}.${name} is unsupported`);
      }
      return result;
    }];
  })));
}
function closeInvalidStore(store) {
  try {Promise.resolve(store?.close?.()).catch(() => {});} catch {}
}
function synchronousStore(store, names, label) {
  const selected = synchronousMethods(store, names, label);
  // A separate facade also supports frozen adapters. Bind to the original
  // receiver for private fields; forward properties such as SQLite's .db.
  const facade = Object.freeze(Object.create(Object.getPrototypeOf(store), Object.getOwnPropertyDescriptors(selected)));
  return new Proxy(facade, {get(target, key, receiver) {
    if (Object.hasOwn(target, key)) return Reflect.get(target, key, receiver);
    const value = Reflect.get(store, key, store);
    return typeof value === 'function' && key !== 'constructor' ? value.bind(store) : value;
  }});
}

export function createAdapterRegistry({domain, policyMethods, storeMethods}) {
  identifier(domain);
  policyMethods = [...policyMethods]; storeMethods = [...storeMethods];
  const policies = new Map(), stores = new Map();
  function register(map, id, value) {
    identifier(id);
    if (map.has(id)) throw Error(`Duplicate ${domain} adapter: ${id}`);
    const registration = {value};
    map.set(id, registration);
    return () => {if (map.get(id) === registration) map.delete(id);};
  }
  return Object.freeze({
    registerPolicy(id, policy) {
      // A resolved application owns a fixed method table even after unregister.
      const selected = synchronousMethods(policy, policyMethods, `${domain} policy`);
      return register(policies, id, selected);
    },
    registerStore(id, open) {
      if (typeof open !== 'function') throw Error(`Invalid ${domain} store factory`);
      return register(stores, id, open);
    },
    ids() {return {policies: [...policies.keys()].sort(), stores: [...stores.keys()].sort()};},
    resolve({policy: policyId, store: storeId}) {
      const policy = policies.get(policyId)?.value, open = stores.get(storeId)?.value;
      if (!policy || !open) throw Error(`Unavailable ${domain} adapter selection`);
      return Object.freeze({policy, policyId, storeId,
        openStore(options) {
          const store = open(options);
          try {
            if (isThenable(store)) {
              Promise.resolve(store).then(closeInvalidStore).catch(() => {});
              throw Error(`Async ${domain} stores are unsupported`);
            }
            return synchronousStore(store, storeMethods, `${domain} store`);
          } catch (error) {closeInvalidStore(store); throw error;}
        },
      });
    },
  });
}
