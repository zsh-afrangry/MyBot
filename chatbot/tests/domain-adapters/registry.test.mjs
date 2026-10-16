// Offline registry contract tests. No runtime paths, external API or messages.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {createAdapterRegistry} from '../../packages/domain-adapters/index.js';
const registry = () => createAdapterRegistry({domain: 'test', policyMethods: ['check'], storeMethods: ['read', 'close']});

test('registration validates contracts and identities; duplicate IDs are rejected separately per kind', () => {
  const r = registry();
  assert.throws(() => r.registerPolicy('../path', {check() {}}));
  assert.throws(() => r.registerPolicy('bad', {}), /contract/);
  assert.throws(() => r.registerPolicy('async-policy', {async check() {}}), /synchronous/);
  assert.throws(() => r.registerStore('bad', {}), /factory/);
  r.registerPolicy('same', {check() {}}); r.registerStore('same', () => ({read() {}, close() {}}));
  assert.throws(() => r.registerPolicy('same', {check() {}}), /Duplicate/);
  assert.throws(() => r.registerStore('same', () => ({})), /Duplicate/);
  assert.deepEqual(r.ids(), {policies: ['same'], stores: ['same']});
});
test('resolved selections remain fixed; old unregister handles cannot remove a later replacement', () => {
  const r = registry(), p = {check: () => 'first'};
  const off = r.registerPolicy('policy', p);
  const offStore = r.registerStore('store', () => ({read: () => 'value', close() {}}));
  const first = r.resolve({policy: 'policy', store: 'store'});
  p.check = () => 'mutated'; assert.equal(first.policy.check(), 'first');
  off(); assert.throws(() => r.resolve({policy: 'policy', store: 'store'}), /Unavailable/);
  r.registerPolicy('policy', {check: () => 'second'}); off();
  assert.equal(r.resolve({policy: 'policy', store: 'store'}).policy.check(), 'second');
  assert.equal(first.policy.check(), 'first'); offStore();
  assert.equal(first.openStore().read(), 'value');
});
test('missing, failing and malformed stores never fall back; malformed resources close', () => {
  const r = registry(); let closed = 0;
  r.registerPolicy('policy', {check() {}});
  assert.throws(() => r.resolve({policy: 'policy', store: 'missing'}), /Unavailable/);
  r.registerStore('broken', () => {throw Error('open failed');});
  assert.throws(() => r.resolve({policy: 'policy', store: 'broken'}).openStore(), /open failed/);
  r.registerStore('malformed', () => ({close() {closed++;}}));
  assert.throws(() => r.resolve({policy: 'policy', store: 'malformed'}).openStore(), /contract/);
  assert.equal(closed, 1);
  r.registerPolicy('promise-policy', {check: () => Promise.resolve()});
  assert.throws(() => r.resolve({policy: 'promise-policy', store: 'broken'}).policy.check(), /Async/);
  r.registerStore('async', () => Promise.resolve({}));
  assert.throws(() => r.resolve({policy: 'policy', store: 'async'}).openStore(), /Async/);
});
test('registries do not share selections between applications or plugin captures', () => {
  const a = registry(), b = registry();
  a.registerPolicy('only-a', {check() {}});
  assert.deepEqual(b.ids(), {policies: [], stores: []});
});

test('a stale unregister handle cannot remove the same store factory registered again', () => {
  const r = registry(), open = () => ({read: () => 'value', close() {}});
  r.registerPolicy('policy', {check() {}});
  const firstOff = r.registerStore('store', open);
  const first = r.resolve({policy: 'policy', store: 'store'});
  firstOff();
  const secondOff = r.registerStore('store', open);
  firstOff();
  assert.deepEqual(r.ids().stores, ['store']);
  assert.equal(r.resolve({policy: 'policy', store: 'store'}).openStore().read(), 'value');
  secondOff(); secondOff();
  assert.deepEqual(r.ids().stores, []);
  assert.equal(first.openStore().read(), 'value');
});

test('ordinary store reads, writes, transactions and close reject Promise/thenable results', async t => {
  const results = {
    fulfilled: () => Promise.resolve('value'),
    rejected: () => Promise.reject(Error('rejected adapter result')),
    thenable: () => ({then(resolve) {resolve('value');}}),
  };
  for (const name of ['read', 'write', 'transaction', 'close']) {
    for (const [kind, result] of Object.entries(results)) {
      await t.test(`${name}: ${kind}`, () => {
        const r = createAdapterRegistry({domain: 'test', policyMethods: ['check'], storeMethods: ['read', 'write', 'transaction', 'close']});
        r.registerPolicy('policy', {check() {}});
        r.registerStore('store', () => ({read() {}, write() {}, transaction() {}, close() {}, [name]: result}));
        const store = r.resolve({policy: 'policy', store: 'store'}).openStore();
        assert.throws(() => store[name](), new RegExp(`Async test store\\.${name}`));
      });
    }
  }
  // node:test also fails on an unhandled rejection after synchronous rejection.
  await nextTurn();
});

test('frozen class stores retain private receivers, getters and extra resource access', () => {
  class Store {
    #value = 1;
    db = {kind: 'resource'};
    get revision() {return this.#value;}
    read() {return this.#value;}
    write(value) {this.#value = value; return value;}
    close() {this.#value = 0;}
  }
  const raw = Object.freeze(new Store());
  const r = createAdapterRegistry({domain: 'test', policyMethods: ['check'], storeMethods: ['read', 'write', 'close']});
  r.registerPolicy('policy', {check() {}}); r.registerStore('store', () => raw);
  const store = r.resolve({policy: 'policy', store: 'store'}).openStore();
  assert.ok(store instanceof Store);
  assert.equal(store.db, raw.db);
  const read = store.read;
  assert.equal(read(), 1);
  assert.equal(store.write(2), 2);
  assert.equal(store.revision, 2);
  store.close(); assert.equal(store.read(), 0);
});

test('an opened store fixes contract methods without mutating the adapter object', () => {
  const r = registry(), raw = {read: () => 'first', close() {}};
  r.registerPolicy('policy', {check() {}}); r.registerStore('store', () => raw);
  const first = r.resolve({policy: 'policy', store: 'store'}).openStore();
  assert.notEqual(first.read, raw.read);
  raw.read = () => Promise.resolve('replacement');
  assert.equal(first.read(), 'first');
  assert.throws(() => r.resolve({policy: 'policy', store: 'store'}).openStore().read(), /Async/);
});

test('only callable then properties denote asynchronous results', () => {
  const r = registry(), data = {then: 'metadata', value: 1};
  r.registerPolicy('policy', {check: () => data});
  r.registerStore('store', () => ({then: 'metadata', read: () => data, close() {}}));
  const selected = r.resolve({policy: 'policy', store: 'store'});
  assert.equal(selected.policy.check(), data);
  assert.equal(selected.openStore().read(), data);
});

test('invalid native-async stores and late async factories close without leaking rejections', async () => {
  const r = registry(); let closes = 0;
  r.registerPolicy('policy', {check() {}});
  r.registerStore('native-async', () => ({async read() {}, close() {closes++; return Promise.reject(Error('close failed'));}}));
  assert.throws(() => r.resolve({policy: 'policy', store: 'native-async'}).openStore(), /synchronous/);
  r.registerStore('late', () => Promise.resolve({close() {closes++; return Promise.reject(Error('late close failed'));}}));
  assert.throws(() => r.resolve({policy: 'policy', store: 'late'}).openStore(), /Async/);
  r.registerStore('rejected', () => Promise.reject(Error('open failed')));
  assert.throws(() => r.resolve({policy: 'policy', store: 'rejected'}).openStore(), /Async/);
  await nextTurn(); assert.equal(closes, 2);
});
