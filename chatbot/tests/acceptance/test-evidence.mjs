// Adapt the existing Node test runner to the scenario report format.
import assert from 'node:assert/strict';
import {existsSync, writeFileSync} from 'node:fs';
import {isAbsolute, relative} from 'node:path';
import {run} from 'node:test';
import {scenarioProgress,scenarioSignal} from './scenario-lifecycle.mjs';
import {assertionDiagnostics} from './assertion-diagnostics.mjs';

const [flag, out, ...files] = process.argv.slice(2);
assert(flag === '--out' && isAbsolute(out ?? '') && !existsSync(out) && files.length > 0);
const fault = files.indexOf('--diagnostic-fault');
if (fault>=0) {
  assert.deepEqual(files.splice(fault),['--diagnostic-fault','bills-assertion']);
  assert.deepEqual(files,['chatbot/tests/knowledgemap/bills.test.mjs']);
  process.env.KURUMI_BILLS_ASSERTION_FIXTURE='1';
}
const cases = [];
let summary;
for await (const {type, data} of run({files, signal: scenarioSignal, timeout: 90000})) {
  if (type === 'test:summary' && !data.file) summary = data;
  if (type === 'test:start') scenarioProgress(data.name,'started');
  if ((type === 'test:pass' || type === 'test:fail') && data.details?.type === 'test') {
    const status = data.skip || data.todo ? 'uncovered' : type === 'test:pass' ? 'passed' : 'failed';
    const file = data.file && relative(process.cwd(), data.file);
    const diagnostic = status==='failed' ? assertionDiagnostics(data.details.error) : undefined;
    if (status!=='uncovered') scenarioProgress(data.name,status);
    cases.push({label:data.name,file,status,...(diagnostic&&{diagnostic:{
      ...diagnostic,assertion:diagnostic.assertion??(file&&data.line?{file,line:data.line}:undefined),
    }})});
  }
}
const passed = summary?.success === true && summary.counts.passed > 0;
writeFileSync(out, JSON.stringify({passed, cases, counts: summary?.counts}, null, 2) + '\n', {flag: 'wx', mode: 0o600});
if (!passed) process.exitCode = 1;
