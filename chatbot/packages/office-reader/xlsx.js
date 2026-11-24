import crypto from 'node:crypto';
import path from 'node:path';
import {normalizeHeaders} from './csv.js';
import {officeFail} from './errors.js';
import {decodeOoxmlEscapes, localXmlName, scanXml} from './xml.js';
import {openZipArchive} from './zip.js';

const BUILTIN_DATE_FORMATS = new Map([
  [14, 'date'], [15, 'date'], [16, 'date'], [17, 'date'],
  [18, 'time'], [19, 'time'], [20, 'time'], [21, 'time'],
  [22, 'datetime'],
  [27, 'date'], [28, 'date'], [29, 'date'], [30, 'date'], [31, 'date'],
  [32, 'time'], [33, 'time'], [34, 'time'], [35, 'time'], [36, 'date'],
  [45, 'time'], [46, 'time'], [47, 'time'],
  [50, 'date'], [51, 'date'], [52, 'date'], [53, 'date'], [54, 'date'],
  [55, 'time'], [56, 'time'], [57, 'date'], [58, 'date'],
]);

function classifyFormatCode(code) {
  if (!code) return null;
  const stripped = code
    .replace(/\[[^\]]*\]/gu, '')
    .replace(/"[^"]*"/gu, '')
    .replace(/\\./gu, '')
    .replace(/_./gu, '')
    .replace(/\*./gu, '')
    .toLowerCase();
  if (/[#0?]/u.test(stripped.replace(/s\.0+/gu, ''))) return null;
  const hasDate = /[yd]/u.test(stripped);
  const hasTime = /[hs]/u.test(stripped);
  if (hasDate && hasTime) return 'datetime';
  if (hasDate) return 'date';
  if (hasTime) return 'time';
  if (/m/u.test(stripped)) return 'date';
  return null;
}

function resolveWorkbookTarget(target) {
  if (!target) return null;
  const clean = target.replace(/\\/gu, '/');
  if (clean.startsWith('/')) return path.posix.normalize(clean.slice(1));
  return path.posix.normalize(path.posix.join('xl', clean));
}

function parseWorkbook(archive) {
  const wbXml = archive.readText('xl/workbook.xml');
  const relsXml = archive.readText('xl/_rels/workbook.xml.rels');
  if (!wbXml || !relsXml) officeFail('office_invalid_xlsx');

  const relMap = new Map();
  scanXml(relsXml, {
    onOpenTag(name, attrs) {
      if (localXmlName(name) === 'Relationship' && attrs.Id && attrs.Target) {
        relMap.set(attrs.Id, resolveWorkbookTarget(attrs.Target));
      }
    },
  });

  let date1904 = false;
  const sheets = [];
  scanXml(wbXml, {
    onOpenTag(name, attrs) {
      const local = localXmlName(name);
      if (local === 'workbookPr') {
        date1904 = attrs.date1904 === '1' || attrs.date1904 === 'true';
      } else if (local === 'sheet' && attrs.name) {
        const rid = attrs['r:id'] ?? attrs.id;
        const target = relMap.get(rid);
        if (target) sheets.push({name: attrs.name, target});
      }
    },
  });
  if (sheets.length === 0) officeFail('office_invalid_xlsx');
  return {date1904, sheets};
}

function parseSharedStrings(archive) {
  const sstXml = archive.readText('xl/sharedStrings.xml');
  if (!sstXml) return [];
  const list = [];
  let inSi = false;
  let inPhonetic = false;
  let inText = false;
  let current = '';

  scanXml(sstXml, {
    onOpenTag(name) {
      const local = localXmlName(name);
      if (local === 'si') {
        inSi = true;
        current = '';
      } else if (inSi && local === 'rPh') {
        inPhonetic = true;
      } else if (inSi && !inPhonetic && local === 't') {
        inText = true;
      }
    },
    onText(text) {
      if (inSi && !inPhonetic && inText) current += text;
    },
    onCloseTag(name) {
      const local = localXmlName(name);
      if (local === 't') {
        inText = false;
      } else if (local === 'rPh') {
        inPhonetic = false;
      } else if (local === 'si' && inSi) {
        list.push(decodeOoxmlEscapes(current));
        inSi = false;
      }
    },
  });
  return list;
}

function parseStyles(archive) {
  const stylesXml = archive.readText('xl/styles.xml');
  if (!stylesXml) return [];
  const customFmts = new Map();
  const xfKinds = [];
  let inCellXfs = false;

  scanXml(stylesXml, {
    onOpenTag(name, attrs) {
      const local = localXmlName(name);
      if (local === 'numFmt' && attrs.numFmtId !== undefined && attrs.formatCode !== undefined) {
        const id = Number.parseInt(attrs.numFmtId, 10);
        if (Number.isInteger(id)) customFmts.set(id, attrs.formatCode);
      } else if (local === 'cellXfs') {
        inCellXfs = true;
      } else if (inCellXfs && local === 'xf') {
        const id = Number.parseInt(attrs.numFmtId ?? '0', 10);
        let kind = null;
        if (customFmts.has(id)) {
          kind = classifyFormatCode(customFmts.get(id));
        } else if (BUILTIN_DATE_FORMATS.has(id)) {
          kind = BUILTIN_DATE_FORMATS.get(id);
        }
        xfKinds.push(kind);
      }
    },
    onCloseTag(name) {
      if (localXmlName(name) === 'cellXfs') inCellXfs = false;
    },
  });
  return xfKinds;
}

function colRefToIndex(ref) {
  if (!ref) return null;
  let idx = 0;
  for (let i = 0; i < ref.length; i++) {
    const code = ref.charCodeAt(i);
    if (code >= 65 && code <= 90) {
      idx = idx * 26 + (code - 64);
    } else if (code >= 97 && code <= 122) {
      idx = idx * 26 + (code - 96);
    } else {
      break;
    }
  }
  return idx > 0 ? idx - 1 : null;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

export function formatExcelSerial(serialNum, dateKind, date1904 = false) {
  if (!Number.isFinite(serialNum)) return null;
  if (dateKind === 'time' && serialNum >= 0 && serialNum < 1) {
    const totalSec = Math.round(serialNum * 86400) % 86400;
    const hh = Math.floor(totalSec / 3600);
    const mm = Math.floor((totalSec % 3600) / 60);
    const ss = totalSec % 60;
    return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}`;
  }
  let baseMs = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  if (!date1904 && serialNum >= 0 && serialNum < 60) {
    baseMs = Date.UTC(1899, 11, 31);
  }
  const totalSec = Math.round(serialNum * 86400);
  const dt = new Date(baseMs + totalSec * 1000);
  if (!Number.isFinite(dt.getTime())) return null;
  const datePart = `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
  const timePart = `${pad2(dt.getUTCHours())}:${pad2(dt.getUTCMinutes())}:${pad2(dt.getUTCSeconds())}`;
  if (dateKind === 'date' && timePart === '00:00:00') return datePart;
  return `${datePart} ${timePart}`;
}

function parseSheetCells(sheetXml, sharedStrings, xfKinds, date1904) {
  const rows = [];
  let currentRow = null;
  let currentRowNum = 0;
  let nextCol = 0;

  let inCell = false;
  let cellCol = 0;
  let cellType = 'n';
  let cellStyle = null;
  let inV = false;
  let inIs = false;
  let inIsT = false;
  let vText = '';
  let isText = '';

  scanXml(sheetXml, {
    onOpenTag(name, attrs) {
      const local = localXmlName(name);
      if (local === 'row') {
        const parsedRow = Number.parseInt(attrs.r ?? '', 10);
        currentRowNum = Number.isInteger(parsedRow) && parsedRow > 0 ? parsedRow : currentRowNum + 1;
        currentRow = [];
        nextCol = 0;
      } else if (currentRow && local === 'c') {
        inCell = true;
        const parsedCol = colRefToIndex(attrs.r);
        cellCol = parsedCol !== null ? parsedCol : nextCol;
        nextCol = cellCol + 1;
        cellType = attrs.t ?? 'n';
        const styleIdx = attrs.s !== undefined ? Number.parseInt(attrs.s, 10) : -1;
        cellStyle = Number.isInteger(styleIdx) && styleIdx >= 0 ? xfKinds[styleIdx] ?? null : null;
        vText = '';
        isText = '';
      } else if (inCell && local === 'v') {
        inV = true;
      } else if (inCell && local === 'is') {
        inIs = true;
      } else if (inIs && local === 't') {
        inIsT = true;
      }
    },
    onText(text) {
      if (inV) vText += text;
      else if (inIsT) isText += text;
    },
    onCloseTag(name) {
      const local = localXmlName(name);
      if (local === 'v') {
        inV = false;
      } else if (local === 't' && inIs) {
        inIsT = false;
      } else if (local === 'is') {
        inIs = false;
      } else if (local === 'c' && inCell) {
        let rawValue = null;
        let displayValue = null;
        let isNumeric = false;
        if (cellType === 's') {
          const idx = Number.parseInt(vText, 10);
          displayValue = Number.isInteger(idx) && idx >= 0 && idx < sharedStrings.length ? sharedStrings[idx] : '';
          rawValue = displayValue;
        } else if (cellType === 'inlineStr') {
          displayValue = decodeOoxmlEscapes(isText);
          rawValue = displayValue;
        } else if (cellType === 'str' || cellType === 'e') {
          displayValue = decodeOoxmlEscapes(vText);
          rawValue = displayValue;
        } else if (cellType === 'b') {
          const boolVal = vText.trim() === '1' || vText.trim().toLowerCase() === 'true';
          displayValue = boolVal;
          rawValue = boolVal ? 'TRUE' : 'FALSE';
        } else {
          const trimmed = vText.trim();
          if (trimmed !== '') {
            rawValue = trimmed;
            const num = Number(trimmed);
            isNumeric = Number.isFinite(num);
            if (isNumeric && cellStyle) {
              displayValue = formatExcelSerial(num, cellStyle, date1904) ?? trimmed;
            } else {
              displayValue = isNumeric ? num : trimmed;
            }
          }
        }
        currentRow[cellCol] = {rawValue, displayValue, isNumeric, dateKind: cellStyle};
        inCell = false;
      } else if (local === 'row' && currentRow) {
        if (currentRow.some(cell => cell && cell.displayValue !== null && cell.displayValue !== '')) {
          rows.push({rowNumber: currentRowNum, cells: currentRow});
        }
        currentRow = null;
      }
    },
  });
  return rows;
}

function loadWorkbookSheet(buf, sheetName) {
  const archive = openZipArchive(buf);
  const {date1904, sheets} = parseWorkbook(archive);
  const selected = sheetName
    ? sheets.find(s => s.name === sheetName)
    : sheets[0];
  if (!selected) officeFail('office_sheet_not_found');
  const sheetXml = archive.readText(selected.target);
  if (!sheetXml) officeFail('office_invalid_xlsx');
  const sharedStrings = parseSharedStrings(archive);
  const xfKinds = parseStyles(archive);
  const rows = parseSheetCells(sheetXml, sharedStrings, xfKinds, date1904);
  return {sheets: sheets.map(s => s.name), activeSheet: selected.name, date1904, rows};
}

export function parseXlsx(buf, {sheet, offset = 0, limit = 50, query} = {}) {
  const safeOffset = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
  const safeLimit = Number.isSafeInteger(limit) && limit >= 1 ? Math.min(limit, 500) : 50;
  const {sheets, activeSheet, rows} = loadWorkbookSheet(buf, sheet);
  if (rows.length === 0) {
    return {
      format: 'xlsx',
      sheets,
      activeSheet,
      headers: [],
      totalRows: 0,
      matchedRows: 0,
      offset: safeOffset,
      limit: safeLimit,
      nextOffset: null,
      hasMore: false,
      rows: [],
    };
  }

  const width = rows.reduce((m, r) => Math.max(m, r.cells.length), 0);
  const headerRaw = [];
  for (let c = 0; c < width; c++) {
    headerRaw.push(rows[0].cells[c]?.displayValue ?? '');
  }
  const headers = normalizeHeaders(headerRaw, width);

  const dataRows = rows.slice(1).map(r => {
    const values = {};
    for (let c = 0; c < width; c++) {
      const cell = r.cells[c];
      values[headers[c]] = cell ? cell.displayValue : null;
    }
    return {rowNumber: r.rowNumber, values};
  });

  const q = typeof query === 'string' && query.trim() ? query.trim().toLowerCase() : null;
  const filtered = q
    ? dataRows.filter(item => Object.values(item.values).some(v => v !== null && String(v).toLowerCase().includes(q)))
    : dataRows;

  const page = filtered.slice(safeOffset, safeOffset + safeLimit);
  const nextOffset = safeOffset + page.length < filtered.length ? safeOffset + page.length : null;
  return {
    format: 'xlsx',
    sheets,
    activeSheet,
    headers,
    totalRows: dataRows.length,
    matchedRows: filtered.length,
    offset: safeOffset,
    limit: safeLimit,
    nextOffset,
    hasMore: nextOffset !== null,
    rows: page,
  };
}

const REQUIRED_BILL_HEADERS = ['账单日期', '分类筛选', '记账分类', '收支类型', '备注', '金额'];

function isValidCalendarDate(y, m, d) {
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function parseBillDateCell(cell, date1904, rowNumber) {
  if (!cell || cell.rawValue === null || cell.rawValue === '') {
    officeFail('bill_xlsx_invalid_row', {rowNumber, field: 'expense_date'});
  }
  let text = null;
  if (cell.isNumeric) {
    const num = Number(cell.rawValue);
    if (!Number.isFinite(num) || num < 1) {
      officeFail('bill_xlsx_invalid_row', {rowNumber, field: 'expense_date'});
    }
    text = formatExcelSerial(num, 'datetime', date1904);
  } else {
    text = String(cell.rawValue).trim();
  }
  if (!text) officeFail('bill_xlsx_invalid_row', {rowNumber, field: 'expense_date'});
  const match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T\s](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/u.exec(text);
  if (!match) officeFail('bill_xlsx_invalid_row', {rowNumber, field: 'expense_date'});
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4] ?? 0);
  const minute = Number(match[5] ?? 0);
  const second = Number(match[6] ?? 0);
  if (!isValidCalendarDate(year, month, day) || hour > 23 || minute > 59 || second > 59) {
    officeFail('bill_xlsx_invalid_row', {rowNumber, field: 'expense_date'});
  }
  return {
    expense_date: `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`,
    expense_time: `${pad2(hour)}:${pad2(minute)}:${pad2(second)}`,
  };
}

function normalizeBillAmount(cell, rowNumber) {
  if (!cell || cell.rawValue === null || cell.rawValue === '') {
    officeFail('bill_xlsx_invalid_row', {rowNumber, field: 'amount'});
  }
  let raw = String(cell.rawValue).trim();
  if (cell.isNumeric && /^[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/u.test(raw)) {
    const num = Number(raw);
    if (!Number.isFinite(num) || num < 0) {
      officeFail('bill_xlsx_invalid_row', {rowNumber, field: 'amount'});
    }
    raw = num.toFixed(2);
  }
  const match = /^(\d{1,10})(?:\.(\d{1,2}))?$/u.exec(raw);
  if (!match) officeFail('bill_xlsx_invalid_row', {rowNumber, field: 'amount'});
  const intPart = match[1].replace(/^0+(?=\d)/u, '');
  const decPart = (match[2] ?? '').padEnd(2, '0');
  return `${intPart}.${decPart}`;
}

function normalizeTagCell(cell, rowNumber, field) {
  const value = String(cell?.rawValue ?? '').normalize('NFKC').trim();
  if (!value || value.length > 64) {
    officeFail('bill_xlsx_invalid_row', {rowNumber, field});
  }
  return value;
}

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

export function parseBillExportXlsx(buf, {sheet} = {}) {
  const {activeSheet, date1904, rows} = loadWorkbookSheet(buf, sheet);
  if (rows.length < 1) officeFail('bill_xlsx_invalid_headers');

  const headerCells = rows[0].cells.map(c => String(c?.displayValue ?? '').normalize('NFKC').trim());
  const colIndex = Object.create(null);
  for (const required of REQUIRED_BILL_HEADERS) {
    const idx = headerCells.indexOf(required);
    if (idx === -1) officeFail('bill_xlsx_invalid_headers');
    colIndex[required] = idx;
  }

  const parsed = [];
  const skippedZeroRowNumbers = [];
  const seenTuples = new Map();

  for (const row of rows.slice(1)) {
    const rowNumber = row.rowNumber;
    const rawCells = REQUIRED_BILL_HEADERS.map(h => row.cells[colIndex[h]]);
    const hasAny = rawCells.some(c => c && c.rawValue !== null && String(c.rawValue).trim() !== '');
    if (!hasAny) continue;

    const {expense_date, expense_time} = parseBillDateCell(rawCells[0], date1904, rowNumber);
    const category_name = normalizeTagCell(rawCells[1], rowNumber, 'category_name');
    const rawSub = normalizeTagCell(rawCells[2], rowNumber, 'subcategory_name');
    const subcategory_name = rawSub === category_name ? null : rawSub;

    const record_type = String(rawCells[3]?.rawValue ?? '').normalize('NFKC').trim();
    if (record_type !== '支出' && record_type !== '收入') {
      officeFail('bill_xlsx_invalid_row', {rowNumber, field: 'record_type'});
    }

    const noteRaw = rawCells[4]?.rawValue === null || rawCells[4]?.rawValue === undefined
      ? ''
      : String(rawCells[4].rawValue).normalize('NFKC').trim();
    if (noteRaw.length > 1000) {
      officeFail('bill_xlsx_invalid_row', {rowNumber, field: 'note'});
    }
    const note = noteRaw === '' ? null : noteRaw;

    const amount = normalizeBillAmount(rawCells[5], rowNumber);
    if (amount === '0.00') {
      skippedZeroRowNumbers.push(rowNumber);
      continue;
    }

    const tupleBase = [
      expense_date,
      expense_time,
      record_type,
      amount,
      category_name,
      subcategory_name ?? '',
      note ?? '',
    ].join('|');
    const dupSeq = seenTuples.get(tupleBase) ?? 0;
    seenTuples.set(tupleBase, dupSeq + 1);

    const source_key = 'xlsx-v1:' + sha256(`${tupleBase}|${dupSeq}`);
    const row_hash = sha256(JSON.stringify({
      expense_date,
      expense_time,
      record_type,
      amount,
      category_name,
      subcategory_name,
      note,
    }));

    parsed.push({
      source_key,
      row_hash,
      expense_date,
      expense_time,
      record_type,
      amount,
      category_name,
      subcategory_name,
      note,
    });
  }

  return {
    sheetName: activeSheet,
    totalSourceRows: parsed.length + skippedZeroRowNumbers.length,
    zeroAmountSkippedCount: skippedZeroRowNumbers.length,
    skippedZeroRowNumbers,
    totalRows: parsed.length,
    rows: parsed,
  };
}
