// Offline + isolated FastAPI/SQLite tests for knowledge_bill_import and bills_import confirmation domain.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import zlib from 'node:zlib';
import * as core from '../../packages/confirmation-core/dist/index.js';
import {createKnowledgeMapPlugin} from '../../plugins/kurumi-knowledgemap/index.js';
import {withAccess} from '../access-control/fixtures.mjs';
import {startIsolatedKnowledgeMap} from './isolated-api.mjs';

const owner = '365999865';
const sessionKey = `agent:main:kurumi-qq:direct:${owner}`;

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
  const allRows = [
    ['账单日期', '分类筛选', '记账分类', '收支类型', '备注', '金额'],
    ...dataRows,
  ];
  const rowsXml = allRows.map((row, rIdx) => {
    const rNum = rIdx + 1;
    const cellsXml = row.map((val, cIdx) => {
      if (val === null || val === undefined) return '';
      const ref = `${colLetters(cIdx)}${rNum}`;
      if (typeof val === 'number') {
        return `<c r="${ref}" t="n" s="1"><v>${val}</v></c>`;
      }
      if (typeof val === 'object' && val.num !== undefined) {
        return `<c r="${ref}" t="n"${val.style ? ` s="${val.style}"` : ''}><v>${val.num}</v></c>`;
      }
      return `<c r="${ref}" t="inlineStr"><is><t>${escapeXml(val)}</t></is></c>`;
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

function createHarness({client, stateRoot, fakeHome, kurumiSpace}) {
  const hooks = {};
  const factories = {};
  const services = [];
  const traces = [];
  const cfg = withAccess({
    channels: {'kurumi-qq': {ownerId: owner}},
    plugins: {
      entries: {
        'kurumi-files': {
          config: {
            homeDir: fakeHome,
            defaultWorkspace: kurumiSpace,
            t0Roots: [{path: kurumiSpace, label: '工作区'}],
            t1Roots: [{path: fakeHome, label: '主目录'}],
          },
        },
      },
    },
  });
  createKnowledgeMapPlugin({
    clientFactory: () => client,
    stateRoot,
    trace: event => traces.push(event),
  }).register({
    config: cfg,
    runtime: {state: {resolveStateDir: () => stateRoot}},
    on: (name, fn) => (hooks[name] ??= []).push(fn),
    registerService: svc => services.push(svc),
    registerTool: (factory, meta) => { factories[meta.name] = factory; },
  });
  for (const svc of services) svc.start?.();
  return {
    cfg,
    traces,
    stop: () => { for (const svc of [...services].reverse()) svc.stop?.(); },
    fire: (name, ev, c = {}) => { for (const fn of hooks[name] ?? []) fn(ev, c); },
    tool: (name, ctxOverride = {}) => factories[name].create({
      sessionKey,
      sessionId: 'sess-bill-import',
      senderIsOwner: true,
      requesterSenderId: owner,
      messageChannel: 'kurumi-qq',
      deliveryContext: {channel: 'kurumi-qq', to: `user:${owner}`, accountId: 'default'},
      getRuntimeConfig: () => cfg,
      assertInvocationCurrent() {},
      ...ctxOverride,
    }),
  };
}

const msgEvent = (text, messageId, nowMs) => ({
  ctx: {
    RawBody: text,
    MessageSid: messageId,
    Timestamp: nowMs,
    ChatType: 'direct',
    CommandAuthorized: true,
    SenderId: owner,
    SessionKey: sessionKey,
    OriginatingChannel: 'kurumi-qq',
    OriginatingTo: `user:${owner}`,
  },
});

const inboundFor = (text, messageId, nowMs) => ({
  channel: 'kurumi-qq',
  accountId: 'default',
  senderId: owner,
  conversationId: `user:${owner}`,
  sessionKey,
  messageId,
  content: text,
  timestamp: nowMs,
  isGroup: false,
  senderIsOwner: true,
});

const execJson = async (tool, args, callId = 'call-1') =>
  JSON.parse((await tool.execute(callId, args)).content[0].text);

test('knowledge_bill_import previews, confirms, commits idempotently, detects file tampering and recovers unknown commits', {timeout: 30000}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'km-bill-import-unit-'));
  const stateRoot = path.join(root, 'state');
  const fakeHome = path.join(root, 'fake-home');
  const kurumiSpace = path.join(fakeHome, 'kurumi-space');
  const downloads = path.join(fakeHome, '下载');
  const sshDir = path.join(fakeHome, '.ssh');
  for (const d of [stateRoot, kurumiSpace, downloads, sshDir]) fs.mkdirSync(d, {recursive: true});

  let km;
  let harness;
  t.after(async () => {
    core.clearNaturalConfirmationRequest(sessionKey);
    harness?.stop();
    if (km) await km.close();
    fs.rmSync(root, {recursive: true, force: true});
  });

  const confirmDelivered = (pv, proposal, prevText, facts) => {
    assert.equal(core.prepareConfirmationPreview(pv, {domain: 'bills_import', proposalId: proposal.proposalId, payloadHash: proposal.payloadHash}, prevText, facts), true);
    core.recordConfirmationDelivery({
      accountId: 'default',
      conversationId: pv.conversationId,
      sourceMessageId: pv.messageId,
      messageId: 'pv-' + proposal.proposalId,
      text: prevText,
    });
    const cfNow = Math.max(Date.now() + 2000, pv.timestamp + 2000);
    const cf = inboundFor('确认导入', 'm-conf-' + proposal.proposalId.slice(0, 8), cfNow);
    harness.fire('reply_dispatch', msgEvent(cf.content, cf.messageId, cfNow));
    core.captureNaturalConfirmationRequest(cf);
    const res = core.confirmNaturalProposal(cf, {domain: 'bills_import', proposalId: proposal.proposalId, payloadHash: proposal.payloadHash}, cfNow);
    assert.equal(res.ok, true, JSON.stringify(res));
  };

  km = await startIsolatedKnowledgeMap(root);

  // Create an overlapping manual bill to test manual_overlap_hints.
  const tagsBefore = await km.client.request('/api/assistant/tags');
  const existingCat = tagsBefore.items.find(t => t.type === 'category');
  assert.ok(existingCat, 'Fixture DB should contain seeded category tag');

  // Seed one manual bill matching 2026-11-10 支出 32.50.
  await km.web('bills/', 'POST', {
    record_type: '支出',
    expense_date: '2026-11-10',
    amount: '32.50',
    category_id: existingCat.id,
    note: '手工测试记录',
  });

  const billPath = path.join(kurumiSpace, 'nov-export.xlsx');
  // Excel serial 46336.5 = 2026-11-10 12:00:00
  const xlsx1 = makeBillXlsx([
    [{num: 46336.5, style: 1}, existingCat.name, existingCat.name, '支出', '合城面馆', {num: 32.5}],
    ['2026-11-11 08:30:00', '新大类A', '新子类B', '支出', 'SYNTH_NOTE_1', '18.00'],
    ['2026-11-11 08:30:00', '新大类A', '新子类B', '支出', 'SYNTH_NOTE_1', '18.00'], // intentional identical row
    ['2026-11-12 09:00:00', existingCat.name, existingCat.name, '支出', '零元占位', '0'], // zero-amount skipped
    ['2026-11-13 18:15:00', '新收入类C', '新收入类C', '收入', 'SYNTH_INC_1', '100.00'],
  ]);
  fs.writeFileSync(billPath, xlsx1);

  harness = createHarness({client: km.client, stateRoot, fakeHome, kurumiSpace});

  // 1. Preview discovers dynamic tags, zero-amount skips, and manual overlap without leaking notes into presentationFacts.
  const now1 = Date.now();
  const ev1 = inboundFor('帮我导入这个月度账单', 'm-prev-1', now1);
  harness.fire('reply_dispatch', msgEvent(ev1.content, ev1.messageId, now1));
  const p1 = await execJson(harness.tool('knowledge_bill_import'), {action: 'preview', path: billPath}, 'call-p1');
  assert.equal(p1.ok, true, JSON.stringify(p1));
  assert.equal(p1.status, 'needs_confirmation');
  assert.equal(p1.domain, 'bills_import');
  assert.equal(p1.summary.totalSourceRows, 5);
  assert.equal(p1.summary.zeroAmountSkippedCount, 1);
  assert.equal(p1.summary.insertCount, 4);
  assert.equal(p1.summary.totalExpense, '68.50');
  assert.equal(p1.summary.totalIncome, '100.00');
  assert.equal(p1.summary.plannedNewTags.length, 3);
  assert.equal(p1.summary.manualOverlapHintsCount, 1);
  assert.equal(p1.presentationFacts.join('\n'), p1.previewText);
  assert.ok(!p1.previewText.includes('SYNTH_NOTE_1'));

  // 2. Unapproved commit fails closed without touching KM.
  const unapproved = await execJson(harness.tool('knowledge_bill_import'), {action: 'commit', proposalId: p1.proposalId}, 'call-unapproved');
  assert.equal(unapproved.ok, false);
  assert.equal(unapproved.error.code, 'approval_required');
  assert.equal((await km.web('bills/')).total, 1);

  // 3. Approve p1 in second message, then tamper with file BEFORE commit -> refused BEFORE consuming grant!
  confirmDelivered(ev1, p1, p1.previewText, p1.presentationFacts);

  const tampered = makeBillXlsx([
    ['2026-11-11 08:30:00', '新大类A', '新子类B', '支出', '篡改', '999.00'],
  ]);
  fs.writeFileSync(billPath, tampered);
  const afterTamper = await execJson(harness.tool('knowledge_bill_import'), {action: 'commit', proposalId: p1.proposalId}, 'call-tampered');
  assert.equal(afterTamper.ok, false);
  assert.equal(afterTamper.error.code, 'bill_import_file_changed');
  assert.equal((await km.web('bills/')).total, 1);

  // Restore original bytes -> grant was NOT consumed by the failed verification, so commit succeeds now!
  fs.writeFileSync(billPath, xlsx1);
  const committed = await execJson(harness.tool('knowledge_bill_import'), {action: 'commit', proposalId: p1.proposalId}, 'call-commit-1');
  assert.equal(committed.ok, true, JSON.stringify(committed));
  assert.equal(committed.inserted_count, 4);
  assert.equal(committed.feedback.action, 'bill.import');
  assert.equal(committed.feedback.status, 'succeeded');
  assert.equal((await km.web('bills/')).total, 5);
  assert.equal(harness.traces.some(e => e.kind === 'bills.import.commit' && e.correlation.proposalId === p1.proposalId), true);
  assert.ok(!JSON.stringify(harness.traces).includes('SYNTH_NOTE_1'));

  // 4. Re-preview same file reports already_imported cleanly without creating a pending proposal.
  const now3 = Date.now() + 2000;
  const ev3 = inboundFor('再看一遍这个表格', 'm-prev-2', now3);
  harness.fire('reply_dispatch', msgEvent(ev3.content, ev3.messageId, now3));
  const rePrev = await execJson(harness.tool('knowledge_bill_import'), {action: 'preview', path: billPath}, 'call-p2');
  assert.equal(rePrev.ok, true);
  assert.equal(rePrev.status, 'already_imported');
  assert.equal(rePrev.nothingToImport, true);
  assert.equal(rePrev.skippedCount, 4);
  assert.equal(rePrev.zeroAmountSkippedCount, 1);

  // 5. Lost POST response recovery via action=status + request_key receipt lookup.
  const billPath2 = path.join(downloads, 'dec-export.xlsx');
  fs.writeFileSync(billPath2, makeBillXlsx([
    ['2026-12-01 10:00:00', '新大类A', '新子类B', '支出', 'SYNTH_DEC_1', '55.00'],
  ]));
  const now4 = Date.now() + 3000;
  const ev4 = inboundFor('预览12月账单', 'm-prev-3', now4);
  harness.fire('reply_dispatch', msgEvent(ev4.content, ev4.messageId, now4));
  const p2 = await execJson(harness.tool('knowledge_bill_import'), {action: 'preview', path: billPath2}, 'call-p3');
  assert.equal(p2.status, 'needs_confirmation');
  confirmDelivered(ev4, p2, p2.previewText, p2.presentationFacts);

  const origFetch = km.client.fetchImpl;
  let dropCommitResponse = true;
  km.client.fetchImpl = async (...args) => {
    const resp = await origFetch(...args);
    if (dropCommitResponse && String(args[0]).endsWith('/bills/import/commit')) {
      dropCommitResponse = false;
      await resp.body?.cancel();
      throw Error('Simulated network drop after commit');
    }
    return resp;
  };
  const lost = await execJson(harness.tool('knowledge_bill_import'), {action: 'commit', proposalId: p2.proposalId}, 'call-lost');
  assert.equal(lost.ok, false);
  assert.equal(lost.error.code, 'write_result_unknown');
  assert.equal(lost.feedback.status, 'unknown');

  const recovered = await execJson(harness.tool('knowledge_bill_import'), {action: 'status', proposalId: p2.proposalId}, 'call-recover');
  assert.equal(recovered.ok, true);
  assert.equal(recovered.status, 'committed');
  assert.equal(recovered.feedback.status, 'succeeded');
  assert.equal(recovered.batch.inserted_count, 1);

  const batches = await execJson(harness.tool('knowledge_bill_import'), {action: 'batches', limit: 10}, 'call-batches');
  assert.equal(batches.ok, true);
  assert.equal(batches.items.length, 2);

  // 6. Redlines, symlinks, and non-owner callers fail closed.
  const sshKey = path.join(sshDir, 'id_ed25519');
  fs.writeFileSync(sshKey, 'KEY');
  const symlinkPath = path.join(downloads, 'escape.xlsx');
  fs.symlinkSync(sshKey, symlinkPath);
  const symRes = await execJson(harness.tool('knowledge_bill_import'), {action: 'preview', path: symlinkPath}, 'call-sym');
  assert.equal(symRes.ok, false);
  assert.equal(symRes.error.code, 'files_redline_denied');

  const memberTool = harness.tool('knowledge_bill_import', {senderIsOwner: false, requesterSenderId: '100003'});
  const memberRes = await execJson(memberTool, {action: 'batches'}, 'call-member');
  assert.equal(memberRes.ok, false);
  assert.equal(memberRes.error.code, 'forbidden_context');
});

test('knowledge_bill_import deduplicates overlapping reverse-chronological date ranges cleanly', {timeout: 30000}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'km-bill-overlap-'));
  const stateRoot = path.join(root, 'state');
  const fakeHome = path.join(root, 'fake-home');
  const kurumiSpace = path.join(fakeHome, 'kurumi-space');
  for (const d of [stateRoot, kurumiSpace]) fs.mkdirSync(d, {recursive: true});

  let km;
  let harness;
  t.after(async () => {
    core.clearNaturalConfirmationRequest(sessionKey);
    harness?.stop();
    if (km) await km.close();
    fs.rmSync(root, {recursive: true, force: true});
  });

  km = await startIsolatedKnowledgeMap(root);
  harness = createHarness({client: km.client, stateRoot, fakeHome, kurumiSpace});

  // Reverse-chronological rows matching real app export order, with an overlapping Oct 4-7 slice.
  const oct1to7 = path.join(kurumiSpace, 'oct1to7.xlsx');
  fs.writeFileSync(oct1to7, makeBillXlsx([
    ['2026-10-07 18:00:00', '餐饮', '午饭', '支出', 'OVL_SHARED_1', '20.00'],
    ['2026-10-05 09:00:00', '交通', '地铁', '支出', 'OVL_SHARED_2', '4.00'],
    ['2026-10-01 12:00:00', '餐饮', '午饭', '支出', 'OVL_EARLY_ONLY', '15.00'],
  ]));
  const oct4to14 = path.join(kurumiSpace, 'oct4to14.xlsx');
  fs.writeFileSync(oct4to14, makeBillXlsx([
    ['2026-10-14 20:00:00', '新重叠分类', '新子类', '支出', 'OVL_LATE_ONLY', '60.00'],
    ['2026-10-07 18:00:00', '餐饮', '午饭', '支出', 'OVL_SHARED_1', '20.00'],
    ['2026-10-05 09:00:00', '交通', '地铁', '支出', 'OVL_SHARED_2', '4.00'],
  ]));

  const commitBatch = async (filePath, suffix) => {
    const tPrev = Date.now();
    const pv = inboundFor('预览', 'm-ovl-p-' + suffix, tPrev);
    harness.fire('reply_dispatch', msgEvent(pv.content, pv.messageId, tPrev));
    const prev = await execJson(harness.tool('knowledge_bill_import'), {action: 'preview', path: filePath}, 'c-p-' + suffix);
    assert.equal(prev.ok, true, JSON.stringify(prev));
    assert.equal(prev.status, 'needs_confirmation');
    assert.equal(core.prepareConfirmationPreview(pv, {domain: 'bills_import', proposalId: prev.proposalId, payloadHash: prev.payloadHash}, prev.previewText, prev.presentationFacts), true);
    core.recordConfirmationDelivery({accountId: 'default', conversationId: pv.conversationId, sourceMessageId: pv.messageId, messageId: 'pv-ovl-' + suffix, text: prev.previewText});
    const tConf = Math.max(Date.now() + 2000, tPrev + 2000);
    const cf = inboundFor('确认', 'm-ovl-c-' + suffix, tConf);
    harness.fire('reply_dispatch', msgEvent(cf.content, cf.messageId, tConf));
    core.captureNaturalConfirmationRequest(cf);
    assert.equal(core.confirmNaturalProposal(cf, {domain: 'bills_import', proposalId: prev.proposalId, payloadHash: prev.payloadHash}, tConf).ok, true);
    const committed = await execJson(harness.tool('knowledge_bill_import'), {action: 'commit', proposalId: prev.proposalId}, 'c-c-' + suffix);
    assert.equal(committed.ok, true, JSON.stringify(committed));
    return {prev, committed};
  };

  const b1 = await commitBatch(oct1to7, '1');
  assert.equal(b1.committed.inserted_count, 3);
  assert.equal((await km.web('bills/')).total, 3);

  const b2 = await commitBatch(oct4to14, '2');
  assert.equal(b2.prev.summary.insertCount, 1);
  assert.equal(b2.prev.summary.skippedCount, 2);
  assert.equal(b2.prev.summary.manualOverlapHintsCount, 0);
  assert.equal(b2.prev.summary.plannedNewTags.length, 2);
  assert.equal(b2.committed.inserted_count, 1);
  assert.equal(b2.committed.skipped_count, 2);
  assert.equal((await km.web('bills/')).total, 4);
});
