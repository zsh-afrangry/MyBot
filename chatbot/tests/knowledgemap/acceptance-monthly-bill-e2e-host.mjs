// End-to-end isolated host acceptance: IMAP email with bill .xlsx attachment -> save_attachment ->
// knowledge_bill_import(preview -> confirm -> commit) -> overlapping second .xlsx delta import ->
// email_inbox(propose_manage move -> confirm -> commit_manage) -> log-query cross-module trace verification.
import {FIXTURE_CONTEXT_WINDOW, readFixtureJson} from '../acceptance/fixture-model.mjs';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {once} from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import zlib from 'node:zlib';
import {compileAccessConfig} from '../../packages/access-control/config.js';
import {collectEvents} from '../../packages/log-query/index.js';
import {buildMessage} from '../../plugins/kurumi-mail/mime.js';
import {IMAP_CERT_FILE, IMAP_TEST_PASS, IMAP_TEST_USER, MockImapServer} from '../../plugins/kurumi-mail/test/mock-imap.js';
import {ownerPolicy} from '../access-control/fixtures.mjs';
import {withHostControl} from '../access-control/host-config.mjs';
import {startIsolatedGateway} from '../acceptance/isolated-gateway.mjs';
import {createOneBotPeer, textOfSend, waitForAcceptance, waitForOneBotTurn} from '../acceptance/onebot-peer.mjs';
import {scenarioProgress} from '../acceptance/scenario-lifecycle.mjs';
import {startIsolatedKnowledgeMap} from './isolated-api.mjs';

const [flag, out, ...extra] = process.argv.slice(2);
assert(flag === '--out' && path.isAbsolute(out ?? '') && !fs.existsSync(out) && !extra.length, 'Require a new absolute --out');
const repo = fileURLToPath(new URL('../../../', import.meta.url));
assert(path.resolve(out).startsWith(path.resolve(repo, 'test-output') + path.sep), 'Use test-output for evidence');

const escapeXml = s => String(s)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');

const colLetters = idx => {
  let s = '';
  let n = idx + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
};

function makeZip(entries) {
  const localParts = [];
  const cdParts = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const compressed = zlib.deflateRawSync(raw);
    const crc = zlib.crc32(raw) >>> 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(compressed.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    localParts.push(lh, nameBuf, compressed);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(compressed.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    cdParts.push(cd, nameBuf);
    offset += 30 + nameBuf.length + compressed.length;
  }
  const cdBuf = Buffer.concat(cdParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, cdBuf, eocd]);
}

function makeBillXlsx(dataRows) {
  const allRows = [['账单日期', '分类筛选', '记账分类', '收支类型', '备注', '金额'], ...dataRows];
  const rowsXml = allRows.map((row, rIdx) => {
    const rNum = rIdx + 1;
    const cellsXml = row.map((val, cIdx) => {
      if (val === null || val === undefined) return '';
      const ref = `${colLetters(cIdx)}${rNum}`;
      return typeof val === 'number'
        ? `<c r="${ref}" t="n" s="1"><v>${val}</v></c>`
        : `<c r="${ref}" t="inlineStr"><is><t>${escapeXml(val)}</t></is></c>`;
    }).join('');
    return `<row r="${rNum}">${cellsXml}</row>`;
  }).join('');

  return makeZip([
    {
      name: 'xl/workbook.xml',
      data: '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr date1904="0"/><sheets><sheet name="sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    },
    {
      name: 'xl/styles.xml',
      data: '<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd hh:mm:ss"/></numFmts><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="164"/></cellXfs></styleSheet>',
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      data: `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowsXml}</sheetData></worksheet>`,
    },
  ]);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kurumi-monthly-bill-e2e-'));
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
  boundary: 'Full isolated E2E: loopback TLS IMAP + OneBot + Gateway + KnowledgeMap FastAPI/SQLite + log-query.',
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
function modelReply(body, tool, res, text = '月度账单全链路验收完成。') {
  const choice = tool ? {
    role: 'assistant',
    content: null,
    tool_calls: [{id: 'call_' + report.requests, type: 'function', function: {name: tool[0], arguments: JSON.stringify(tool[1])}}],
  } : {role: 'assistant', content: text};
  const finish = tool ? 'tool_calls' : 'stop';
  const common = {id: 'chatcmpl-monthly-e2e', created: 1, model: 'fixture'};
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
    assert(++report.requests <= 90, 'Unexpected model request budget exceeded');
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
    res.writeHead(400).end(JSON.stringify({error: {message: 'monthly_bill_e2e_fixture_failed'}}));
  }
});

let gateway, peer, km, imap;
try {
  km = await startIsolatedKnowledgeMap(root);
  imap = new MockImapServer();

  const part1Xlsx = makeBillXlsx([
    ['2026-10-07 18:30:00', '餐饮', '晚餐', '支出', 'E2E_SHARED_NOTE', '35.00'],
    ['2026-10-05 12:00:00', '消费', '日用品', '支出', 'E2E_ONLY_PART1', '45.00'],
    ['2026-10-02 09:00:00', '餐饮', '晚餐', '支出', 'E2E_ZERO_ROW', '0'],
  ]);
  const part2Xlsx = makeBillXlsx([
    ['2026-10-12 20:00:00', '新收入分类', '奖金', '收入', 'E2E_DELTA_INC', '200.00'],
    ['2026-10-07 18:30:00', '餐饮', '晚餐', '支出', 'E2E_SHARED_NOTE', '35.00'],
  ]);

  const uid1 = imap.addMessage('INBOX', {
    rawBuffer: buildMessage({
      messageId: 'bill-export-1@export.example',
      from: {name: '记账导出', address: 'bills@export.example'},
      to: [IMAP_TEST_USER],
      subject: '账单导出 10.01-10.07',
      text: '请查收第一份账单。',
      attachments: [{filename: 'oct-1-7.xlsx', content: part1Xlsx}],
    }).raw,
  });
  const uid2 = imap.addMessage('INBOX', {
    rawBuffer: buildMessage({
      messageId: 'bill-export-2@export.example',
      from: {name: '记账导出', address: 'bills@export.example'},
      to: [IMAP_TEST_USER],
      subject: '账单导出 10.04-10.14',
      text: '请查收第二份重叠区间账单。',
      attachments: [{filename: 'oct-4-14.xlsx', content: part2Xlsx}],
    }).raw,
  });

  const imapAddr = await imap.start();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  peer = await createOneBotPeer({token, botId: bot, subjects: [owner]});

  const policy = ownerPolicy(owner);
  policy.subjects[0].mailSenders = ['bills@export.example'];

  const plugins = ['kurumi-qq', 'kurumi-files', 'kurumi-mail', 'kurumi-knowledgemap', 'personal-confirmation'];
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
      defaults: {workspace, systemAgent: {agentId: 'main'}, model: {primary: 'fixture/fixture'}},
      entries: {
        main: {
          workspace,
          model: {primary: 'fixture/fixture'},
          tools: {
            profile: 'messaging',
            alsoAllow: ['personal_confirmation', 'kurumi_files', 'email_inbox', 'knowledge_bills_get', 'knowledge_bill_import'],
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
        'kurumi-knowledgemap': {enabled: true, config: km.config},
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
  await waitForAcceptance(peer.connected, 'monthly-bill-e2e OneBot socket');
  scenarioProgress('gateway-ready');

  // Step 1: Receive mail 1 -> save_attachment -> knowledge_bill_import(preview)
  let saved1Path, p1, p2, moveProp;
  active = {
    next: 0,
    reply: () => `第 1 份账单预览完成：\n${p1.previewText}`,
    steps: [
      {
        name: 'email_inbox',
        args: {action: 'list', folder: 'INBOX'},
        verify: result => {
          assert.equal(result.ok, true);
          assert.equal(result.items.length, 2);
          assert.equal(result.items.every(x => x.trusted), true);
        },
      },
      {
        name: 'email_inbox',
        direct: true,
        args: {action: 'save_attachment', uid: uid1},
        verify: result => {
          assert.equal(result.ok, true);
          saved1Path = result.path;
        },
      },
      {
        name: 'knowledge_bill_import',
        args: () => ({action: 'preview', path: saved1Path}),
        verify: result => {
          assert.equal(result.ok, true);
          assert.equal(result.status, 'needs_confirmation');
          assert.equal(result.summary.insertCount, 2);
          assert.equal(result.summary.zeroAmountSkippedCount, 1);
          p1 = result;
        },
      },
    ],
  };
  await waitForOneBotTurn(channelDir, [await peer.send(peer.message(owner, '收信并预览第一份账单邮件附件'))]);
  assert(!report.fixtureError, report.fixtureError);
  report.cases.push('inbox_receive_save_attachment_and_preview_batch1');

  // Step 2: Confirm & commit batch 1, then save & preview overlapping mail 2.
  let saved2Path;
  active = {
    next: 0,
    reply: () => `第 1 份已导入 2 笔；第 2 份重叠账单预览：\n${p2.previewText}`,
    steps: [
      {
        name: 'personal_confirmation',
        args: () => ({action: 'confirm', domain: 'bills_import', proposalId: p1.proposalId, payloadHash: p1.payloadHash}),
        verify: result => assert.equal(result.ok, true),
      },
      {
        name: 'knowledge_bill_import',
        args: () => ({action: 'commit', proposalId: p1.proposalId}),
        verify: result => {
          assert.equal(result.ok, true);
          assert.equal(result.inserted_count, 2);
        },
      },
      {
        name: 'email_inbox',
        args: {action: 'save_attachment', uid: uid2},
        verify: result => {
          assert.equal(result.ok, true);
          saved2Path = result.path;
        },
      },
      {
        name: 'knowledge_bill_import',
        direct: true,
        args: () => ({action: 'preview', path: saved2Path}),
        verify: result => {
          assert.equal(result.ok, true);
          assert.equal(result.status, 'needs_confirmation');
          assert.equal(result.summary.insertCount, 1);
          assert.equal(result.summary.skippedCount, 1);
          assert.equal(result.summary.manualOverlapHintsCount, 0);
          p2 = result;
        },
      },
    ],
  };
  await waitForOneBotTurn(channelDir, [await peer.send(peer.message(owner, '确认导入第1份，再读取并预览第2份账单'))]);
  assert(!report.fixtureError, report.fixtureError);
  report.cases.push('commit_batch1_and_overlap_dedup_preview_batch2');

  // Step 3: Confirm & commit overlapping batch 2, then propose archiving mail 1 -> 账单归档.
  active = {
    next: 0,
    reply: () => `第 2 份增量导入 1 笔，请确认归档第一封邮件：\n${moveProp.previewText}`,
    steps: [
      {
        name: 'personal_confirmation',
        args: () => ({action: 'confirm', domain: 'bills_import', proposalId: p2.proposalId, payloadHash: p2.payloadHash}),
        verify: result => assert.equal(result.ok, true),
      },
      {
        name: 'knowledge_bill_import',
        args: () => ({action: 'commit', proposalId: p2.proposalId}),
        verify: result => {
          assert.equal(result.ok, true);
          assert.equal(result.inserted_count, 1);
          assert.equal(result.skipped_count, 1);
        },
      },
      {
        name: 'email_inbox',
        args: {action: 'propose_manage', uid: uid1, op: 'move', targetFolder: '账单归档'},
        verify: result => {
          assert.equal(result.ok, true);
          assert.equal(result.domain, 'mail_inbox');
          moveProp = result;
        },
      },
    ],
  };
  await waitForOneBotTurn(channelDir, [await peer.send(peer.message(owner, '确认增量导入，并把第一封账单邮件移入归档'))]);
  assert(!report.fixtureError, report.fixtureError);
  report.cases.push('commit_overlap_delta_and_propose_archive');

  // Step 4: Confirm archive move without EXPUNGE + verify final KM bills & cross-module log-query correlation.
  active = {
    next: 0,
    reply: '已完成归档与记账闭环。',
    steps: [
      {
        name: 'personal_confirmation',
        args: () => ({action: 'confirm', domain: 'mail_inbox', proposalId: moveProp.proposalId, payloadHash: moveProp.payloadHash}),
        verify: result => assert.equal(result.ok, true),
      },
      {
        name: 'email_inbox',
        args: () => ({action: 'commit_manage', proposalId: moveProp.proposalId}),
        verify: result => {
          assert.equal(result.ok, true);
          assert.equal(result.targetFolder, '账单归档');
          assert.equal(result.expunged, false);
        },
      },
    ],
  };
  const b4 = peer.sends.length;
  await waitForOneBotTurn(channelDir, [await peer.send(peer.message(owner, '确认归档'))]);
  assert(peer.sends.slice(b4).some(s => textOfSend(s).includes('已完成归档与记账闭环')));
  assert(!report.fixtureError, report.fixtureError);

  assert.equal((await km.web('bills/')).total, 3);
  assert.equal(imap.expungeAttempted, false);
  assert.equal(imap.getMessages('账单归档').length, 1);

  const collected = collectEvents({
    runtimeRoot: state,
    from: Date.now() - 3600_000,
    to: Date.now() + 60_000,
    sources: ['trace-events', 'knowledgemap'],
  });
  const kinds = new Set(collected.map(e => e.kind));
  assert(kinds.has('mail.inbox.attachment_saved'));
  assert(kinds.has('bills.import.commit'));
  assert(kinds.has('mail.inbox.manage_commit'));
  assert(kinds.has('business.api'));
  const serialized = JSON.stringify(collected);
  assert(!serialized.includes('E2E_SHARED_NOTE'));
  assert(!serialized.includes(IMAP_TEST_PASS));
  report.cases.push('confirmed_archive_and_cross_module_log_query_verified');

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
  report.knowledgeMapStopped = await km?.close() ?? null;
  if (report.knowledgeMapStopped === false) {
    report.passed = false;
    report.error ??= 'KnowledgeMap API did not stop cleanly';
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
