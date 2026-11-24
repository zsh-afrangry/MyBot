// Isolated OpenClaw Gateway acceptance for Stage 3: kurumi-mail IMAP inbox, dual-layer trust,
// per-email access unlock (mail_inbox confirmation), attachment staging, and move/trash without EXPUNGE.
import {FIXTURE_CONTEXT_WINDOW, readFixtureJson} from '../acceptance/fixture-model.mjs';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {once} from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {compileAccessConfig} from '../../packages/access-control/config.js';
import {buildMessage} from '../../plugins/kurumi-mail/mime.js';
import {IMAP_CERT_FILE, IMAP_TEST_PASS, IMAP_TEST_USER, MockImapServer} from '../../plugins/kurumi-mail/test/mock-imap.js';
import {ownerPolicy} from '../access-control/fixtures.mjs';
import {withHostControl} from '../access-control/host-config.mjs';
import {startIsolatedGateway} from '../acceptance/isolated-gateway.mjs';
import {createOneBotPeer, textOfSend, waitForAcceptance, waitForOneBotTurn} from '../acceptance/onebot-peer.mjs';
import {scenarioProgress} from '../acceptance/scenario-lifecycle.mjs';

const [flag, out, ...extra] = process.argv.slice(2);
assert(flag === '--out' && path.isAbsolute(out ?? '') && !fs.existsSync(out) && !extra.length, 'Require a new absolute --out');
const repo = fileURLToPath(new URL('../../../', import.meta.url));
assert(path.resolve(out).startsWith(path.resolve(repo, 'test-output') + path.sep), 'Use test-output for evidence');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kurumi-mail-inbox-host-'));
const state = path.join(root, 'state');
const channelDir = path.join(state, 'channel');
const workspace = path.join(state, 'workspace');
const fakeHome = path.join(root, 'fake-home');
const kurumiSpace = path.join(fakeHome, 'kurumi-space');
const tokenFile = path.join(state, 'onebot-token');
const token = randomBytes(24).toString('hex');

for (const d of [state, channelDir, path.join(state, 'media'), workspace, kurumiSpace]) {
  fs.mkdirSync(d, {recursive: true});
}
fs.writeFileSync(tokenFile, token, {mode: 0o600});
fs.writeFileSync(path.join(workspace, 'AGENTS.md'), '# Synthetic owner workspace\n');

const owner = '100001';
const bot = '100002';
const report = {
  at: new Date().toISOString(),
  openclaw: JSON.parse(fs.readFileSync(path.join(repo, 'node_modules/openclaw/package.json'), 'utf8')).version,
  boundary: 'Isolated Gateway, deterministic loopback model, loopback OneBot, loopback TLS IMAP4rev1 mock.',
  cases: [],
  requests: 0,
  primaryModel: 'fixture/fixture',
};

function unwrap(value) {
  for (let i = 0; i < 6; i++) {
    if (typeof value === 'string') {
      try { value = JSON.parse(value); } catch { return value; }
    } else if (value?.result && !value.task) {
      value = value.result;
    } else if (value?.content?.length === 1) {
      value = value.content[0].text;
    } else {
      break;
    }
  }
  return value;
}

let active;
function modelReply(body, tool, res, text = '收件箱验收完成。') {
  const choice = tool ? {
    role: 'assistant',
    content: null,
    tool_calls: [{id: 'call_' + report.requests, type: 'function', function: {name: tool[0], arguments: JSON.stringify(tool[1])}}],
  } : {role: 'assistant', content: text};
  const finish = tool ? 'tool_calls' : 'stop';
  const common = {id: 'chatcmpl-mail-inbox', created: 1, model: 'fixture'};
  if (!body.stream) {
    return res.end(JSON.stringify({...common, object: 'chat.completion', choices: [{index: 0, message: choice, finish_reason: finish}]}));
  }
  res.setHeader('content-type', 'text/event-stream');
  const event = (delta, finish_reason) => 'data: ' + JSON.stringify({
    ...common, object: 'chat.completion.chunk', choices: [{index: 0, delta, finish_reason}],
  }) + '\n\n';
  const delta = tool ? {...choice, tool_calls: choice.tool_calls.map((c, idx) => ({...c, index: idx}))} : choice;
  res.end(event(delta, null) + event({}, finish) + 'data: [DONE]\n\n');
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url !== '/v1/chat/completions' || req.method !== 'POST') { res.writeHead(404).end(); return; }
    const body = await readFixtureJson(req);
    res.setHeader('content-type', 'application/json');
    assert(++report.requests <= 80, 'Unexpected model request budget exceeded');
    assert(active, 'Unexpected model request');
    if (active.observe) {
      const last = body.messages.findLast(m => m.role === 'tool');
      active.observe(unwrap(last?.content));
      active.observe = undefined;
    }
    const step = active.steps[active.next];
    if (!step) return modelReply(body, undefined, res, typeof active.reply === 'function' ? active.reply() : active.reply);
    if (!step.direct && !active.found) {
      active.found = true;
      return modelReply(body, ['tool_search', {query: step.name, limit: 1}], res);
    }
    active.found = false;
    active.next++;
    active.observe = step.verify;
    const args = typeof step.args === 'function' ? step.args() : step.args;
    return modelReply(body, ['dispatch_action', {id: step.name, args}], res);
  } catch (error) {
    report.fixtureError = error.message;
    res.writeHead(400).end(JSON.stringify({error: {message: 'mail_inbox_host_fixture_failed'}}));
  }
});

let gateway, peer, imap;
try {
  imap = new MockImapServer();
  const trustedBytes = Buffer.from('PK\x03\x04INBOX_TRUSTED_ATTACHMENT');
  const trustedUid = imap.addMessage('INBOX', {
    rawBuffer: buildMessage({
      messageId: 'inbox-trusted-1@trusted.example',
      from: {name: 'Trusted Billing', address: 'bills@trusted.example'},
      to: [IMAP_TEST_USER],
      subject: '11月受信任账单',
      text: 'TRUSTED_HOST_BODY',
      attachments: [{filename: 'trusted-bill.xlsx', content: trustedBytes}],
    }).raw,
  });

  const strangerBytes = Buffer.from('STRANGER_HOST_BYTES');
  const strangerUid = imap.addMessage('INBOX', {
    rawBuffer: buildMessage({
      messageId: 'inbox-stranger-1@unknown.example',
      from: {name: 'Stranger', address: 'stranger@unknown.example'},
      to: [IMAP_TEST_USER],
      subject: '陌生发件人测试',
      text: 'INBOX_INJECTION_ATTEMPT',
      attachments: [{filename: 'untrusted-note.txt', content: strangerBytes}],
    }).raw,
  });

  const imapAddr = await imap.start();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  peer = await createOneBotPeer({token, botId: bot, subjects: [owner]});

  const policy = ownerPolicy(owner);
  policy.subjects[0].mailSenders = ['bills@trusted.example'];

  const plugins = ['kurumi-qq', 'kurumi-files', 'kurumi-mail', 'personal-confirmation'];
  const cfg = compileAccessConfig(withHostControl({
    models: {
      catalogRefresh: {enabled: false},
      providers: {
        fixture: {
          baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
          apiKey: 'synthetic',
          api: 'openai-completions',
          models: [{id: 'fixture', name: 'fixture', reasoning: false, input: ['text'], contextWindow: FIXTURE_CONTEXT_WINDOW, maxTokens: 1200}],
        },
      },
    },
    agents: {
      ownership: 'explicit',
      defaults: {workspace, systemAgent: {agentId: 'main'}, model: {primary: 'fixture/fixture'}, heartbeat: {every: '0m'}},
      entries: {
        main: {
          workspace,
          model: {primary: 'fixture/fixture'},
          tools: {
            profile: 'messaging',
            alsoAllow: ['personal_confirmation', 'kurumi_files', 'email_status', 'email_inbox'],
            deny: ['read', 'write', 'edit', 'apply_patch', 'process', 'message', 'sessions_spawn'],
          },
        },
      },
    },
    channels: {
      'kurumi-qq': {
        enabled: true,
        httpUrl: peer.httpUrl,
        wsUrl: peer.wsUrl,
        httpTokenFile: tokenFile,
        wsTokenFile: tokenFile,
        stateDir: channelDir,
        mediaRoot: path.join(state, 'media'),
        testIngress: false,
        dailySendLimit: 100,
        segmentDelayMs: 0,
      },
    },
    plugins: {
      allow: plugins,
      load: {paths: plugins.map(id => path.join(repo, 'chatbot/plugins', id))},
      entries: {
        'kurumi-qq': {enabled: true},
        'personal-confirmation': {enabled: true, hooks: {allowConversationAccess: true}},
        'kurumi-mail': {enabled: true},
        'kurumi-files': {
          enabled: true,
          config: {
            homeDir: fakeHome,
            defaultWorkspace: kurumiSpace,
            t0Roots: [{path: kurumiSpace, label: '工作区'}],
            t1Roots: [{path: fakeHome, label: '主目录'}],
          },
        },
      },
      slots: {memory: 'none'},
    },
    tools: {codeMode: false, deny: ['process', 'message', 'sessions_spawn'], web: {search: {enabled: false}, fetch: {enabled: false}}},
    session: {dmScope: 'per-channel-peer'},
    cron: {enabled: false},
    update: {checkOnStart: false},
    logging: {file: path.join(state, 'runtime.log')},
  }, repo), policy);

  gateway = await startIsolatedGateway({
    repo,
    root: state,
    token,
    configure: () => cfg,
    env: {
      NODE_EXTRA_CA_CERTS: IMAP_CERT_FILE,
      KURUMI_MAIL_USER: IMAP_TEST_USER,
      KURUMI_MAIL_AUTH_CODE: IMAP_TEST_PASS,
      KURUMI_IMAP_HOST: '127.0.0.1',
      KURUMI_IMAP_PORT: String(imapAddr.port),
    },
  });
  await gateway.ready();
  await waitForAcceptance(peer.connected, 'mail-inbox OneBot socket');
  scenarioProgress('gateway-ready');

  // Turn 1: List inbox, read trusted email + save attachment, inspect untrusted metadata, propose_access on stranger.
  let accessProposal, manageProposal, strangerPartId;
  active = {
    next: 0,
    reply: () => `需要您确认放行陌生邮件：\n${accessProposal.previewText}`,
    steps: [
      {
        name: 'email_inbox',
        args: {action: 'list'},
        verify: result => {
          assert.equal(result.ok, true);
          assert.equal(result.items.length, 2);
          assert.equal(result.items.find(x => x.uid === trustedUid).trusted, true);
          assert.equal(result.items.find(x => x.uid === strangerUid).trusted, false);
        },
      },
      {
        name: 'email_inbox',
        direct: true,
        args: {action: 'save_attachment', uid: trustedUid},
        verify: result => {
          assert.equal(result.ok, true);
          assert(result.path.startsWith(path.join(kurumiSpace, 'mail-attachments') + '/'));
          assert.deepEqual(fs.readFileSync(result.path), trustedBytes);
        },
      },
      {
        name: 'email_inbox',
        direct: true,
        args: {action: 'read', uid: strangerUid},
        verify: result => {
          assert.equal(result.trusted, false);
          assert.equal(result.requiresAccessApproval, true);
          assert.equal(result.bodyText, undefined);
          assert.equal(result.attachments[0].filename, undefined);
          strangerPartId = result.attachments[0].partId;
        },
      },
      {
        name: 'email_inbox',
        direct: true,
        args: () => ({action: 'propose_access', uid: strangerUid, allowSaveAttachment: true, partId: strangerPartId}),
        verify: result => {
          assert.equal(result.ok, true);
          assert.equal(result.status, 'needs_confirmation');
          assert.equal(result.domain, 'mail_inbox');
          accessProposal = result;
        },
      },
    ],
  };

  const b1 = peer.sends.length;
  const m1 = await peer.send(peer.message(owner, '查收发件箱并把陌生发件人那封申请放行给我看'));
  await waitForOneBotTurn(channelDir, [m1]);
  assert(peer.sends.slice(b1).some(s => textOfSend(s).includes('陌生发件人测试')));
  assert(!report.fixtureError, report.fixtureError);
  report.cases.push('trusted_attachment_staging_and_untrusted_redaction');

  // Turn 2: Confirm access -> commit_access unlocks wrapped body + saves attachment -> propose_manage trash on trustedUid.
  active = {
    next: 0,
    reply: () => `已读取陌生邮件，请确认移入已删除：\n${manageProposal.previewText}`,
    steps: [
      {
        name: 'personal_confirmation',
        args: () => ({action: 'confirm', domain: 'mail_inbox', proposalId: accessProposal.proposalId, payloadHash: accessProposal.payloadHash}),
        verify: result => assert.equal(result.ok, true),
      },
      {
        name: 'email_inbox',
        args: () => ({action: 'commit_access', proposalId: accessProposal.proposalId}),
        verify: result => {
          assert.equal(result.ok, true);
          assert.match(result.bodyText, /^\[UNTRUSTED_EMAIL_CONTENT_START\]\nINBOX_INJECTION_ATTEMPT\n\[UNTRUSTED_EMAIL_CONTENT_END\]$/);
          assert.deepEqual(fs.readFileSync(result.savedAttachment.path), strangerBytes);
        },
      },
      {
        name: 'email_inbox',
        direct: true,
        args: {action: 'propose_manage', uid: trustedUid, op: 'trash'},
        verify: result => {
          assert.equal(result.ok, true);
          assert.equal(result.status, 'needs_confirmation');
          assert.equal(result.domain, 'mail_inbox');
          manageProposal = result;
        },
      },
    ],
  };

  const b2 = peer.sends.length;
  const m2 = await peer.send(peer.message(owner, '确认放行'));
  await waitForOneBotTurn(channelDir, [m2]);
  assert(peer.sends.slice(b2).some(s => textOfSend(s).includes('不执行物理 EXPUNGE')));
  assert(!report.fixtureError, report.fixtureError);
  report.cases.push('per_email_access_unlock_and_trash_preview');

  // Turn 3: Confirm trash -> commit_manage -> verify 已删除 & no EXPUNGE/CLOSE.
  active = {
    next: 0,
    reply: '已移入已删除箱。',
    steps: [
      {
        name: 'personal_confirmation',
        args: () => ({action: 'confirm', domain: 'mail_inbox', proposalId: manageProposal.proposalId, payloadHash: manageProposal.payloadHash}),
        verify: result => assert.equal(result.ok, true),
      },
      {
        name: 'email_inbox',
        args: () => ({action: 'commit_manage', proposalId: manageProposal.proposalId}),
        verify: result => {
          assert.equal(result.ok, true);
          assert.equal(result.targetFolder, '已删除');
          assert.equal(result.expunged, false);
        },
      },
    ],
  };

  const b3 = peer.sends.length;
  const m3 = await peer.send(peer.message(owner, '确认移动'));
  await waitForOneBotTurn(channelDir, [m3]);
  assert(peer.sends.slice(b3).some(s => textOfSend(s).includes('已移入已删除箱')));
  assert(!report.fixtureError, report.fixtureError);
  assert.equal(imap.expungeAttempted, false);
  assert.equal(imap.getMessages('已删除').length, 1);

  const traceRaw = fs.readFileSync(path.join(channelDir, 'trace-events.jsonl'), 'utf8');
  assert(traceRaw.includes('mail.inbox.attachment_saved'));
  assert(traceRaw.includes('mail.inbox.access_commit'));
  assert(traceRaw.includes('mail.inbox.manage_commit'));
  assert(!traceRaw.includes('INBOX_INJECTION_ATTEMPT'));
  assert(!traceRaw.includes(IMAP_TEST_PASS));
  report.cases.push('confirmed_trash_without_expunge_and_trace_redaction');

  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = report.fixtureError ?? error.message;
} finally {
  report.gatewayStopped = await gateway?.close() ?? null;
  if (report.gatewayStopped === false) {
    report.passed = false;
    report.error ??= 'Isolated Gateway did not stop gracefully';
  }
  await imap?.stop();
  server.closeAllConnections();
  await Promise.all([peer?.close(), new Promise(resolve => server.close(resolve))]);
  report.configSha256 = gateway?.configSha256;
  if (report.passed) fs.rmSync(root, {recursive: true, force: true});
  else { report.diagnosticsRoot = root; process.exitCode = 1; }
  report.fixtureCleaned = !fs.existsSync(root);
  fs.mkdirSync(path.dirname(out), {recursive: true});
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  console.log(JSON.stringify({passed: report.passed, cases: report.cases.length, error: report.error, evidence: out}));
}
