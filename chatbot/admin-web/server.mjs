import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {randomBytes, timingSafeEqual} from 'node:crypto';
import {bad, fields, jsonFile, optional, Problem, readFile, realDirectory} from './common.mjs';
import {loadChanges} from './changes.mjs';
import {document, inventory, serviceStatus} from './inventory.mjs';
import {memory, operations} from './observations.mjs';
import {logSources, parseLogQuery, queryLogs} from './logs.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SESSION_AGE = 8 * 3600;
const BODY_MAX = 256 * 1024;
const CHANGE_AGE = 5 * 60 * 1000;
const random = () => randomBytes(32).toString('base64url');
const isToken = x => typeof x === 'string' && /^[a-zA-Z0-9_-]{43}$/u.test(x);
const includesRoot = (root, child) => child === root || child.startsWith(root + path.sep);

const headers = Object.freeze({
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'X-Frame-Options': 'DENY',
});

const assets = new Map([
  ['/', ['index.html', 'text/html']], ['/styles.css', ['styles.css', 'text/css']],
  ['/app.js', ['app.js', 'text/javascript']], ['/components.js', ['components.js', 'text/javascript']],
  ['/pages.js', ['pages.js', 'text/javascript']], ['/mark.svg', ['mark.svg', 'image/svg+xml']],
]);

function privateDirectory(dir) {
  fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  const result = realDirectory(dir);
  const stat = fs.statSync(result);
  if (stat.uid !== process.getuid() || (stat.mode & 0o077)) throw Error('Console state must be private');
  return result;
}

function readKey(stateRoot) {
  const file = path.join(stateRoot, 'access-key');
  try { fs.writeFileSync(file, random() + '\n', {flag: 'wx', mode: 0o600}); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid() || (st.mode & 0o077)) throw Error('Access key file must be private');
  const key = readFile(stateRoot, 'access-key', 80, {source: true}).text.trim();
  if (!isToken(key)) throw Error('Invalid console key');
  return key;
}

function readAudit(root) {
  return optional(() => {
    const file = path.join(root, 'changes.jsonl');
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077)) return [];
      const size = Math.min(stat.size, 96 * 1024), bytes = Buffer.alloc(size);
      const read = fs.readSync(fd, bytes, 0, size, stat.size - size);
      const lines = bytes.subarray(0, read).toString('utf8').trim().split('\n');
      return lines.slice(-(50)).map(line => optional(() => JSON.parse(line))).filter(row => row?.at && row?.kind);
    } finally { fs.closeSync(fd); }
  })?.reverse() ?? [];
}

function audit(root, record) {
  try {
    const f = path.join(root, 'changes.jsonl');
    const fd = fs.openSync(f, fs.constants.O_NOFOLLOW | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_WRONLY | fs.constants.O_NONBLOCK, 0o600);
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.nlink !== 1 || (st.mode & 0o077)) return false;
      fs.writeFileSync(fd, JSON.stringify(record) + '\n');
      fs.fsyncSync(fd);
      return true;
    } finally { fs.closeSync(fd); }
  } catch {
    return false;
  }
}

function reply(res, status, data, extra = {}) {
  const body = Buffer.from(JSON.stringify(data));
  res.writeHead(status, {...headers, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, ...extra});
  res.end(body);
}

async function body(req) {
  if (!/^application\/json(?:\s*;.*)?$/iu.test(req.headers['content-type'] ?? '')) throw new Problem(415, '只接收 JSON。');
  if (Number(req.headers['content-length']) > BODY_MAX) throw new Problem(413, '请求过大。');
  let size = 0;
  const chunks = [];
  // Leaving the stream open until the error response lets the browser receive 413.
  for await (const chunk of req.iterator({destroyOnReturn: false})) {
    size += chunk.length;
    if (size > BODY_MAX) throw new Problem(413, '请求过大。');
    chunks.push(chunk);
  }
  try { return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks))); }
  catch { throw bad('请求不是有效 JSON。'); }
}

function tokenFrom(req) {
  const auth = req.headers.authorization;
  const token = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return isToken(token) ? token : '';
}

export async function createConsole({sourceRoot, runtimeRoot, stateRoot, docsRoot = sourceRoot, port = 3085}) {
  sourceRoot = realDirectory(sourceRoot);
  runtimeRoot = realDirectory(runtimeRoot);
  docsRoot = realDirectory(docsRoot);
  stateRoot = path.resolve(stateRoot);
  if (includesRoot(runtimeRoot, sourceRoot) || includesRoot(sourceRoot, runtimeRoot) ||
      includesRoot(runtimeRoot, docsRoot) || includesRoot(runtimeRoot, stateRoot) ||
      includesRoot(sourceRoot, stateRoot)) throw Error('Console roots cannot overlap');
  stateRoot = privateDirectory(stateRoot);
  const key = Buffer.from(readKey(stateRoot));
  const version = jsonFile(HERE, 'package.json').version;
  const changes = await loadChanges(sourceRoot, runtimeRoot);
  const context = {sourceRoot, runtimeRoot, docsRoot};
  const sessions = new Map();
  let attempts = [];
  let statusCache = null;

  const status = () => {
    if (!statusCache || statusCache.until < Date.now()) {
      statusCache = {until: Date.now() + 2500, result: serviceStatus({...context, port: server.address().port})};
    }
    return statusCache.result;
  };

  const server = http.createServer({requestTimeout: 10000, headersTimeout: 6000, keepAliveTimeout: 4000, maxHeaderSize: 8192}, async (req, res) => {
    let result;
    try {
      const host = req.headers.host;
      const listeningPort = server.address().port;
      if (req.socket.remoteAddress !== '127.0.0.1' ||
          !['127.0.0.1:' + listeningPort, 'localhost:' + listeningPort].includes(host) ||
          req.headers.forwarded !== undefined || req.headers['x-forwarded-host'] !== undefined) {
        return reply(res, 403, {error: '管理台只接受本机直连。'});
      }
      if (!req.url?.startsWith('/') || req.url.startsWith('//') || req.url.includes('\\')) throw bad('无效请求路径。');
      const url = new URL(req.url, 'http://' + host);
      const p = url.pathname, method = req.method;
      if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') throw new Problem(405, '不支持的请求方法。');
      if (method === 'POST' && req.headers.origin !== 'http://' + host) throw new Problem(403, '请求须来自本管理台。');
      if ((method === 'GET' || method === 'HEAD') && assets.has(p)) {
        const [file, type] = assets.get(p);
        const {text} = readFile(HERE, 'public/' + file, 512 * 1024);
        res.writeHead(200, {...headers, 'Content-Type': type + '; charset=utf-8', 'Content-Length': Buffer.byteLength(text)});
        return res.end(method === 'HEAD' ? undefined : text);
      }
      if (!p.startsWith('/api/') || method === 'HEAD') throw new Problem(404, '页面不存在。');

      const now = Date.now();
      for (const [id, entry] of sessions) if (entry.until < now) sessions.delete(id);
      const sessionToken = tokenFrom(req), session = sessions.get(sessionToken);
      if (p === '/api/session' && method === 'GET') {
        return reply(res, 200, {app: 'kurumi-admin-web', authenticated: Boolean(session), version});
      }
      if (p === '/api/login' && method === 'POST') {
        attempts = attempts.filter(at => at > now - 60000);
        if (attempts.length >= 10) throw new Problem(429, '尝试过多，请一分钟后再试。');
        attempts.push(now);
        const input = await body(req);
        fields(input, ['key']);
        if (!isToken(input.key) || !timingSafeEqual(key, Buffer.from(input.key))) throw new Problem(401, '访问密钥不正确。');
        attempts = [];
        sessions.delete(sessionToken);
        if (sessions.size >= 8) sessions.delete(sessions.keys().next().value);
        const token = random();
        sessions.set(token, {until: now + SESSION_AGE * 1000, previews: new Map()});
        // Loopback ports share a cookie host. Keep this token scoped to the Web
        // origin and require the client to send it explicitly on API calls.
        return reply(res, 200, {authenticated: true, version, token});
      }
      if (!session) throw new Problem(401, '请先登录管理台。');
      if (p === '/api/logout' && method === 'POST') {
        sessions.delete(sessionToken);
        return reply(res, 200, {authenticated: false});
      }

      if (method === 'GET' && p === '/api/overview') {
        const map = inventory(context);
        const access = optional(() => changes.whitelist());
        const persona = optional(() => changes.persona());
        const [services, memories] = await Promise.all([status(), memory(context)]);
        result = {version, services, memory: memories,
          counts: {plugins: map.plugins.filter(p => p.runtime === 'on').length, agents: map.agents.length,
            identities: access?.rows.length ?? null, docs: map.docs.length}, name: persona?.identity ?? 'Kurumi',
          runtimeAvailable: map.runtimeAvailable, model: map.model, release: map.release,
          accessAligned: access?.aligned ?? null, personaAligned: persona?.aligned ?? null, audit: readAudit(stateRoot).slice(0, 5)};
      } else if (method === 'GET' && p === '/api/inventory') result = inventory(context);
      else if (method === 'GET' && p === '/api/services') result = await status();
      else if (method === 'GET' && p.startsWith('/api/docs/')) result = document(context, p.slice('/api/docs/'.length));
      else if (method === 'GET' && p === '/api/whitelist') result = changes.whitelist();
      else if (method === 'GET' && p === '/api/whitelist/managed') result = changes.managedLists();
      else if (method === 'GET' && p === '/api/persona') result = changes.persona();
      else if (method === 'GET' && p.startsWith('/api/persona/')) result = changes.role(p.slice('/api/persona/'.length));
      else if (method === 'GET' && p === '/api/memory') result = await memory(context, {withContent: url.searchParams.get('content') === '1'});
      else if (method === 'GET' && p === '/api/log-sources') result = logSources;
      else if (method === 'GET' && p === '/api/logs') result = await queryLogs(context, parseLogQuery(url.searchParams));
      else if (method === 'GET' && /^\/api\/ops\/(cron|runs|mail|coding|reminders|papers|documents)$/u.test(p)) {
        result = operations(context, p.slice('/api/ops/'.length));
      } else if (method === 'GET' && p === '/api/audit') result = {rows: readAudit(stateRoot)};
      else if (method === 'POST' && p === '/api/change/preview') {
        const input = await body(req);
        if (sessions.get(sessionToken) !== session || session.until < Date.now()) throw new Problem(401, '请先登录管理台。');
        const change = changes.preview(input);
        for (const [id, value] of session.previews) if (value.until < now) session.previews.delete(id);
        if (session.previews.size >= 6) session.previews.delete(session.previews.keys().next().value);
        const id = random();
        session.previews.set(id, {change, until: now + CHANGE_AGE});
        result = {id, kind: change.kind, operation: change.operation, label: change.label,
          before: change.before, after: change.after, sourceRevision: change.sourceRevision,
          expires: new Date(now + CHANGE_AGE).toISOString()};
      } else if (method === 'POST' && p === '/api/change/commit') {
        const input = await body(req);
        if (sessions.get(sessionToken) !== session || session.until < Date.now()) throw new Problem(401, '请先登录管理台。');
        fields(input, ['id']);
        const item = session.previews.get(input.id);
        session.previews.delete(input.id);
        if (!item || item.until < Date.now()) throw new Problem(409, '预览已失效，请重新预览。');
        const c = item.change;
        changes.commit(c);
        const recorded = audit(stateRoot, {at: new Date().toISOString(), kind: c.kind, operation: c.operation,
          target: c.target ?? c.label, sourceRevision: c.sourceRevision});
        result = {saved: true, recorded, pendingSync: true, sourceRevision: c.sourceRevision};
      } else throw new Problem(404, '此接口不存在。');
      reply(res, 200, result);
    } catch (err) {
      const problem = err instanceof Problem ? err : new Problem(503, '数据源暂时不可用，请核对运行状态或仓库设置。');
      if (!res.headersSent) reply(res, problem.status, {error: problem.message},
        problem.status === 413 ? {Connection: 'close'} : {});
      else res.destroy();
    }
  });
  server.maxRequestsPerSocket = 200;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  return server;
}

function args(argv) {
  const result = {
    sourceRoot: path.resolve(HERE, '../..'),
    runtimeRoot: path.join(os.homedir(), '.openclaw-fusion'),
    stateRoot: path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local/state'), 'kurumi-admin-web'),
    port: 3085,
  };
  const flags = {'--source': 'sourceRoot', '--runtime': 'runtimeRoot', '--state': 'stateRoot', '--docs': 'docsRoot', '--port': 'port'};
  for (let i = 0; i < argv.length; i += 2) {
    const key = flags[argv[i]], value = argv[i + 1];
    if (!Object.hasOwn(flags, argv[i]) || !value || value.startsWith('--')) throw Error('Invalid console option');
    result[key] = key === 'port' ? Number(value) : path.resolve(value);
  }
  if (!Number.isInteger(result.port) || result.port < 1024 || result.port > 65535) throw Error('Expected an unprivileged TCP port');
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const server = await createConsole(args(process.argv.slice(2)));
    process.stdout.write('Kurumi admin Web UI: http://127.0.0.1:' + server.address().port + '/\n');
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => server.close());
  } catch (error) {
    process.stderr.write('Kurumi admin Web UI failed to start (' + (error.code ?? 'invalid local setup') + ').\n');
    process.exitCode = 1;
  }
}
