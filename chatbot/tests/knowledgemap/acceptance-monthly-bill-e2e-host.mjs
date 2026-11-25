// End-to-end isolated host acceptance: IMAP email with bill .xlsx attachment -> save_attachment ->
// knowledge_bill_import(preview -> confirm -> commit) -> overlapping second .xlsx delta import ->
// email_inbox(propose_manage move -> confirm -> commit_manage) -> log-query cross-module trace verification.
// --model calls the configured paid model using synthetic data; no production state, real QQ or real mail.
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
import {redactText} from '../../packages/observability/index.js';
import {buildMessage} from '../../plugins/kurumi-mail/mime.js';
import {IMAP_CERT_FILE, IMAP_TEST_PASS, IMAP_TEST_USER, MockImapServer} from '../../plugins/kurumi-mail/test/mock-imap.js';
import {ownerPolicy} from '../access-control/fixtures.mjs';
import {withHostControl} from '../access-control/host-config.mjs';
import {startIsolatedGateway} from '../acceptance/isolated-gateway.mjs';
import {configuredModel, observeToolResults, syntheticPersona} from '../acceptance/configured-dialogue.mjs';
import {captureDialogueEvidence} from '../acceptance/dialogue-evidence.mjs';
import {assertionDiagnostics} from '../acceptance/assertion-diagnostics.mjs';
import {createOneBotPeer, textOfSend, waitForAcceptance, waitForOneBotTurn} from '../acceptance/onebot-peer.mjs';
import {scenarioProgress, scenarioSignal} from '../acceptance/scenario-lifecycle.mjs';
import {startIsolatedKnowledgeMap} from './isolated-api.mjs';

const [flag, out, ...extra] = process.argv.slice(2);
const realModel = extra.length === 1 && extra[0] === '--model';
assert(flag === '--out' && path.isAbsolute(out ?? '') && !fs.existsSync(out) && (!extra.length || realModel), 'Require a new absolute --out');
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
  cognition: realModel ? 'configured-provider' : 'deterministic fixture',
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

let active, upstream, failureStep, currentTurn;
const observeResults = observeToolResults();
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
    if (realModel) {
      observeResults(body.messages ?? [], active.results);
      const response = await fetch(upstream.url, {method: 'POST', redirect: 'error',
        headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + upstream.key},
        signal: AbortSignal.timeout(60000), body: JSON.stringify({...body, model: upstream.modelId, max_tokens: 2000, temperature: 0})});
      if (!response.ok) throw Error('Configured model HTTP ' + response.status);
      res.writeHead(200, {'Content-Type': response.headers.get('content-type') ?? 'application/json'});
      for await (const chunk of response.body) res.write(chunk);
      return res.end();
    }
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
    report.fixtureError = redactText(error.message);
    res.writeHead(400).end(JSON.stringify({error: {message: 'monthly_bill_e2e_fixture_failed'}}));
  }
});

let gateway, peer, km, imap;
try {
  scenarioProgress('gateway-start', 'started', 'environment');
  failureStep = 'gateway-start';
  if (realModel) {upstream = configuredModel(repo); report.primaryModel = upstream.primary;}
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
          models: [{id: 'fixture', name: 'fixture', reasoning: false, input: ['text'], contextWindow: realModel ? 128000 : FIXTURE_CONTEXT_WINDOW, maxTokens: 1200}],
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

  if (realModel) syntheticPersona({repo, root: state, config: cfg, policy,
    userFile: '这是一次虚构邮件与账单场景。时区为 Asia/Shanghai。'});

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
  await assert.rejects(gateway.call('kurumi-qq.testInbound', {}, 3000), /unknown method|not found/iu);
  scenarioProgress('gateway-start', 'passed', 'environment');
  failureStep = undefined;

  if (realModel) {
    let p1, p2, archive;
    const result = (results, tool, predicate = () => true) => {
      const found = results.find(row => row.tool === tool && predicate(row.value));
      assert(found, 'Missing expected ' + tool + ' result');
      return found;
    };
    const turn = async (label, message, verify) => {
      scenarioSignal.throwIfAborted();
      failureStep = label;
      scenarioProgress(label, 'started', 'check');
      active = {results: []};
      const startedAt = Date.now(), before = peer.sends.length;
      const event = peer.message(owner, message), inbound = await peer.send(event);
      currentTurn = {startedAt, messageIds: [String(event.message_id)]};
      await waitForOneBotTurn(channelDir, [inbound], {timeoutMs: 180000, check() {
        scenarioSignal.throwIfAborted(); peer.check(); assert(!report.fixtureError, report.fixtureError);
      }});
      const sends = peer.sends.slice(before);
      assert(sends.length && sends.every(send => send.accepted), 'No accepted loopback reply');
      const dialogue = captureDialogueEvidence({root: state, owner, startedAt, finishedAt: Date.now(), messageIds: currentTurn.messageIds});
      currentTurn.runId = dialogue.runId;
      const events = collectEvents({runtimeRoot: state, from: startedAt, to: Date.now() + 1000,
        sources: ['trace-events', 'knowledgemap']}).filter(row => row.correlation?.runId === dialogue.runId);
      await verify({results: active.results, sends, events});
      report.cases.push({label, passed: true, receiptCount: sends.length, dialogue,
        events: events.map(row => ({kind: row.kind, at: row.at,
          ...Object.fromEntries(['runId', 'toolCallId', 'proposalId', 'businessId']
            .filter(key => row.correlation?.[key] != null).map(key => [key, row.correlation[key]])),
          ...Object.fromEntries(['uid', 'uidValidity', 'partId', 'status', 'method']
            .filter(key => row.data?.[key] != null).map(key => [key, row.data[key]]))}))});
      active = undefined; currentTurn = undefined; failureStep = undefined;
      scenarioProgress(label, 'passed', 'check');
    };
    const totals = async expected => assert.equal((await km.web('bills/')).total, expected);
    const expectPreview = (results, events, uid, inserted, skipped) => {
      const attachment = result(results, 'email_inbox', value => value?.action === 'save_attachment' && value.uid === uid);
      const preview = result(results, 'knowledge_bill_import', value => value?.status === 'needs_confirmation');
      assert.equal(preview.args.path, attachment.value.path, 'Preview did not use the saved attachment');
      assert.equal(preview.value.summary.insertCount, inserted);
      assert.equal(preview.value.summary.skippedCount, skipped);
      assert(events.some(row => row.kind === 'mail.inbox.attachment_saved' && row.data?.uid === uid));
      assert(events.some(row => row.kind === 'business.api'));
      return preview.value;
    };
    const expectCommit = (results, events, proposal, inserted) => {
      const commit = result(results, 'knowledge_bill_import', value => value?.proposalId === proposal.proposalId && value?.inserted_count === inserted);
      assert.equal(commit.value.ok, true);
      assert(events.some(row => row.kind === 'bills.import.commit' && row.correlation?.proposalId === proposal.proposalId));
    };

    await turn('mail-first-preview', '请查收来自 bills@export.example、日期为10月1日至7日的账单邮件，保存附件并预览导入，先不要提交。',
      async ({results, sends, events}) => {
        p1 = expectPreview(results, events, uid1, 2, 0);
        assert(sends.some(send => textOfSend(send).includes('oct-1-7.xlsx')), 'Preview did not identify the first attachment');
        await totals(0);
      });
    await turn('mail-first-confirm', '确认导入刚才预览的第一份账单。', async ({results, events}) => {
      expectCommit(results, events, p1, 2); await totals(2);
    });
    await turn('mail-overlap-preview', '请保存并预览另一封10月4日至14日账单邮件的附件，先不要提交。',
      async ({results, sends, events}) => {
        p2 = expectPreview(results, events, uid2, 1, 1);
        assert(sends.some(send => textOfSend(send).includes('oct-4-14.xlsx')), 'Preview did not identify the second attachment');
        await totals(2);
      });
    await turn('mail-overlap-confirm', '确认导入刚才预览的第二份账单。', async ({results, events}) => {
      expectCommit(results, events, p2, 1); await totals(3);
    });
    await turn('mail-repeat-preview', '请再次用刚才第二份附件检查是否还有账单需要导入，只做预览。', async ({results}) => {
      const repeated = result(results, 'knowledge_bill_import', value => value?.status === 'already_imported');
      assert.equal(repeated.value.nothingToImport, true);
      await totals(3);
    });
    await turn('mail-archive-preview', '请把第一封10月1日至7日的账单邮件移到“账单归档”，先给我预览。', async ({results}) => {
      archive = result(results, 'email_inbox', value => value?.domain === 'mail_inbox' && value?.proposalId).value;
      assert.equal(imap.getMessages('账单归档').length, 0);
    });
    await turn('mail-archive-confirm', '确认移动刚才的第一封账单邮件。', async ({results, events}) => {
      const move = result(results, 'email_inbox', value => value?.action === 'commit_manage' && value?.proposalId === archive.proposalId);
      assert.equal(move.value.expunged, false);
      assert(events.some(row => row.kind === 'mail.inbox.manage_commit' && row.correlation?.proposalId === archive.proposalId
        && row.data?.uid === uid1));
      assert.equal(imap.getMessages('账单归档').length, 1); assert.equal(imap.expungeAttempted, false);
      await totals(3);
    });
  } else {
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
  }

  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = report.fixtureError ?? redactText(String(error.message));
  report.failureDetails = assertionDiagnostics(error);
  report.blocked = failureStep === 'gateway-start';
  if (currentTurn && !currentTurn.runId) {
    try {currentTurn.runId = captureDialogueEvidence({root: state, owner, ...currentTurn, finishedAt: Date.now()}).runId;} catch {}
  }
  if (currentTurn?.runId) {
    const from = new Date(currentTurn.startedAt).toISOString(), to = new Date(Date.now() + 1000).toISOString();
    report.failureReference = {status: 'available', kind: 'log-query', runtimeRoot: state,
      runId: currentTurn.runId, messageIds: currentTurn.messageIds, command: process.execPath,
      args: [path.join(repo, 'chatbot/scripts/log-query.mjs'), '--runtime-root', state, '--snowluma-root', state,
        '--from', from, '--to', to, '--run-id=' + currentTurn.runId,
        '--source', 'openclaw-session', '--source', 'trace-events', '--source', 'knowledgemap', '--no-text', '--json']};
  }
  if (failureStep) scenarioProgress(failureStep, 'failed', report.blocked ? 'environment' : 'check');
} finally {
  scenarioProgress('fixture-cleanup', 'started', 'cleanup');
  const stop = async (resource, close) => {
    if (!resource) return null;
    try {return (await close()) !== false;} catch {return false;}
  };
  report.gatewayStopped = await stop(gateway, () => gateway.close());
  report.knowledgeMapStopped = await stop(km, () => km.close());
  report.imapStopped = await stop(imap, () => imap.stop());
  report.peerStopped = await stop(peer, () => peer.close());
  report.modelStopped = server.listening ? await stop(server, () => new Promise((resolve, reject) => {
    server.closeAllConnections(); server.close(error => error ? reject(error) : resolve(true));
  })) : null;
  if ([report.gatewayStopped, report.knowledgeMapStopped, report.imapStopped, report.peerStopped, report.modelStopped].includes(false)) {
    report.passed = false; report.error ??= 'Isolated service did not stop cleanly';
  }
  report.configSha256 = gateway?.configSha256;
  if (report.passed) {try {fs.rmSync(root, {recursive: true, force: true});} catch {}}
  report.fixtureCleaned = !fs.existsSync(root);
  if (!report.fixtureCleaned) {
    report.passed = false; report.error ??= 'Isolated fixture was retained';
    report.diagnosticsRoot = root; process.exitCode = 1;
  }
  scenarioProgress('fixture-cleanup', report.fixtureCleaned ? 'passed' : 'failed', 'cleanup');
  fs.mkdirSync(path.dirname(out), {recursive: true});
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  console.log(JSON.stringify({passed: report.passed, cases: report.cases.length, error: report.error, evidence: out}));
}
