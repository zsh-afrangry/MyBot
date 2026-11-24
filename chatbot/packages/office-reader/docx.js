import {officeFail} from './errors.js';
import {localXmlName, scanXml} from './xml.js';
import {openZipArchive} from './zip.js';

function headingLevelFromStyle(styleVal) {
  if (!styleVal) return null;
  const m = /^(?:Heading|标题)\s*([1-6])$/iu.exec(styleVal.trim());
  return m ? Number(m[1]) : null;
}

export function parseDocx(buf, {offset = 0, limit = 50, query} = {}) {
  const safeOffset = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
  const safeLimit = Number.isSafeInteger(limit) && limit >= 1 ? Math.min(limit, 200) : 50;
  const archive = openZipArchive(buf);
  const docXml = archive.readText('word/document.xml');
  if (!docXml) officeFail('office_invalid_docx');

  const blocks = [];
  let inBody = false;
  let bodyDepth = 0;

  let curP = null;
  let inPPr = false;
  let inText = false;

  const tblStack = [];

  scanXml(docXml, {
    onOpenTag(name, attrs) {
      const local = localXmlName(name);
      if (local === 'body' && !inBody) {
        inBody = true;
        bodyDepth = 0;
        return;
      }
      if (!inBody) return;
      bodyDepth++;

      if (local === 'tbl') {
        tblStack.push({rows: [], currentRow: null, cellParts: null});
      } else if (tblStack.length > 0 && local === 'tr') {
        tblStack.at(-1).currentRow = [];
      } else if (tblStack.length > 0 && local === 'tc') {
        tblStack.at(-1).cellParts = [];
      } else if (local === 'p') {
        curP = {text: '', headingLevel: null};
      } else if (curP && local === 'pPr') {
        inPPr = true;
      } else if (inPPr && local === 'pStyle') {
        const level = headingLevelFromStyle(attrs['w:val'] ?? attrs.val);
        if (level !== null) curP.headingLevel = level;
      } else if (inPPr && local === 'outlineLvl') {
        const lvl = Number.parseInt(attrs['w:val'] ?? attrs.val ?? '', 10);
        if (Number.isInteger(lvl) && lvl >= 0 && lvl <= 5 && curP.headingLevel === null) {
          curP.headingLevel = lvl + 1;
        }
      } else if (curP && local === 't') {
        inText = true;
      } else if (curP && local === 'tab') {
        curP.text += '\t';
      } else if (curP && (local === 'br' || local === 'cr')) {
        curP.text += '\n';
      }
    },
    onText(text) {
      if (inBody && curP && inText) {
        curP.text += text;
      }
    },
    onCloseTag(name) {
      if (!inBody) return;
      const local = localXmlName(name);
      if (local === 'body' && bodyDepth === 0) {
        inBody = false;
        return;
      }

      if (local === 't') {
        inText = false;
      } else if (local === 'pPr') {
        inPPr = false;
      } else if (local === 'p' && curP) {
        const text = curP.text.trim();
        const activeTbl = tblStack.at(-1);
        if (activeTbl?.cellParts) {
          if (text) activeTbl.cellParts.push(text);
        } else if (text || curP.headingLevel !== null) {
          blocks.push({
            blockIndex: blocks.length,
            type: curP.headingLevel !== null ? 'heading' : 'paragraph',
            ...(curP.headingLevel !== null ? {level: curP.headingLevel} : {}),
            text,
          });
        }
        curP = null;
      } else if (local === 'tc' && tblStack.length > 0) {
        const activeTbl = tblStack.at(-1);
        if (activeTbl.cellParts) {
          activeTbl.currentRow?.push(activeTbl.cellParts.join('\n'));
          activeTbl.cellParts = null;
        }
      } else if (local === 'tr' && tblStack.length > 0) {
        const tbl = tblStack.at(-1);
        if (tbl.currentRow) tbl.rows.push(tbl.currentRow);
        tbl.currentRow = null;
      } else if (local === 'tbl' && tblStack.length > 0) {
        const finished = tblStack.pop();
        const outerTbl = tblStack.at(-1);
        if (outerTbl?.cellParts) {
          outerTbl.cellParts.push(finished.rows.map(r => r.join(' | ')).join('\n'));
        } else {
          blocks.push({
            blockIndex: blocks.length,
            type: 'table',
            rows: finished.rows,
          });
        }
      }
      bodyDepth--;
    },
  });

  const outline = blocks
    .filter(b => b.type === 'heading')
    .map(b => ({blockIndex: b.blockIndex, level: b.level, text: b.text}));
  const tableCount = blocks.filter(b => b.type === 'table').length;

  const q = typeof query === 'string' && query.trim() ? query.trim().toLowerCase() : null;
  const filtered = q
    ? blocks.filter(b => (b.type === 'table'
      ? b.rows.some(row => row.some(cell => cell.toLowerCase().includes(q)))
      : b.text.toLowerCase().includes(q)))
    : blocks;

  const page = filtered.slice(safeOffset, safeOffset + safeLimit);
  const nextOffset = safeOffset + page.length < filtered.length ? safeOffset + page.length : null;
  return {
    format: 'docx',
    outline,
    totalBlocks: blocks.length,
    tableCount,
    matchedBlocks: filtered.length,
    offset: safeOffset,
    limit: safeLimit,
    nextOffset,
    hasMore: nextOffset !== null,
    blocks: page,
  };
}
