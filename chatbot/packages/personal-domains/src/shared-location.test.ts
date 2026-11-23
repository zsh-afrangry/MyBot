import {createHmac} from 'node:crypto';
import {once} from 'node:events';
import {chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {scopeFromToolContext} from '@kurumi/confirmation-core';
import {afterEach, describe, expect, it} from 'vitest';
import {createProfileCatalog} from './profile-catalog.js';
import {commitProfileChange, proposeProfileChange} from './profile.js';
import {createSharedLocationHandler, SHARED_LOCATION_PATH} from './shared-location.js';
import {WeatherStore} from './store.js';

const token = 'shared-location-test-' + 'x'.repeat(40);
const key = createHmac('sha256', token).update('kurumi:shared-default-city:v1').digest('hex');
const roots: string[] = [];
const scope = scopeFromToolContext({messageChannel: 'qqbot', senderIsOwner: true,
  deliveryContext: {to: 'qqbot:c2c:test-owner', accountId: 'default'}})!;

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true}); });

describe('shared owner location', () => {
  it('serves only a confirmed location to the scoped local credential, without writing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shared-location-')); roots.push(root);
    const tokenFile = join(root, 'token'); writeFileSync(tokenFile, token, {mode: 0o600});
    const stateDirectory = join(root, 'weather');
    const store = new WeatherStore({stateDirectory});
    const handler = createSharedLocationHandler({stateDirectory, tokenFile});
    const server = createServer((request, response) => {handler(request, response);});
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing port');
    const url = `http://127.0.0.1:${address.port}${SHARED_LOCATION_PATH}`;
    const get = (authorization?: string) => fetch(url, {headers: authorization ? {authorization} : {}});
    try {
      expect((await get()).status).toBe(401);
      expect((await get(`Bearer ${token}`)).status).toBe(401);
      expect((await fetch(url, {method: 'POST', headers: {authorization: `Bearer ${key}`}})).status).toBe(405);
      expect((await fetch(url + '?anything=1', {headers: {authorization: `Bearer ${key}`}})).status).toBe(404);
      const before = store.getCurrentLocation();
      const initial = await get(`Bearer ${key}`);
      expect(initial.status).toBe(200);
      expect(initial.headers.get('cache-control')).toBe('no-store');
      expect(await initial.json()).toMatchObject({ok: true, location: '101280109', revision: before.revision});
      expect(store.getCurrentLocation()).toEqual(before);

      const resolve = createProfileCatalog([{id:'test-campus', name:'测试校区', countryCode:'CN',
        latitude:35.1234, longitude:114.5678, timezone:'Asia/Shanghai', precision:'point'}]);
      const pending = await proposeProfileChange(store, resolve, {schema_version:1,
        request:{kind:'current_location.set', location:{text:'测试校区'}}}, undefined, scope);
      if (!pending.ok || pending.status !== 'pending') throw Error('Expected pending proposal');
      expect((await (await get(`Bearer ${key}`)).json()).location).toBe('101280109');
      expect(store.recordInboundConfirmation({channel:'qqbot', conversationId:'qqbot:c2c:test-owner', accountId:'default',
        senderIsOwner:true, isGroup:false, messageId:'shared-city-confirm', content:`确认 ${pending.proposalId} ${pending.payloadHash}`})).toBe(true);
      expect(commitProfileChange(store, {proposal_id:pending.proposalId, payload_hash:pending.payloadHash}, scope).ok).toBe(true);
      expect(await (await get(`Bearer ${key}`)).json()).toMatchObject({ok:true, location:'114.57,35.12', displayName:'测试校区', revision:before.revision + 1});

      const database = new DatabaseSync(store.databasePath);
      database.prepare("UPDATE profile_current_location SET source_kind = 'operator' WHERE subject_id = 'owner'").run();
      database.close();
      expect((await get(`Bearer ${key}`)).status).toBe(503);

      chmodSync(tokenFile, 0o644);
      expect((await get(`Bearer ${key}`)).status).toBe(503);
    } finally {
      store.close();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it('never creates a database while serving a missing location', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shared-location-empty-')); roots.push(root);
    const tokenFile = join(root, 'token'); writeFileSync(tokenFile, token, {mode: 0o600});
    const stateDirectory = join(root, 'does-not-exist');
    const handler = createSharedLocationHandler({stateDirectory, tokenFile});
    const server = createServer((request, response) => {handler(request, response);});
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing port');
    try {
      const result = await fetch(`http://127.0.0.1:${address.port}${SHARED_LOCATION_PATH}`, {headers:{authorization:`Bearer ${key}`}});
      expect(result.status).toBe(503);
      expect(existsSync(stateDirectory)).toBe(false);
    } finally {await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));}
  });

  it('fails promptly when the Profile database is locked', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shared-location-locked-')); roots.push(root);
    const tokenFile = join(root, 'token'); writeFileSync(tokenFile, token, {mode: 0o600});
    const stateDirectory = join(root, 'weather');
    const store = new WeatherStore({stateDirectory});
    const databasePath = store.databasePath; store.close();
    const lock = new DatabaseSync(databasePath);
    lock.exec('PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE');
    const handler = createSharedLocationHandler({stateDirectory, tokenFile});
    const server = createServer((request, response) => {handler(request, response);});
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing port');
    try {
      const start = performance.now();
      const response = await fetch(`http://127.0.0.1:${address.port}${SHARED_LOCATION_PATH}`, {headers:{authorization:`Bearer ${key}`}});
      expect(response.status).toBe(503);
      expect(performance.now() - start).toBeLessThan(1500);
    } finally {
      lock.exec('ROLLBACK'); lock.close();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});
