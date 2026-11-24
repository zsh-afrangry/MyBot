// Runs only inside the disposable office-files isolated Gateway.
// Substitutes HTTPS CDN bytes for synthetic QQ attachment download tests.
import zlib from 'node:zlib';

function makeMinimalXlsx() {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>`
    + `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>`
    + `<row r="1"><c r="A1" t="inlineStr"><is><t>科目</t></is></c><c r="B1" t="inlineStr"><is><t>金额</t></is></c></row>`
    + `<row r="2"><c r="A2" t="inlineStr"><is><t>OFFICE_HOST_NEEDLE</t></is></c><c r="B2" t="n"><v>42.50</v></c></row>`
    + `</sheetData></worksheet>`;
  const wb = `<?xml version="1.0" encoding="UTF-8"?>`
    + `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`
    + `<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const rels = `<?xml version="1.0" encoding="UTF-8"?>`
    + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + `<Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`;

  const entries = [
    {name: 'xl/workbook.xml', data: Buffer.from(wb, 'utf8')},
    {name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(rels, 'utf8')},
    {name: 'xl/worksheets/sheet1.xml', data: Buffer.from(xml, 'utf8')},
  ];
  const localParts = [];
  const cdParts = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const comp = zlib.deflateRawSync(e.data);
    const crc = zlib.crc32(e.data) >>> 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    localParts.push(lh, nameBuf, comp);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(comp.length, 20);
    cd.writeUInt32LE(e.data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    cdParts.push(cd, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
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

export const fixtureOfficeXlsxUrl = 'https://multimedia.nt.qq.com/kurumi-office-acceptance.xlsx';
export const fixtureOfficeXlsx = () => makeMinimalXlsx();

if (process.env.OPENCLAW_STATE_DIR && process.env.OPENCLAW_CONFIG_PATH === process.env.OPENCLAW_STATE_DIR + '/openclaw.json'
  && /\/kurumi-office-host-[^/]+\/state$/u.test(process.env.OPENCLAW_STATE_DIR)) {
  const fetchLoopback = globalThis.fetch;
  globalThis.fetch = (input, options) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.href === fixtureOfficeXlsxUrl) {
      options?.signal?.throwIfAborted();
      return Promise.resolve(new Response(fixtureOfficeXlsx(), {status: 200}));
    }
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') {
      throw Error('Unexpected network request in office-files fixture');
    }
    return fetchLoopback(input, options);
  };
}
