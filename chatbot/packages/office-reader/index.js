import path from 'node:path';
import {parseCsv} from './csv.js';
import {parseDocx} from './docx.js';
import {OfficeReaderError, officeFail} from './errors.js';
import {formatExcelSerial, parseBillExportXlsx, parseXlsx} from './xlsx.js';

export {MAX_OFFICE_FILE_BYTES} from './zip.js';

export {
  OfficeReaderError,
  formatExcelSerial,
  parseBillExportXlsx,
  parseCsv,
  parseDocx,
  parseXlsx,
};

function inferFormat(filename, format) {
  if (format && format !== 'auto') return format;
  const ext = path.extname(String(filename ?? '')).slice(1).toLowerCase();
  if (['csv', 'tsv', 'xlsx', 'docx'].includes(ext)) return ext;
  officeFail('office_unsupported_format');
}

export function readStructuredFile(buffer, {filename, format = 'auto', sheet, offset, limit, query} = {}) {
  const resolved = inferFormat(filename, format);
  switch (resolved) {
    case 'csv':
    case 'tsv':
      return parseCsv(buffer, {format: resolved, offset, limit, query});
    case 'xlsx':
      return parseXlsx(buffer, {sheet, offset, limit, query});
    case 'docx':
      return parseDocx(buffer, {offset, limit, query});
    default:
      officeFail('office_unsupported_format');
  }
}
