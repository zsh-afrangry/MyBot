// Offline registry contract tests. No runtime paths, external API or messages.
import {test} from 'node:test';
import assert from 'node:assert/strict';
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
