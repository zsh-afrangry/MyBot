import assert from 'node:assert/strict';
import {once} from 'node:events';
import {existsSync} from 'node:fs';
import {createServer} from 'node:http';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';
import {WebSocket, WebSocketServer} from 'ws';
import {scenarioSignal} from './scenario-lifecycle.mjs';

export async function waitForAcceptance(read, description, {timeoutMs = 15000, pollMs = 30, signal = scenarioSignal} = {}) {
  const deadline = performance.now() + timeoutMs;
  do {
    signal?.throwIfAborted();
    const value = await read();
    if (value) return value;
    if (performance.now() >= deadline) break;
    await delay(pollMs, undefined, {signal});
  } while (true);
  throw Error('Timed out waiting for ' + description);
}

export function textOfSend(entry) {
  return entry.message.filter(segment => segment.type === 'text').map(segment => segment.data.text).join('');
}

// Test-only peer. It accepts only its own loopback connection and identities.
export async function createOneBotPeer({token, botId, subjects, reply, methods = {}, maxSends = 200}) {
  const allowed = new Set(subjects.map(String));
  assert(typeof token === 'string' && token.length > 0 && /^[0-9]{5,12}$/.test(botId));
  assert(allowed.size > 0 && !allowed.has(String(botId)) && [...allowed].every(id => /^[0-9]{5,12}$/.test(id)));
  const authorized = req => req.headers.authorization === 'Bearer ' + token;
  const sends = [];
  let socket, fault, sequence = 100;
  const server = createServer(async (req, res) => {
    if (!authorized(req)) {res.writeHead(401).end(); return;}
    try {
      assert.equal(req.method, 'POST');
      const method = req.url.slice(1);
      const custom = Object.hasOwn(methods, method) ? methods[method] : undefined;
      if (!['get_login_info', 'send_private_msg'].includes(method) && !custom) {res.writeHead(404).end(); return;}
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        assert(raw.length <= 16 * 1024 * 1024, 'Fixture payload exceeds its bound');
      }
      const args = JSON.parse(raw);
      let data = {user_id: Number(botId)};
      if (method === 'send_private_msg') {
        assert(allowed.has(String(args.user_id)), 'Send targeted an unregistered fixture subject');
        assert(Array.isArray(args.message) && args.message.length > 0, 'Expected OneBot segments');
        assert(sends.length < maxSends, 'Fixture send budget exceeded');
        const messageId = String(20001 + sends.length);
        const record = {...args, messageId};
        const entry = {...record, accepted: reply?.(record) !== 'reject'};
        sends.push(entry);
        if (!entry.accepted) {
          res.end(JSON.stringify({status: 'failed', retcode: 100, data: null}));
          return;
        }
        data = {message_id: Number(messageId)};
      } else if (custom) data = await custom(args);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({status: 'ok', retcode: 0, data}));
    } catch (error) {
      fault ??= error;
      res.writeHead(400).end();
    }
  });
  const ws = new WebSocketServer({noServer: true});
  server.on('upgrade', (req, connection, head) => {
    if (!authorized(req) || req.url !== '/events' || socket?.readyState === WebSocket.OPEN) {
      connection.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    ws.handleUpgrade(req, connection, head, client => {socket = client; client.on('error', () => {});});
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const {port} = server.address();
  const check = () => {if (fault) throw fault;};
  return {
    httpUrl: 'http://127.0.0.1:' + port,
    wsUrl: 'ws://127.0.0.1:' + port + '/events',
    sends,
    check,
    connected: () => socket?.readyState === WebSocket.OPEN,
    message(subject, segments) {
      assert(allowed.has(String(subject)), 'Unknown fixture sender');
      return {post_type: 'message', message_type: 'private', self_id: Number(botId), user_id: Number(subject),
        message_id: ++sequence, time: Math.floor(Date.now() / 1000),
        message: typeof segments === 'string' ? [{type: 'text', data: {text: segments}}] : segments};
    },
    async send(event) {
      check();
      assert(socket?.readyState === WebSocket.OPEN, 'OneBot fixture not connected');
      assert.equal(String(event.self_id), String(botId));
      assert(allowed.has(String(event.user_id)), 'Unknown fixture sender');
      await new Promise((resolve, reject) => socket.send(JSON.stringify(event), error => error ? reject(error) : resolve()));
      return [event.self_id, event.user_id, event.message_id].join(':');
    },
    async close() {
      for (const client of ws.clients) client.terminate();
      server.closeAllConnections();
      await Promise.all([new Promise(resolve => ws.close(resolve)), new Promise(resolve => server.close(resolve))]);
    },
  };
}

export function readOneBotLedger(stateDir, read) {
  const filename = join(stateDir, 'channel.sqlite');
  if (!existsSync(filename) || !existsSync(filename + '-shm')) return undefined;
  const db = new DatabaseSync(filename, {readOnly: true});
  try {
    db.exec('PRAGMA busy_timeout=1000');
    // Ledger creation and the origin migration are separate statements.
    if (!db.prepare("SELECT 1 FROM pragma_table_info('inbound') WHERE name='origin'").get()) return undefined;
    return read(db);
  } finally {db.close();}
}

export function waitForOneBotTurn(stateDir, ids, {check, timeoutMs, status = 'completed'} = {}) {
  return waitForAcceptance(() => {
    check?.();
    const rows = readOneBotLedger(stateDir, db => {
      const find = db.prepare('SELECT id,status,origin FROM inbound WHERE id=?');
      return ids.map(id => find.get(id));
    });
    for (const row of rows ?? []) {
      if (!row) continue;
      assert.equal(row.origin, 'onebot', 'Turn did not enter through the OneBot socket');
      if (row.status !== 'admitted') assert.equal(row.status, status, 'Unexpected terminal inbound status');
    }
    return rows?.every(row => row?.status === status) ? rows : undefined;
  }, 'terminal OneBot turn ' + ids.join(', '), {timeoutMs});
}
