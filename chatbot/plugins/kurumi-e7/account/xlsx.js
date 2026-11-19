// Fixed two-sheet export: typed values, no formulas, links, macros, or external references.
import {crc32, deflateRawSync} from 'node:zlib';

const ss = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const pkg = 'http://schemas.openxmlformats.org/package/2006/relationships';
const xml = body => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' + body;
const escape = value => value.slice(0, 32767).toWellFormed().replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/gu, '\ufffd')
  .replace(/_x[0-9a-f]{4}_/giu, match => '_x005F_' + match.slice(1))
  .replace(/[&<>"\r]/gu, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', '\r':'&#13;'})[c]);
const columnName = i => i < 26 ? String.fromCharCode(65 + i) : columnName(Math.floor(i / 26) - 1) + columnName(i % 26);

function zip(parts) {
  const files = [], index = [];
  let offset = 0;
  for (const [path, content] of Object.entries(parts)) {
    const name = Buffer.from(path), raw = Buffer.from(xml(content)), data = deflateRawSync(raw);
    const start = Buffer.alloc(30);
    start.writeUInt32LE(0x04034b50, 0); start.writeUInt16LE(20, 4); start.writeUInt16LE(8, 8);
    start.writeUInt16LE(33, 12); start.writeUInt32LE(crc32(raw), 14); start.writeUInt32LE(data.length, 18);
    start.writeUInt32LE(raw.length, 22); start.writeUInt16LE(name.length, 26);
    const line = Buffer.alloc(46);
    line.writeUInt32LE(0x02014b50, 0); line.writeUInt16LE(20, 4);
    start.copy(line, 6, 4, 28); line.writeUInt32LE(offset, 42);
    files.push(start, name, data); index.push(line, name);
    offset += start.length + name.length + data.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(index.length / 2, 8); end.writeUInt16LE(index.length / 2, 10);
  end.writeUInt32LE(index.reduce((size, part) => size + part.length, 0), 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...files, ...index, end]);
}

const styles = `<styleSheet xmlns="${ss}">
  <numFmts count="1"><numFmt numFmtId="164" formatCode="0.00%"/></numFmts>
  <fonts count="2"><font><sz val="10"/><name val="Arial"/></font><font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Arial"/></font></fonts>
  <fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF203B56"/><bgColor indexed="64"/></patternFill></fill></fills>
  <borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="center"/></xf>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
  </cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

function sheet({columns, rows, filter = false, wrap = false, freezeColumns = 0}) {
  const total = rows.length + 1, range = `A1:${columnName(columns.length - 1)}${total}`;
  const cells = [columns.map(c => c.title), ...rows].map((values, i) => {
    const row = i + 1, attrs = i === 0 ? ' ht="24" customHeight="1"' : wrap ? ' ht="34" customHeight="1"' : '';
    return `<row r="${row}"${attrs}>` + values.map((v, c) => {
      if (v == null) return '';
      const addr = columnName(c) + row;
      const percent = typeof v === 'object' && v.percent === true;
      if (typeof v === 'number' || percent) return `<c r="${addr}"${percent ? ' s="2"' : ''}><v>${percent ? v.value : v}</v></c>`;
      return `<c r="${addr}" t="inlineStr"${i === 0 ? ' s="1"' : wrap ? ' s="3"' : ''}><is><t xml:space="preserve">${escape(v)}</t></is></c>`;
    }).join('') + '</row>';
  }).join('');
  const pane = freezeColumns ? 'bottomRight' : 'bottomLeft';
  const first = columnName(freezeColumns) + '2';
  return `<worksheet xmlns="${ss}"><dimension ref="${range}"/><sheetViews><sheetView showGridLines="0" workbookViewId="0">` +
    (filter ? `<pane${freezeColumns ? ` xSplit="${freezeColumns}"` : ''} ySplit="1" topLeftCell="${first}" activePane="${pane}" state="frozen"/><selection pane="${pane}" activeCell="${first}" sqref="${first}"/>` : '') +
    `</sheetView></sheetViews><sheetFormatPr defaultRowHeight="18"/><cols>${columns.map((c, i) => `<col min="${i+1}" max="${i+1}" width="${c.width}" customWidth="1"/>`).join('')}</cols>` +
    `<sheetData>${cells}</sheetData>${filter ? `<autoFilter ref="${range}"/>` : ''}</worksheet>`;
}

export function xlsx(detail, fields) {
  const relationships = (type, id, target) => `<Relationship Id="${id}" Type="${rel}/${type}" Target="${target}"/>`;
  const sheets = [detail, fields];
  return zip({
    '[Content_Types].xml': `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
      `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
      sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') + '</Types>',
    '_rels/.rels': `<Relationships xmlns="${pkg}">${relationships('officeDocument', 'rId1', 'xl/workbook.xml')}</Relationships>`,
    'xl/workbook.xml': `<workbook xmlns="${ss}" xmlns:r="${rel}"><bookViews><workbookView activeTab="0"/></bookViews><sheets>` +
      sheets.map((view, i) => `<sheet name="${escape(view.name)}" sheetId="${i+1}" r:id="rId${i+1}"/>`).join('') + '</sheets></workbook>',
    'xl/_rels/workbook.xml.rels': `<Relationships xmlns="${pkg}">` +
      sheets.map((_, i) => relationships('worksheet', 'rId' + (i + 1), `worksheets/sheet${i+1}.xml`)).join('') +
      relationships('styles', 'rId3', 'styles.xml') + '</Relationships>',
    'xl/styles.xml': styles,
    'xl/worksheets/sheet1.xml': sheet(detail),
    'xl/worksheets/sheet2.xml': sheet(fields),
  });
}
