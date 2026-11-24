// Offline unit and boundary tests for @kurumi/office-reader and kurumi_files(read_structured).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after, test} from 'node:test';
import zlib from 'node:zlib';
import {
  OfficeReaderError,
  formatExcelSerial,
  parseBillExportXlsx,
  readStructuredFile,
} from '../../packages/office-reader/index.js';
import {createFilesService} from '../../plugins/kurumi-files/service.js';
import {FilesStore} from '../../plugins/kurumi-files/store.js';
import {ScopedLeaseStore} from '../../packages/scoped-lease/index.js';
import {ownerPolicy, context} from '../access-control/fixtures.mjs';
import * as core from '../../packages/confirmation-core/dist/index.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kurumi-office-test-'));
after(() => fs.rmSync(tmpRoot, {recursive: true, force: true}));

function makeZip(entries, {encryptIndex = -1, corruptCrcIndex = -1, overrideUncompressedSize = null} = {}) {
  const localParts = [];
  const cdParts = [];
  let offset = 0;

  entries.forEach((entry, idx) => {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const compressed = entry.store ? raw : zlib.deflateRawSync(raw);
    const method = entry.store ? 0 : 8;
    const flags = idx === encryptIndex ? 0x01 : 0x00;
    let crc = zlib.crc32(raw) >>> 0;
    if (idx === corruptCrcIndex) crc = (crc ^ 0xffffffff) >>> 0;
    const uncompSize = overrideUncompressedSize?.[idx] ?? raw.length;

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(flags, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(compressed.length, 18);
    lh.writeUInt32LE(uncompSize, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    localParts.push(lh, nameBuf, compressed);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(flags, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(compressed.length, 20);
    cd.writeUInt32LE(uncompSize, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt32LE(offset, 42);
    cdParts.push(cd, nameBuf);

    offset += 30 + nameBuf.length + compressed.length;
  });

  const cdBuf = Buffer.concat(cdParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, cdBuf, eocd]);
}

function escapeXml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function colLetters(idx) {
  let s = '';
  let n = idx + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function buildXlsx({sheets, sharedStrings = [], date1904 = false, customFormats = []}) {
  const sstXml = `<?xml version="1.0" encoding="UTF-8"?>`
    + `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
    + sharedStrings.map(item => {
      if (typeof item === 'string') return `<si><t>${escapeXml(item)}</t></si>`;
      return `<si><t>${escapeXml(item.text)}</t><rPh sb="0" eb="1"><t>${escapeXml(item.phonetic)}</t></rPh></si>`;
    }).join('')
    + `</sst>`;

  const stylesXml = `<?xml version="1.0" encoding="UTF-8"?>`
    + `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
    + `<numFmts count="${customFormats.length}">`
    + customFormats.map(f => `<numFmt numFmtId="${f.id}" formatCode="${escapeXml(f.code)}"/>`).join('')
    + `</numFmts>`
    + `<cellXfs count="${1 + customFormats.length}">`
    + `<xf numFmtId="0"/>`
    + customFormats.map(f => `<xf numFmtId="${f.id}"/>`).join('')
    + `</cellXfs></styleSheet>`;

  const wbXml = `<?xml version="1.0" encoding="UTF-8"?>`
    + `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`
    + `<workbookPr date1904="${date1904 ? '1' : '0'}"/>`
    + `<sheets>`
    + sheets.map((s, i) => `<sheet name="${escapeXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')
    + `</sheets></workbook>`;

  const relsXml = `<?xml version="1.0" encoding="UTF-8"?>`
    + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + sheets.map((_s, i) => `<Relationship Id="rId${i + 1}" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
    + `</Relationships>`;

  const entries = [
    {name: 'xl/workbook.xml', data: wbXml},
    {name: 'xl/_rels/workbook.xml.rels', data: relsXml},
    {name: 'xl/sharedStrings.xml', data: sstXml},
    {name: 'xl/styles.xml', data: stylesXml},
  ];

  sheets.forEach((s, i) => {
    const rowsXml = s.rows.map((cells, rIdx) => {
      const rNum = rIdx + 1;
      const cellsXml = cells.map((cell, cIdx) => {
        if (cell === null || cell === undefined) return '';
        const ref = `${colLetters(cIdx)}${rNum}`;
        if (typeof cell === 'object' && cell.type === 's') {
          return `<c r="${ref}" t="s"><v>${cell.idx}</v></c>`;
        }
        if (typeof cell === 'object' && cell.type === 'n') {
          const styleAttr = cell.s !== undefined ? ` s="${cell.s}"` : '';
          return `<c r="${ref}" t="n"${styleAttr}><v>${cell.v}</v></c>`;
        }
        if (typeof cell === 'object' && cell.type === 'b') {
          return `<c r="${ref}" t="b"><v>${cell.v ? '1' : '0'}</v></c>`;
        }
        return `<c r="${ref}" t="inlineStr"><is><t>${escapeXml(String(cell))}</t></is></c>`;
      }).join('');
      return `<row r="${rNum}">${cellsXml}</row>`;
    }).join('');
    entries.push({
      name: `xl/worksheets/sheet${i + 1}.xml`,
      data: `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowsXml}</sheetData></worksheet>`,
    });
  });

  return makeZip(entries);
}

test('CSV/TSV parser handles UTF-8 BOM, quoted newlines, GB18030, query, and pagination', () => {
  const csvUtf8 = Buffer.from('\uFEFF日期,备注,金额\r\n2026-11-01,"第一行\n含""引号""",12.50\r\n2026-11-02,打车,30\r\n', 'utf8');
  const res = readStructuredFile(csvUtf8, {filename: 'test.csv', offset: 0, limit: 1});
  assert.equal(res.format, 'csv');
  assert.equal(res.encoding, 'utf-8');
  assert.deepEqual(res.headers, ['日期', '备注', '金额']);
  assert.equal(res.totalRows, 2);
  assert.equal(res.hasMore, true);
  assert.equal(res.nextOffset, 1);
  assert.equal(res.rows[0].values['备注'], '第一行\n含"引号"');

  const page2 = readStructuredFile(csvUtf8, {filename: 'test.csv', offset: 1, limit: 10});
  assert.equal(page2.hasMore, false);
  assert.equal(page2.rows[0].values['备注'], '打车');

  // GB18030: "项目,金额\n测试,99"
  const gbBytes = Buffer.from([0xCF, 0xEE, 0xC4, 0xBF, 0x2C, 0xBD, 0xF0, 0xB6, 0xEE, 0x0A, 0xB2, 0xE2, 0xCA, 0xD4, 0x2C, 0x39, 0x39]);
  const gbRes = readStructuredFile(gbBytes, {filename: 'legacy.csv'});
  assert.equal(gbRes.encoding, 'gb18030');
  assert.deepEqual(gbRes.headers, ['项目', '金额']);
  assert.equal(gbRes.rows[0].values['项目'], '测试');

  const tsvBuf = Buffer.from('a\tb\n1\talpha\n2\tbeta\n', 'utf8');
  const tsvFiltered = readStructuredFile(tsvBuf, {filename: 'data.tsv', query: 'beta'});
  assert.equal(tsvFiltered.format, 'tsv');
  assert.equal(tsvFiltered.matchedRows, 1);
  assert.equal(tsvFiltered.rows[0].values.a, '2');

  assert.throws(() => readStructuredFile(Buffer.from([0x41, 0x00, 0x42]), {filename: 'bad.csv'}), {code: 'office_binary_not_csv'});
});

test('XLSX parser handles sharedStrings, phonetic suppression, serial dates, multi-sheet, and parseBillExportXlsx', () => {
  assert.equal(formatExcelSerial(46349.06619851852, 'datetime', false), '2026-11-23 01:35:20');

  const xlsxBuf = buildXlsx({
    sharedStrings: [{text: '午饭', phonetic: 'wufan'}, '餐饮'],
    customFormats: [{id: 164, code: 'yyyy-mm-dd hh:mm:ss'}],
    sheets: [
      {
        name: '账单明细',
        rows: [
          ['账单日期', '分类筛选', '记账分类', '收支类型', '备注', '金额'],
          [{type: 'n', v: '46349.06619851852', s: 1}, {type: 's', idx: 1}, {type: 's', idx: 0}, '支出', '套餐', {type: 'n', v: '36.8'}],
          [{type: 'n', v: '46349.06619851852', s: 1}, {type: 's', idx: 1}, {type: 's', idx: 0}, '支出', '套餐', {type: 'n', v: '36.8'}],
          ['2026-11-23 09:00:00', '生活日用', '生活日用', '支出', '满减券抵扣', '0'],
        ],
      },
      {
        name: '汇总',
        rows: [['指标', '值'], ['是否结清', {type: 'b', v: true}]],
      },
    ],
  });

  const read1 = readStructuredFile(xlsxBuf, {filename: 'monthly.xlsx'});
  assert.deepEqual(read1.sheets, ['账单明细', '汇总']);
  assert.equal(read1.activeSheet, '账单明细');
  assert.equal(read1.rows[0].values['账单日期'], '2026-11-23 01:35:20');
  assert.equal(read1.rows[0].values['记账分类'], '午饭');

  const read2 = readStructuredFile(xlsxBuf, {filename: 'monthly.xlsx', sheet: '汇总'});
  assert.equal(read2.rows[0].values['指标'], '是否结清');
  assert.equal(read2.rows[0].values['值'], true);
  assert.throws(() => readStructuredFile(xlsxBuf, {filename: 'monthly.xlsx', sheet: '不存在'}), {code: 'office_sheet_not_found'});

  const bills = parseBillExportXlsx(xlsxBuf);
  assert.equal(bills.totalSourceRows, 3);
  assert.equal(bills.zeroAmountSkippedCount, 1);
  assert.deepEqual(bills.skippedZeroRowNumbers, [4]);
  assert.equal(bills.totalRows, 2);
  assert.equal(bills.rows[0].amount, '36.80');
  assert.equal(bills.rows[0].expense_date, '2026-11-23');
  assert.equal(bills.rows[0].expense_time, '01:35:20');
  assert.equal(bills.rows[0].subcategory_name, '午饭');
  assert.notEqual(bills.rows[0].source_key, bills.rows[1].source_key);
  assert.equal(bills.rows[0].row_hash, bills.rows[1].row_hash);

  // Same-name category & subcategory collapses subcategory_name to null.
  const sameCatBuf = buildXlsx({
    sheets: [{
      name: 's1',
      rows: [
        ['账单日期', '分类筛选', '记账分类', '收支类型', '备注', '金额'],
        ['2026-11-24 12:00:00', '消费', '消费', '支出', '', '18'],
      ],
    }],
  });
  const parsedSame = parseBillExportXlsx(sameCatBuf);
  assert.equal(parsedSame.rows[0].category_name, '消费');
  assert.equal(parsedSame.rows[0].subcategory_name, null);
  assert.equal(parsedSame.rows[0].note, null);
  assert.equal(parsedSame.rows[0].amount, '18.00');
});

test('DOCX parser extracts outline, paragraphs, nested tables, and filters', () => {
  const docXml = `<?xml version="1.0" encoding="UTF-8"?>
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:body>
        <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>第一章 总览</w:t></w:r></w:p>
        <w:p><w:r><w:t>正文第一段</w:t><w:tab/><w:t>补记</w:t></w:r></w:p>
        <w:tbl>
          <w:tr><w:tc><w:p><w:r><w:t>字段</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>说明</w:t></w:r></w:p></w:tc></w:tr>
          <w:tr><w:tc><w:p><w:r><w:t>金额</w:t></w:r></w:p></w:tc><w:tc><w:tbl><w:tr><w:tc><w:p><w:r><w:t>嵌套</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:tc></w:tr>
        </w:tbl>
      </w:body>
    </w:document>`;
  const docxBuf = makeZip([{name: 'word/document.xml', data: docXml}]);
  const res = readStructuredFile(docxBuf, {filename: 'spec.docx'});
  assert.equal(res.format, 'docx');
  assert.equal(res.totalBlocks, 3);
  assert.equal(res.tableCount, 1);
  assert.deepEqual(res.outline, [{blockIndex: 0, level: 1, text: '第一章 总览'}]);
  assert.equal(res.blocks[1].text, '正文第一段\t补记');
  assert.equal(res.blocks[2].type, 'table');
  assert.equal(res.blocks[2].rows[1][1], '嵌套');
});

test('ZIP/XML security guards block XXE, path traversal, encryption, CRC mismatch, and zip bombs', () => {
  const xxeBuf = makeZip([{
    name: 'word/document.xml',
    data: '<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><w:document/>',
  }]);
  assert.throws(() => readStructuredFile(xxeBuf, {filename: 'evil.docx'}), {code: 'office_xml_entity_forbidden'});

  const travBuf = makeZip([{name: '../evil.xml', data: '<x/>'}]);
  assert.throws(() => readStructuredFile(travBuf, {filename: 'trav.docx'}), {code: 'office_invalid_archive_path'});

  const encBuf = makeZip([{name: 'word/document.xml', data: '<w:document/>'}], {encryptIndex: 0});
  assert.throws(() => readStructuredFile(encBuf, {filename: 'enc.docx'}), {code: 'office_encrypted_not_supported'});

  const badCrc = makeZip([{name: 'word/document.xml', data: '<w:document/>'}], {corruptCrcIndex: 0});
  assert.throws(() => readStructuredFile(badCrc, {filename: 'crc.docx'}), {code: 'office_corrupt_archive'});

  // ZIP bomb: declare huge uncompressed size exceeding 64 MiB cap
  const bombBuf = makeZip([{name: 'word/document.xml', data: '<w:document/>'}], {overrideUncompressedSize: {0: 70 * 1024 * 1024}});
  assert.throws(() => readStructuredFile(bombBuf, {filename: 'bomb.docx'}), {code: 'office_zip_uncompressed_too_large'});
});

test('kurumi_files(read_structured) enforces T0/T1/T2/T3 tiers and emits trace without content', async () => {
  const root = fs.mkdtempSync(path.join(tmpRoot, 'svc-'));
  const homeDir = path.join(root, 'home');
  const space = path.join(homeDir, 'kurumi-space');
  const ssh = path.join(homeDir, '.ssh');
  const stateRoot = path.join(root, 'state');
  for (const d of [homeDir, space, ssh, stateRoot]) fs.mkdirSync(d, {recursive: true});
  const csvPath = path.join(space, 'sample.csv');
  fs.writeFileSync(csvPath, 'col1,col2\nSECRET_CELL_NEEDLE,42\n');
  const sshXlsx = path.join(ssh, 'secret.csv');
  fs.writeFileSync(sshXlsx, 'a,b\n1,2\n');
  const escapeLink = path.join(space, 'escape.csv');
  fs.symlinkSync(sshXlsx, escapeLink);

  const rawCfg = {
    homeDir,
    defaultWorkspace: space,
    t0Roots: [{path: space, label: '工作区'}],
    t1Roots: [{path: homeDir, label: '主目录'}],
  };
  const traces = [];
  const filesStore = new FilesStore(stateRoot, () => rawCfg);
  const leaseStore = new ScopedLeaseStore(stateRoot);
  after(() => { filesStore.close(); leaseStore.close(); });
  const execute = createFilesService(() => rawCfg, filesStore, leaseStore, {
    stateRoot,
    trace: evt => traces.push(evt),
  });

  const ownerRow = ownerPolicy('365999865').subjects[0];
  const ctx = context(ownerRow);
  const request = {
    actor: {id: '365999865', owner: true},
    scope: core.scopeFromToolContext(ctx),
    check: () => {},
    correlation: {sessionKey: ctx.sessionKey, runId: 'run-1'},
  };

  const out = await execute({action: 'read_structured', path: csvPath, offset: 0, limit: 10}, {}, request);
  assert.equal(out.ok, true);
  assert.equal(out.tier, 'T0');
  assert.equal(out.format, 'csv');
  assert.equal(out.rows[0].values.col1, 'SECRET_CELL_NEEDLE');
  assert.equal(traces.length, 1);
  assert.equal(traces[0].kind, 'files.read_structured');
  assert(!JSON.stringify(traces[0]).includes('SECRET_CELL_NEEDLE'));

  await assert.rejects(() => execute({action: 'read_structured', path: escapeLink}, {}, request), {code: 'files_redline_denied'});
  await assert.rejects(() => execute({action: 'read_structured', path: sshXlsx}, {}, request), {code: 'files_redline_denied'});
});
