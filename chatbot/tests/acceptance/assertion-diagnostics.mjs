import {isAbsolute,relative} from 'node:path';
import {fileURLToPath} from 'node:url';

const stateValues = new Set([
  'accepted','active','cancelled','completed','created','failed','pending','pending_sync','rejected',
  'scheduled','sent','succeeded','unknown','unverified','written',
]);
function diagnosticValue(value) {
  if (value===null || typeof value==='boolean' || Number.isFinite(value) || stateValues.has(value)) return value;
  return '[omitted]';
}

export function assertionDiagnostics(failure, cwd = process.cwd()) {
  const error = failure?.cause ?? failure;
  if (error?.code!=='ERR_ASSERTION') return {code:'test_execution_failed'};
  const result = {code:'assertion_failed'};
  for (const key of ['expected','actual']) {
    if (Object.hasOwn(error,key)) result[key]=diagnosticValue(error[key]);
  }
  for (const match of String(error.stack??'').matchAll(/(?:\(|\s)((?:file:\/\/)?\/[^\n()]+?):(\d+):(\d+)\)?(?:\n|$)/gu)) {
    let file;
    try {file=relative(cwd,match[1].startsWith('file:') ? fileURLToPath(match[1]) : match[1]);}
    catch {continue;}
    if (!isAbsolute(file) && file.startsWith('chatbot/tests/')) {
      result.assertion={file,line:Number(match[2])};
      break;
    }
  }
  return result;
}
