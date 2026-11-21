// Runs KnowledgeMap's actual FastAPI routes with a disposable SQLite database.
// The caller owns the temporary root and removes it after close().
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {once} from 'node:events';
import {accessSync, closeSync, constants, mkdtempSync, openSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:net';
import {join, resolve} from 'node:path';
import {KnowledgeMapClient} from '../../packages/knowledgemap-client/client.js';
import {waitForAcceptance} from '../acceptance/onebot-peer.mjs';

export async function startIsolatedKnowledgeMap(root) {
  const repo = resolve(process.env.KM_TEST_REPO ?? '/home/afrangry/repository');
  const python = resolve(process.env.KM_TEST_PYTHON ?? '/home/afrangry/miniconda3/envs/desheng/bin/python');
  const server = join(repo, 'backend/tests/assistant_server.py');
  try {
    accessSync(server, constants.R_OK);
    accessSync(python, constants.X_OK);
  } catch {
    throw Error('Set KM_TEST_REPO to the KnowledgeMap checkout and KM_TEST_PYTHON to its test Python');
  }
  const directory = mkdtempSync(join(root, 'knowledgemap-'));
  const tokenFile = join(directory, 'token');
  writeFileSync(tokenFile, randomBytes(32).toString('hex'), {mode: 0o600});
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const {port} = probe.address();
  await new Promise(done => probe.close(done));
  const baseUrl = 'http://127.0.0.1:' + port;
  const fd = openSync(join(directory, 'server.log'), 'wx', 0o600);
  let child;
  try {
    child = spawn(python, ['-B', server, '--port', String(port), '--token-file', tokenFile], {
      cwd: directory, stdio: ['ignore', fd, fd],
      // Even the unused default application engine is local SQLite.
      env: {PATH: process.env.PATH, HOME: directory, TMPDIR: directory, LANG: 'C.UTF-8',
        PYTHON_DOTENV_DISABLED: '1', DATABASE_URL: 'sqlite://'},
    });
  } finally {closeSync(fd);}
  let fault, stopped;
  const exited = new Promise(done => {
    child.once('exit', done);
    child.once('error', error => {fault = error; done();});
  });
  const close = () => stopped ??= (async () => {
    if (fault || child.exitCode !== null || child.signalCode !== null) return true;
    child.kill('SIGTERM');
    let forced = false;
    const timer = setTimeout(() => {forced = true; child.kill('SIGKILL');}, 5000);
    try {await exited; return !forced;} finally {clearTimeout(timer);}
  })();
  const config = {baseUrl, tokenFile};
  const client = new KnowledgeMapClient({...config, trace() {}});
  try {
    await waitForAcceptance(async () => {
      if (fault) throw fault;
      assert(child.exitCode === null && child.signalCode === null, 'Isolated KnowledgeMap API exited; see its fixture log');
      try {return (await client.request('/api/assistant/status', {signal: AbortSignal.timeout(500)})).ok === true;}
      catch {return false;}
    }, 'isolated KnowledgeMap API', {timeoutMs: 10000});
  } catch (error) {
    await close();
    throw error;
  }
  const web = async (route, method = 'GET', body) => {
    const response = await fetch(baseUrl + '/api/' + route, {method, redirect: 'error',
      signal: AbortSignal.timeout(5000), headers: {'content-type': 'application/json'},
      ...(body === undefined ? {} : {body: JSON.stringify(body)})});
    assert.ok(response.ok, route + ': ' + response.status);
    return response.status === 204 ? null : response.json();
  };
  return {config, client, web, close};
}
