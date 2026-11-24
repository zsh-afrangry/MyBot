import {officeFail} from './errors.js';
import {MAX_OFFICE_FILE_BYTES} from './zip.js';

function decodeDelimitedText(buf) {
  if (!Buffer.isBuffer(buf)) officeFail('office_invalid_encoding');
  if (buf.length > MAX_OFFICE_FILE_BYTES) officeFail('office_file_too_large');
  if (buf.includes(0)) officeFail('office_binary_not_csv');

  let text;
  let encoding;
  try {
    text = new TextDecoder('utf-8', {fatal: true}).decode(buf);
    encoding = 'utf-8';
  } catch {
    try {
      text = new TextDecoder('gb18030', {fatal: true}).decode(buf);
      encoding = 'gb18030';
    } catch {
      officeFail('office_invalid_encoding');
    }
  }
  if (text.startsWith('\uFEFF')) text = text.slice(1);
  return {text, encoding};
}

function detectDelimiter(text, forcedFormat) {
  if (forcedFormat === 'tsv') return '\t';
  const candidates = [',', '\t', ';'];
  const counts = new Map(candidates.map(c => [c, 0]));
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') {
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (!inQuotes) {
      if (ch === '\n' || ch === '\r') break;
      if (counts.has(ch)) counts.set(ch, counts.get(ch) + 1);
    }
  }
  let best = ',';
  let bestCount = 0;
  for (const c of candidates) {
    const n = counts.get(c);
    if (n > bestCount) {
      best = c;
      bestCount = n;
    }
  }
  return best;
}

function parseDelimitedRows(text, delimiter) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let fieldStarted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"' && !fieldStarted) {
      inQuotes = true;
      fieldStarted = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
      fieldStarted = false;
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      fieldStarted = false;
    } else {
      field += ch;
      fieldStarted = true;
    }
  }

  if (fieldStarted || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter(r => r.some(cell => cell !== ''));
}

export function normalizeHeaders(rawHeaders, width) {
  const used = new Map();
  const headers = [];
  for (let i = 0; i < width; i++) {
    const base = String(rawHeaders[i] ?? '').trim() || `col_${i + 1}`;
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    headers.push(seen === 0 ? base : `${base}_${seen + 1}`);
  }
  return headers;
}

export function parseCsv(buf, {format = 'csv', offset = 0, limit = 50, query} = {}) {
  const safeOffset = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
  const safeLimit = Number.isSafeInteger(limit) && limit >= 1 ? Math.min(limit, 500) : 50;
  const {text, encoding} = decodeDelimitedText(buf);
  const delimiter = detectDelimiter(text, format);
  const rawRows = parseDelimitedRows(text, delimiter);
  if (rawRows.length === 0) {
    return {
      format: delimiter === '\t' ? 'tsv' : 'csv',
      encoding,
      delimiter,
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

  const width = rawRows.reduce((m, r) => Math.max(m, r.length), 0);
  const headers = normalizeHeaders(rawRows[0], width);
  const dataRows = rawRows.slice(1).map((r, idx) => {
    const record = {};
    for (let c = 0; c < width; c++) {
      record[headers[c]] = r[c] ?? '';
    }
    return {rowNumber: idx + 2, values: record};
  });

  const q = typeof query === 'string' && query.trim() ? query.trim().toLowerCase() : null;
  const filtered = q
    ? dataRows.filter(item => Object.values(item.values).some(v => String(v).toLowerCase().includes(q)))
    : dataRows;

  const page = filtered.slice(safeOffset, safeOffset + safeLimit);
  const nextOffset = safeOffset + page.length < filtered.length ? safeOffset + page.length : null;
  return {
    format: delimiter === '\t' ? 'tsv' : 'csv',
    encoding,
    delimiter,
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
