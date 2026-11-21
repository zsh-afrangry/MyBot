// Adapt the existing Node test runner to the scenario report format.
import assert from 'node:assert/strict';
import {existsSync, writeFileSync} from 'node:fs';
import {isAbsolute, relative} from 'node:path';
import {run} from 'node:test';
import {scenarioSignal} from './scenario-lifecycle.mjs';

const [flag, out, ...files] = process.argv.slice(2);
assert(flag === '--out' && isAbsolute(out ?? '') && !existsSync(out) && files.length > 0);
const cases = [];
let summary;
for await (const {type, data} of run({files, signal: scenarioSignal, timeout: 90000})) {
  if (type === 'test:summary' && !data.file) summary = data;
  if ((type === 'test:pass' || type === 'test:fail') && data.details?.type === 'test') {
    cases.push({label: data.name, file: data.file && relative(process.cwd(), data.file),
      status: data.skip || data.todo ? 'uncovered' : type === 'test:pass' ? 'passed' : 'failed'});
  }
}
const passed = summary?.success === true && summary.counts.passed > 0;
writeFileSync(out, JSON.stringify({passed, cases, counts: summary?.counts}, null, 2) + '\n', {flag: 'wx', mode: 0o600});
if (!passed) process.exitCode = 1;
