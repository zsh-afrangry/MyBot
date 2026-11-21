import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {createConsole} from '../../admin-web/server.mjs';
import {initializeContinuity, replaceNotice} from '../../packages/memory-continuity/store.js';
import {emptyState} from '../../packages/memory-continuity/model.js';
import {normalizeTraceEvent} from '../../packages/observability/index.js';
import {compileAccessConfig} from '../../packages/access-control/config.js';
import {personaFiles} from '../../../scripts/fusion/lib/persona-workspaces.mjs';

const repo = fileURLToPath(new URL('../../..', import.meta.url));
export const fixtureOwner = '100000001';
export const fixtureMember = '100000002';
export const fixturePaperJob = 'job_' + '1'.repeat(24);

export async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kurumi-admin-test-'));
  const source = path.join(root, 'source'), runtime = path.join(root, 'runtime'), local = path.join(root, 'local');
  const sourceFile = (file, data) => {
    const name = path.join(source, file);
    fs.mkdirSync(path.dirname(name), {recursive: true});
    fs.writeFileSync(name, data);
  };
  const put = (file, data) => sourceFile(file, JSON.stringify(data, null, 2) + '\n');
  const workspace = path.join(runtime, 'workspace');
  fs.mkdirSync(workspace, {recursive: true, mode: 0o700});
  for (const pkg of ['access-control', 'memory-continuity', 'observability', 'log-query', 'session-records', 'qq-delivery', 'feedback-core']) {
    fs.cpSync(path.join(repo, 'chatbot/packages', pkg), path.join(source, 'chatbot/packages', pkg), {recursive: true});
  }
  sourceFile('scripts/fusion/lib/persona-workspaces.mjs', fs.readFileSync(path.join(repo, 'scripts/fusion/lib/persona-workspaces.mjs')));
  sourceFile('scripts/fusion/templates/AGENTS.md', '# 合成主人规则\n{{PERSONA_INTRO}}\n<!-- owner-exec-scope -->\n');
  sourceFile('scripts/fusion/templates/MEMBER_AGENTS.md', '# 合成成员规则\n');
  const policy = {version: 1, revision: 1, subjects: [{
    qq: fixtureOwner, role: 'owner', kind: 'user', enabled: true,
    permissions: {'chat.use': true, 'host.exec': true}, mailRecipients: ['first@example.com'], note: '隔离验收主人',
  }]};
  const runtimeIntent = {channels: {'kurumi-qq': {enabled: false}}, agents: {entries: {main: {
    workspace, model: {primary: 'demo/local'}, tools: {alsoAllow: ['fixture_tool']},
  }}}, plugins: {entries: {
    'kurumi-memory': {enabled: true, config: {continuity: {enabled: true, summaryTtlDays: 7}}},
    'kurumi-host-control': {config: {exec: {workdir: '/synthetic/default',
      writeBoundary: {root: '/synthetic/default', additionalRoots: ['/synthetic/extra']}}}},
    'kurumi-coding': {config: {projects: [{id: 'example', root: '/synthetic/project', branch: 'test',
      checks: [{name: 'fixture-check', command: 'private-fixture-command'}]}]}},
  }}};
  put('config/access-control.json', policy);
  put('config/runtime.config.json', runtimeIntent);
  put('config/openclaw-release.json', {version: '2026.11.1'});
  put('config/persona.json', {identityName: 'Kurumi (隔离验收)', roleFile: 'roles/fusion.md', userFile: '# 合成用户\n',
    relationshipFiles: {owner: 'roles/owner.md', member: 'roles/member.md'}, agentsIntro: '合成主人开场'});
  sourceFile('roles/fusion.md', '# 合成角色\n\n温柔，表达有边界。\n');
  sourceFile('roles/owner.md', '# 主人关系\n');
  sourceFile('roles/member.md', '# 成员关系\n');
  sourceFile('docs/25_人格.md', '状态：开发中\n\n# 人格与连续性\n\n## 功能\n\n隔离验收。\n');
  sourceFile('docs/33_验收.md', '状态：需求\n\n# 管理台测试\n');
  sourceFile('docs/example.md', 'private-fixture-note-removed');
  fs.writeFileSync(path.join(runtime, 'openclaw.json'), JSON.stringify(compileAccessConfig(runtimeIntent, policy)));
  for (const [file, content] of personaFiles(source, runtime).files) fs.writeFileSync(file, content);
  const t = new Date().toISOString();
  const mem = emptyState(fixtureOwner, 4);
  mem.facts.push({id: '0123456789ab', kind: 'preference', text: '假设偏好热茶。', createdAt: t, updatedAt: t,
    source: {origin: 'current_owner', messageId: 'fake-message', sessionKey: 'agent:main:kurumi-qq:direct:' + fixtureOwner,
      sessionId: 'fake-session', runId: 'fixture-run', at: t, rawHash: 'a'.repeat(64), evidence: '与原文投影隔离的验收证据。'}});
  initializeContinuity(workspace, mem);
  replaceNotice(workspace);
  fs.mkdirSync(path.join(runtime, 'channel'));
  fs.writeFileSync(path.join(runtime, 'channel', 'trace-events.jsonl'), [normalizeTraceEvent({
    at: t, source: 'trace-events', kind: 'admin.fixture',
    correlation: {runId: 'fixture-run', cronJobId: 'cron-fixture', taskId: fixturePaperJob},
    data: {status: 'failed', code: 'SAMPLE_CODE', text: 'fixture-private-chat', apiKey: 'fixture-private-key'},
  })].map(x => JSON.stringify(x)).join('\n') + '\n');
  fs.mkdirSync(path.join(runtime, 'documents/jobs'), {recursive: true});
  fs.writeFileSync(path.join(runtime, 'documents/jobs', fixturePaperJob + '.json'), JSON.stringify({
    id: fixturePaperJob, documentId: 'pdf_' + '2'.repeat(32), status: 'succeeded', delivery: {status: 'delivered'},
    updatedAt: t, filename: 'private-fixture-filename.pdf', testPadding: 'x'.repeat(320 * 1024),
  }));
  fs.mkdirSync(path.join(runtime, 'state'));
  const db = new DatabaseSync(path.join(runtime, 'state/openclaw.sqlite'));
  try {
    db.exec('CREATE TABLE cron_jobs(job_id TEXT, name TEXT, enabled INT, payload_kind TEXT, state_json TEXT, sort_order INT);');
    db.prepare('INSERT INTO cron_jobs VALUES (?,?,?,?,?,?)').run('cron-fixture', '合成定时任务', 1, 'systemEvent',
      JSON.stringify({lastStatus: 'error', lastRunAtMs: Date.now(), nextRunAtMs: Date.now() + 86400000}), 1);
  } finally {db.close();}
  let app;
  try { app = await createConsole({sourceRoot: source, runtimeRoot: runtime, stateRoot: local, port: 0}); }
  catch (error) { fs.rmSync(root, {recursive: true, force: true}); throw error; }
  const base = 'http://127.0.0.1:' + app.address().port;
  const key = fs.readFileSync(path.join(local, 'access-key'), 'utf8').trim();
  const call = async (endpoint, {data, token, origin = base, headers = {}, method = data === undefined ? 'GET' : 'POST'} = {}) => {
    const response = await fetch(base + endpoint, {method,
      headers: {...(token ? {Authorization: 'Bearer ' + token} : {}), ...(method === 'POST' ? {Origin: origin, 'Content-Type': 'application/json'} : {}), ...headers},
      body: data === undefined ? undefined : JSON.stringify(data)});
    return {status: response.status, body: await response.json(), headers: response.headers};
  };
  async function session() {
    const r = await call('/api/login', {data: {key}});
    if (r.status !== 200) throw Error('Fixture login failed');
    return (ep, attrs) => call('/api' + ep, {token: r.body.token, ...attrs});
  }
  return {
    app, base, key, root, source, runtime, local, call, session,
    file: (root, relative) => fs.readFileSync(path.join(root, relative), 'utf8'),
    close: async () => {
      app.closeAllConnections();
      await new Promise(resolve => app.close(resolve));
      fs.rmSync(root, {recursive: true, force: true});
    },
  };
}
