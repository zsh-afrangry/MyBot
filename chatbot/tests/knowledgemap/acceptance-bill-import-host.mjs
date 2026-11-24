// Isolated OpenClaw Gateway acceptance for Stage 2.2: knowledge_bill_import + bills_import natural confirmation.
// Uses deterministic loopback model, loopback OneBot HTTP/WS, disposable state/workspace, and isolated KnowledgeMap FastAPI/SQLite.
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kurumi-bills-import-host-'));
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
  boundary: 'Isolated Gateway, deterministic loopback model, loopback OneBot, isolated KnowledgeMap FastAPI/SQLite.',
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
function modelReply(body, tool, res, text = '账单导入验收完成。') {
  const choice = tool ? {
    role: 'assistant',
    content: null,
    tool_calls: [{id: 'call_' + report.requests, type: 'function', function: {name: tool[0], arguments: JSON.stringify(tool[1])}}],
  } : {role: 'assistant', content: text};
  const finish = tool ? 'tool_calls' : 'stop';
  const common = {id: 'chatcmpl-bills-import', created: 1, model: 'fixture'};
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
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    res.setHeader('content-type', 'application/json');
    assert(++report.requests <= 60, 'Unexpected model request budget exceeded');
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
    res.writeHead(400).end(JSON.stringify({error: {message: 'bills_import_host_fixture_failed'}}));
  }
});

let gateway, peer, km;
try {
  km = await startIsolatedKnowledgeMap(root);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  peer = await createOneBotPeer({token, botId: bot, subjects: [owner]});

  const billPath = path.join(kurumiSpace, 'monthly-2026-11.xlsx');
  fs.writeFileSync(billPath, makeBillXlsx([
    ['2026-11-10 12:15:00', '餐饮', '午饭', '支出', 'SECRET_NOTE_CHECK', '25.50'],
    ['2026-11-11 19:00:00', '隔离新增分类', '隔离新增子类', '支出', 'HOST_IMPORT_NOTE', '66.00'],
    ['2026-11-12 08:00:00', '餐饮', '午饭', '支出', '零元占位', '0'],
  ]));

  const plugins = ['kurumi-qq', 'kurumi-files', 'kurumi-knowledgemap', 'personal-confirmation'];
  const cfg = compileAccessConfig(withHostControl({
    models: {
      catalogRefresh: {enabled: false},
      providers: {
        fixture: {
          baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
          apiKey: 'synthetic',
          api: 'openai-completions',
          models: [{id: 'fixture', name: 'fixture', reasoning: false, input: ['text'], contextWindow: 262144, maxTokens: 1200}],
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
            alsoAllow: ['personal_confirmation', 'kurumi_files', 'knowledge_bills_get', 'knowledge_bill_import'],
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
  }, repo), ownerPolicy(owner));

  gateway = await startIsolatedGateway({
    repo,
    root: state,
    token,
    configure: () => cfg,
  });
  await gateway.ready();
  await waitForAcceptance(peer.connected, 'bills-import OneBot socket');
  scenarioProgress('gateway-ready');

  // Turn 1: Preview import -> creates pending bills_import proposal with dynamic tag & zero-amount skip summary.
  let proposal;
  active = {
    next: 0,
    reply: () => `预览完成：\n${proposal.previewText}`,
    steps: [
      {
        name: 'knowledge_bill_import',
        args: {action: 'preview', path: billPath},
        verify: result => {
          assert.equal(result.ok, true);
          assert.equal(result.status, 'needs_confirmation');
          assert.equal(result.domain, 'bills_import');
          assert.equal(result.summary.insertCount, 2);
          assert.equal(result.summary.zeroAmountSkippedCount, 1);
          assert.equal(result.summary.plannedNewTags.length, 2);
          assert.ok(!result.previewText.includes('SECRET_NOTE_CHECK'));
          proposal = result;
        },
      },
    ],
  };

  const b1 = peer.sends.length;
  const m1 = await peer.send(peer.message(owner, '导入工作区里的 11 月账单表格'));
  await waitForOneBotTurn(channelDir, [m1]);
  assert(peer.sends.slice(b1).some(s => textOfSend(s).includes('待导入：2 笔')));
  assert(!report.fixtureError, report.fixtureError);
  report.cases.push('bill_import_preview_and_frozen_presentation');

  // Turn 2: Owner confirms -> personal_confirmation(bills_import) -> commit -> re-preview skips all.
  active = {
    next: 0,
    reply: '已完成账单批量导入并跳过重复。',
    steps: [
      {
        name: 'personal_confirmation',
        args: () => ({action: 'confirm', domain: 'bills_import', proposalId: proposal.proposalId, payloadHash: proposal.payloadHash}),
        verify: result => {
          assert.equal(result.ok, true);
          assert.equal(result.status, 'authorized');
          assert.equal(result.domain, 'bills_import');
        },
      },
      {
        name: 'knowledge_bill_import',
        args: () => ({action: 'commit', proposalId: proposal.proposalId}),
        verify: result => {
          assert.equal(result.ok, true);
          assert.equal(result.inserted_count, 2);
          assert.equal(result.feedback.action, 'bill.import');
          assert.equal(result.feedback.status, 'succeeded');
        },
      },
      {
        name: 'knowledge_bill_import',
        direct: true,
        args: {action: 'preview', path: billPath},
        verify: result => {
          assert.equal(result.ok, true);
          assert.equal(result.status, 'already_imported');
          assert.equal(result.nothingToImport, true);
          assert.equal(result.skippedCount, 2);
        },
      },
    ],
  };

  const b2 = peer.sends.length;
  const m2 = await peer.send(peer.message(owner, '确认导入'));
  await waitForOneBotTurn(channelDir, [m2]);
  assert(peer.sends.slice(b2).some(s => textOfSend(s).includes('已完成账单批量导入')));
  assert(!report.fixtureError, report.fixtureError);

  const kmBills = await km.web('bills/');
  assert.equal(kmBills.total, 2);
  const kmTags = await km.client.request('/api/assistant/tags');
  assert(kmTags.items.some(t => t.name === '隔离新增分类' && t.type === 'category'));
  assert(kmTags.items.some(t => t.name === '隔离新增子类' && t.type === 'subcategory'));

  const traceEvents = fs.readFileSync(path.join(channelDir, 'trace-events.jsonl'), 'utf8');
  assert(traceEvents.includes('bills.import.commit'));
  assert(!traceEvents.includes('SECRET_NOTE_CHECK'));
  const kmTrace = fs.readFileSync(path.join(state, 'state/knowledgemap/trace.jsonl'), 'utf8');
  assert(kmTrace.includes('/api/assistant/bills/import/commit'));
  report.cases.push('bill_import_confirmed_commit_idempotency_and_trace_correlation');

  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = report.fixtureError ?? error.message;
} finally {
  if (await gateway?.close() === false) {
    report.passed = false;
    report.error ??= 'Isolated Gateway did not stop gracefully';
  }
  await km?.close();
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
