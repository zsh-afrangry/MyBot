// Explicit --live only: actual DSH/model and result/check/notification handlers inside the approved pilot folder.
// Local synthetic requester and recording delivery; NO real QQ, production task/config/service write or merge.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {fixture} from './fixtures.mjs';
import {AcpClient} from '../../packages/coding-runtime/acp-client.js';
import {targetState} from '../../plugins/kurumi-coding/workspaces.js';

if (!process.argv.includes('--live')) throw Error('Explicit --live required for an actual DSH model call');
const out = process.argv.find(arg => arg.startsWith('--output='))?.slice(9);
if (!out || !path.isAbsolute(out) || fs.existsSync(out)) throw Error('Require a new absolute --output= report path');
const config = JSON.parse(fs.readFileSync(new URL('../../../config/runtime.config.json', import.meta.url)));
const parent = config.plugins.entries['kurumi-coding'].config.writeBoundary.root;
if (parent !== '/home/afrangry/.local/share/kurumi-coding-pilot-20261029' || fs.realpathSync(parent) !== parent) throw Error('Only the explicitly approved pilot folder may host this live check');
const pythonCheck = fileURLToPath(new URL('../../scripts/check-coding-pilot-python.py', import.meta.url));
const f = await fixture(null, {parent, clientFactory: args => new AcpClient(args), configure(plugin) {
  plugin.dsh = config.plugins.entries['kurumi-coding'].config.dsh;
  plugin.projects[0].checks.push({name: 'independent python quicksort', argv: ['/usr/bin/python3', '-B', pythonCheck], skipExitCode: 77, timeoutMs: 15000});
}});
const report = {schemaVersion: 1, at: new Date().toISOString(), actualDsh: true, actualQq: false, privateArtifacts: f.root,
  productionChanged: false, prompts: 0, cases: []};
try {
  const original = targetState({root: f.source});
  const task = await f.run({action: 'start', projectId: 'fixture', task: 'Create quicksort_first_pivot.py with quicksort(values), sorting the same list in place using the first element as pivot for each recursive partition, and returning that same list. Under __main__, assert these four cases: [10,7,8,9,1,5], [], [42], [4,2,4,1,2,4]. Run python3 -B quicksort_first_pivot.py. On successful execution print exactly PILOT_SORT_RESULT=[1,5,7,8,9,10] and QUICKSORT_CASES_PASSED=4 on separate lines. Preserve the existing value.mjs. Do not commit, merge, edit other directories, install software or use network/services; the host performs independent checks and commits.'});
  report.prompts++;
  const ready = await f.settle(task.id);
  Object.assign(report, {taskId: task.id, externalSessionId: ready.externalSessionId, roundId: ready.executionRoundId, state: ready.state,
    reason: ready.reason, verifiedCommit: ready.verifiedCommit, hostChecks: ready.checks, permissionRequests: ready.permissionSummary?.requests ?? 0});
  assert.equal(ready.state, 'ready'); assert.equal(ready.checks.rows.at(-1).code, 0); assert.equal(ready.checks.rows.at(-1).skipped, undefined);
  let offset = 0, actual = '', pages = 0;
  do {
    const result = (await f.run({action: 'result', taskId: task.id, roundId: ready.executionRoundId, offset, limit: 137})).result;
    assert.equal(result.page.source, 'acp_execution_tool_results');
    actual += result.page.text; offset = result.page.nextOffset; pages++;
  } while (offset !== null);
  assert.match(actual, /^PILOT_SORT_RESULT=\[1,5,7,8,9,10\]$/m); assert.match(actual, /^QUICKSORT_CASES_PASSED=4$/m);
  report.cases.push({name: 'actual_execution_output_and_paging', ok: true, pages, actualOutputChars: Array.from(actual).length});
  const body = f.deliveries[0].text;
  assert.match(body, /^PILOT_SORT_RESULT=\[1,5,7,8,9,10\]$/m); assert.match(body, /^QUICKSORT_CASES_PASSED=4$/m);
  await f.service.notify(f.service.store.get(task.id)); assert.equal(f.deliveries.length, 1);
  report.cases.push({name: 'same_result_recording_notification_no_duplicate', ok: true, bodyHash: ready.delivery.bodyHash});
  assert.deepEqual(targetState({root: f.source}), original);
  report.cases.push({name: 'source_unchanged_no_merge_or_push', ok: true});
  report.ok = true;
} catch (error) {
  report.ok = false; report.failure = {name: error.name, code: error.code ?? 'see_private_artifacts'}; process.exitCode = 1;
} finally {
  for (const service of f.services.toReversed()) await service.stop();
  report.finishedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(out), {recursive: true}); fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n', {flag: 'wx'});
  console.log(JSON.stringify({ok: report.ok, output: out, privateArtifacts: f.root, prompts: report.prompts, actualQq: false, state: report.state}));
}
