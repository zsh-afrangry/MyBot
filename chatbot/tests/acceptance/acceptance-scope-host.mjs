// Starts one isolated Fusion Gateway with the real QQ adapter, a temporary
// test-scope plugin, a deterministic model and a loopback OneBot peer.
// Separated fixture DBs/notification worker only. No paid model, real QQ, production data or service changes.
import {FIXTURE_CONTEXT_WINDOW, readFixtureJson} from './fixture-model.mjs';
import assert from 'node:assert/strict';
import {randomBytes, randomUUID} from 'node:crypto';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, isAbsolute, join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {sendGatewayTurn} from '../../scripts/acceptance-live-dialogue.mjs';
import {compileAccessConfig} from '../../packages/access-control/config.js';
import {ownerPolicy} from '../access-control/fixtures.mjs';
import {startIsolatedGateway} from './isolated-gateway.mjs';
import {createOneBotPeer, readOneBotLedger, waitForAcceptance, waitForOneBotTurn} from './onebot-peer.mjs';

const [, , flag, out, ...rest] = process.argv;
assert(flag === '--out' && isAbsolute(out ?? '') && !rest.length && !existsSync(out), 'Require a new absolute --out');
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'kurumi-acceptance-scope-'));
const token = randomBytes(24).toString('hex');
const owner = '700031', bot = '700032', pluginId = 'acceptance-scope-probe', tool = 'acceptance_scope_record', agentId = 'acceptance-probe';
const channelDir = join(root, 'channel');
const mainWorkspace = join(root, 'workspace-owner'), testWorkspace = join(root, 'workspace-probe');
const boundary = {cognition: 'deterministic fixture', host: 'one isolated OpenClaw process',
  qq: 'official adapter with loopback OneBot', scope: 'temporary fixture plugin and database with the shared natural confirmation core',
  background: 'fixture worker'};
const report = {at: new Date().toISOString(), boundary, cases: [], requests: 0};
let peer, model, host, modelError, ownerGate;
const putJson = (file, value) => writeFileSync(file, JSON.stringify(value), {flag: 'wx', mode: 0o600});

function startModel() {
  return createServer(async (req, res) => {
    try {
      assert(++report.requests <= 25, 'Fixture model budget exceeded');
      const body = await readFixtureJson(req, {maxBytes: 2 * 1024 * 1024}), messages = body.messages ?? [];
      const prompt = JSON.stringify(messages), visible = body.tools?.map(t => t.function?.name) ?? [];
      const localTurn = messages.findLastIndex(m => m.role === 'user' &&
        /LOCAL_PROBE_(REMEMBER_42|RECALL)/u.test(JSON.stringify(m.content ?? '')));
      const userIndex = messages.findLastIndex(m => m.role === 'user' &&
        /OWNER_SCOPE_LANE|SCOPE_STEP=/u.test(JSON.stringify(m.content ?? '')));
      const current = JSON.stringify(messages[userIndex]?.content ?? '');
      const ownerTurn = current.includes('OWNER_SCOPE_LANE');
      let message;
      if (localTurn >= 0) {
        assert(prompt.includes('OWNER_WORKSPACE_ONLY'));
        assert(!prompt.includes('PROBE_WORKSPACE_ONLY'));
        const recall = JSON.stringify(messages[localTurn].content).includes('LOCAL_PROBE_RECALL');
        if (recall) assert(JSON.stringify(messages.slice(0, localTurn)).includes('LOCAL_PROBE_REMEMBER_42'));
        message = {role: 'assistant', content: recall ? 'LOCAL_PROBE_42' : 'LOCAL_PROBE_READY'};
      } else if (ownerTurn) {
        assert(prompt.includes('OWNER_WORKSPACE_ONLY')); assert(!prompt.includes('PROBE_WORKSPACE_ONLY'));
        assert(!prompt.includes('SCOPE_STEP=')); assert(!visible.includes(tool));
        ownerGate.seen = true;
        await ownerGate.release.promise;
        message = {role: 'assistant', content: 'OWNER_LOOPBACK_REPLY'};
      } else {
        assert(prompt.includes('PROBE_WORKSPACE_ONLY')); assert(!prompt.includes('OWNER_WORKSPACE_ONLY'));
        assert(!prompt.includes('OWNER_SCOPE_LANE')); assert.deepEqual(visible, [tool]);
        if (messages.findLastIndex(m => m.role === 'tool') > userIndex) {
          message = {role: 'assistant', content: current.includes('SCOPE_STEP=preview')
            ? 'Scope fixture: create one local record' : 'Scope fixture: checked'};
        } else {
          const step = /SCOPE_STEP=([a-z-]+)/u.exec(current)?.[1];
          const action = step === 'early-confirm' ? 'confirm' : step;
          assert(['preview', 'read', 'confirm'].includes(action), 'Unknown fixture step');
          message = {role: 'assistant', tool_calls: [{id: 'scope-' + report.requests, type: 'function',
            function: {name: tool, arguments: JSON.stringify({action})}}]};
        }
      }
      const base = {id: 'scope-fixture-' + report.requests, model: 'fixture', created: 1};
      const reason = message.tool_calls ? 'tool_calls' : 'stop';
      if (!body.stream) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({...base, object: 'chat.completion', choices: [{index: 0, message, finish_reason: reason}]}));
        return;
      }
      const delta = message.tool_calls ? {...message, tool_calls: message.tool_calls.map((call, index) => ({...call, index}))} : message;
      const chunk = (value, finish_reason) => 'data: ' + JSON.stringify({...base, object: 'chat.completion.chunk',
        choices: [{index: 0, delta: value, finish_reason}]}) + '\n\n';
      res.setHeader('content-type', 'text/event-stream');
      res.end(chunk(delta, null) + chunk({}, reason) + 'data: [DONE]\n\n');
    } catch (error) {
      modelError ??= error;
      res.writeHead(400).end();
    }
  });
}

function query(lane, statement, ...args) {
  const db = new DatabaseSync(join(root, 'acceptance', lane + '.sqlite'), {readOnly: true});
  try {return db.prepare(statement).all(...args);} finally {db.close();}
}
function checked(label) {report.cases.push(label); console.log(JSON.stringify({case: label, passed: true}));}

try {
  for (const dir of [mainWorkspace, testWorkspace]) mkdirSync(dir, {mode: 0o700});
  writeFileSync(join(mainWorkspace, 'AGENTS.md'), 'OWNER_WORKSPACE_ONLY');
  writeFileSync(join(testWorkspace, 'AGENTS.md'), 'PROBE_WORKSPACE_ONLY');
  const plugin = join(root, 'plugin');
  mkdirSync(plugin, {mode: 0o700});
  putJson(join(plugin, 'package.json'), {name: pluginId, type: 'module', openclaw: {extensions: ['./index.js']}});
  putJson(join(plugin, 'openclaw.plugin.json'), {id: pluginId, activation: {onStartup: true},
    contracts: {tools: [tool]}, toolMetadata: {[tool]: {optional: true}}, configSchema: {type: 'object', properties: {}}});
  writeFileSync(join(plugin, 'index.js'),
    'import {buildScopeFixture} from ' + JSON.stringify(new URL('./fixtures/scope-host-plugin.mjs', import.meta.url).href)
    + '; export default buildScopeFixture(' + JSON.stringify({root}) + ');\n');
  const tokenFile = join(root, 'onebot-token');
  writeFileSync(tokenFile, token, {mode: 0o600});
  peer = await createOneBotPeer({token, botId: bot, subjects: [owner]});
  model = startModel();
  model.listen(0, '127.0.0.1');
  await once(model, 'listening');
  const expectedOwnerKey = 'agent:main:kurumi-qq:direct:' + owner;
  host = await startIsolatedGateway({repo, root, token, configure: () => compileAccessConfig({
    agents: {ownership: 'explicit', defaults: {workspace: mainWorkspace, systemAgent: {agentId: 'main'},
      model: {primary: 'fixture/fixture'}}, entries: {main: {workspace: mainWorkspace, tools: {allow: ['session_status']}},
      [agentId]: {workspace: testWorkspace, tools: {allow: [tool]}}}},
    models: {catalogRefresh: {enabled: false}, providers: {fixture: {baseUrl: 'http://127.0.0.1:' + model.address().port + '/v1',
      apiKey: 'synthetic', api: 'openai-completions', models: [{id: 'fixture', name: 'fixture', input: ['text'],
        reasoning: false, contextWindow: FIXTURE_CONTEXT_WINDOW, maxTokens: 1000}]}}},
    plugins: {allow: ['kurumi-qq', pluginId], load: {paths: [join(repo, 'chatbot/plugins/kurumi-qq'), plugin]},
      entries: {'kurumi-qq': {enabled: true}, [pluginId]: {enabled: true}}, slots: {memory: 'none'}},
    channels: {'kurumi-qq': {enabled: true, httpUrl: peer.httpUrl, wsUrl: peer.wsUrl, httpTokenFile: tokenFile,
      wsTokenFile: tokenFile, stateDir: channelDir, mediaRoot: join(root, 'media'), testIngress: false}},
    session: {dmScope: 'per-channel-peer'}, cron: {enabled: false}, update: {checkOnStart: false},
    tools: {toolSearch: false, codeMode: false, deny: ['read', 'write', 'exec', 'message', 'sessions_spawn'],
      web: {search: {enabled: false}, fetch: {enabled: false}}}, logging: {file: join(root, 'runtime.log')},
  }, ownerPolicy(owner))});
  await host.ready();
  await waitForAcceptance(peer.connected, 'OneBot socket');
  await assert.rejects(host.call('kurumi-qq.testInbound'), /unknown method|not found/iu);
  const check = () => {if (modelError) throw modelError; peer.check();};
  const turn = async (lane, step, mode) => {
    const value = await host.call(pluginId + '.turn', {lane, step, ...(mode ? {mode} : {})}, 20000);
    check();
    assert(Number.isSafeInteger(value.pid) && value.pid > 0);
    report.hostPid ??= value.pid;
    assert.equal(value.pid, report.hostPid);
    assert.equal(value.active, 0); assert.equal(value.workerFailed, false);
    assert.equal(value.unscopedBackendOpens, 0, 'A scoped request opened a globally registered confirmation backend');
    assert(value.sessionKey.startsWith('agent:' + agentId + ':scenario:'));
    assert.notEqual(value.sessionKey, expectedOwnerKey);
    return value;
  };
  await assert.rejects(host.call(pluginId + '.turn', {lane: 'a', step: 'read', sender: owner}), /Invalid fixture admission/u);
  await assert.rejects(host.call(pluginId + '.turn', {lane: 'a', step: 'preview', mode: 'expired'}), /invalid_scoped_confirmation_request/u);
  assert.deepEqual(query('a', 'SELECT * FROM confirmation_proposals'), []);
  checked('expired-test-authority-does-not-open-a-confirmation');
  const noLease = await turn('a', 'read', 'no-lease');
  assert.equal(noLease.toolResult, undefined);
  assert(noLease.decisions.some(row => row.tool === tool && row.allowed === false));
  assert.deepEqual(query('a', 'SELECT * FROM inbox'), []);
  checked('unbound-run-and-extra-inbound-fields-cannot-use-fixture-authority');

  ownerGate = {seen: false, release: Promise.withResolvers()};
  const id = await peer.send(peer.message(owner, 'OWNER_SCOPE_LANE'));
  await waitForAcceptance(() => {check(); return ownerGate.seen;},
    'owner model input');
  const preview = await turn('a', 'preview');
  assert(preview.delivered && preview.toolResult?.ok);
  assert.equal(readOneBotLedger(channelDir, db => db.prepare('SELECT status FROM inbound WHERE id=?').get(id))?.status, 'admitted');
  ownerGate.release.resolve();
  await waitForOneBotTurn(channelDir, [id], {check});
  assert.equal(peer.sends.length, 1);
  assert(JSON.stringify(peer.sends[0].message).includes('OWNER_LOOPBACK_REPLY'));
  assert.equal(query('a', "SELECT * FROM inbox WHERE kind='reply'").length, 1);
  checked('owner-turn-and-test-preview-coexist-in-one-host-with-separate-workspaces-and-delivery');

  const readOther = await turn('b', 'read');
  assert.deepEqual(readOther.toolResult, {ok: true, pending: 0});
  const other = await turn('b', 'confirm');
  assert.notEqual(other.sessionId, preview.sessionId); assert.notEqual(other.sessionKey, preview.sessionKey);
  assert.equal(other.toolResult?.code, 'preview_unavailable');
  assert.deepEqual(query('b', 'SELECT * FROM approval_grants'), []);
  assert.deepEqual(query('a', 'SELECT * FROM approval_grants'), []);
  checked('another-test-subject-cannot-confirm-the-preview');

  const committed = await turn('a', 'confirm');
  assert.equal(committed.sessionId, preview.sessionId);
  assert.equal(committed.toolResult?.queued, true);
  const [grant] = query('a', 'SELECT status, consumed_at_utc FROM approval_grants');
  assert.equal(grant?.status, 'consumed'); assert(grant.consumed_at_utc > 0);
  const job = await waitForAcceptance(() => query('a', "SELECT * FROM jobs WHERE status='delivered'")[0], 'scoped background receipt');
  assert.equal(job.session_key, preview.sessionKey);
  const [inbox] = query('a', "SELECT * FROM inbox WHERE kind='background'");
  assert.equal(inbox?.source_id, job.proposal_id); assert.equal(inbox.destination, 'inbox:' + job.subject);
  assert.deepEqual(query('b', "SELECT * FROM inbox WHERE kind='background'"), []);
  assert.equal(peer.sends.length, 1, 'Fixture background delivery reached the QQ transport');
  const repeat = await turn('a', 'confirm');
  assert.equal(repeat.toolResult?.code, 'preview_unavailable');
  assert.equal(query('a', 'SELECT * FROM approval_grants').length, 1);
  assert.equal(query('a', 'SELECT * FROM jobs').length, 1);
  checked('later-confirmation-commits-once-and-background-job-uses-persisted-test-route');

  // Verify the asynchronous worker rechecks its route from durable data.
  const fixtureDb = new DatabaseSync(join(root, 'acceptance', 'a.sqlite'));
  try {
    fixtureDb.exec('PRAGMA busy_timeout=1000');
    fixtureDb.prepare("INSERT INTO jobs VALUES ('invalid-fixture-destination',?,?,?,'queued')")
      .run(job.subject, job.session_key, 'user:' + owner);
  } finally {fixtureDb.close();}
  await waitForAcceptance(() => query('a', "SELECT 1 FROM jobs WHERE status='scope_rejected'")[0], 'worker route rejection');
  assert.equal(query('a', "SELECT * FROM inbox WHERE kind='background'").length, 1);
  assert.equal(peer.sends.length, 1);
  checked('background-worker-refuses-a-destination-outside-its-test-scope');

  const dropped = await turn('b', 'preview', 'drop-receipt');
  assert.equal(dropped.toolResult?.ok, true); assert.equal(dropped.delivered, false);
  const refused = await turn('b', 'early-confirm');
  assert.equal(refused.toolResult?.code, 'proposal_not_presented');
  assert.deepEqual(query('b', 'SELECT * FROM approval_grants'), []);
  assert.deepEqual(query('b', 'SELECT * FROM jobs'), []);
  checked('no-preview-receipt-means-no-approval-or-job');

  const config = JSON.parse(readFileSync(join(root, 'openclaw.json'), 'utf8'));
  const localSession = {config, token, sessionKey: 'agent:main:codex-acceptance-' + randomUUID()};
  for (const [message, reply] of [['LOCAL_PROBE_REMEMBER_42', 'LOCAL_PROBE_READY'], ['LOCAL_PROBE_RECALL', 'LOCAL_PROBE_42']]) {
    const result = await sendGatewayTurn({...localSession, message});
    check();
    assert.equal(result.status, 'ok');
    assert.equal((result.result?.payloads ?? result.payloads)?.at(-1)?.text, reply);
  }
  assert.equal(peer.sends.length, 1);
  checked('local-gateway-rpc-waits-for-replies-and-preserves-session-without-qq-delivery');
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = modelError?.message ?? error.message;
} finally {
  ownerGate?.release.resolve();
  report.gracefulStop = await host?.close() ?? null;
  model?.closeAllConnections();
  await Promise.all([peer?.close(), model && new Promise(resolve => model.close(resolve))]);
  if (report.gracefulStop === false) {
    report.passed = false;
    report.error ??= 'Isolated Gateway did not stop gracefully';
  }
  report.configSha256 = host?.configSha256;
  if (report.passed) {rmSync(root, {recursive: true, force: true}); report.fixtureRemoved = !existsSync(root);}
  else {report.diagnosticsRoot = root; process.exitCode = 1;}
  report.finishedAt = new Date().toISOString();
  mkdirSync(dirname(out), {recursive: true});
  putJson(out, report);
  console.log(JSON.stringify({passed: report.passed, cases: report.cases.length, error: report.error, evidence: out}));
}
