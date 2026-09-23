// Real GeoAPI, isolated Profile database, no production confirmation or QQ delivery.
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import assert from 'node:assert/strict';
import { createDomainFixture } from './domain-fixture.mjs';
import { QWeatherClient } from '../../plugins/personal-weather/dist/qweather-client.js';
const root = '/home/afrangry/.openclaw';
const env = { ...parseEnv(readFileSync(join(root, '.env'), 'utf8')), ...parseEnv(readFileSync(join(root, 'gateway.systemd.env'), 'utf8')) };
const raw = JSON.parse(readFileSync(join(root, 'openclaw.json'), 'utf8')).plugins.entries['personal-weather'].config;
const resolve = value => typeof value === 'object' ? env[value.id] : value.replace(/\$\{([^}]+)\}/gu, (_, key) => env[key]);
const client = new QWeatherClient({ apiHost: resolve(raw.apiHost), apiKey: resolve(raw.apiKey) });
const directory = mkdtempSync(join(root, 'state/acceptance/profile-geo-'));
const fixture = await createDomainFixture({ directory, toolContext: { messageChannel: 'qqbot', senderIsOwner: true,
  sessionKey: 'agent:main:qqbot:direct:acceptance-owner', deliveryContext: { to: 'qqbot:c2c:acceptance-owner', accountId: 'default' } } });
const report = { directory, mode: 'actual guarded client/domain; isolated DB; no model or QQ delivery', samples: [] };
try {
  for (const [text, administrative_area, expected] of [
    ['重庆大学虎溪科学城校区', '重庆市沙坪坝区', 'REQUEST_REJECTED'],
    ['重庆大学虎溪科学城校区', undefined, 'location_ambiguous'],
    ['沙坪坝', '重庆', 'pending'],
  ]) {
    const before = fixture.snapshot();
    let result;
    try {
      result = await fixture.profile.proposeProfileChange(fixture.weather, client,
        { schema_version: 1, request: { kind: 'current_location.set', location: { text, ...(administrative_area ? { administrative_area } : {}) } } },
        undefined, fixture.scope);
    } catch (error) { result = fixture.profile.profileProposalError(error); }
    const after = fixture.snapshot();
    report.samples.push({ text, administrative_area, expected, result, before, after });
    assert.equal(result.code ?? result.error?.code ?? result.status, expected);
    if (expected !== 'pending') assert.deepEqual(after, before);
    else {
      assert.equal(after.profilePlanning.profileRevision, before.profilePlanning.profileRevision);
      assert.equal(after.profilePlanning.change_proposals, before.profilePlanning.change_proposals + 1);
      assert.deepEqual(after.profilePlanning.grants, before.profilePlanning.grants);
      assert.deepEqual(after.reminder, before.reminder);
      assert.ok(result.confirmationInstruction);
    }
  }
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.failure = String(error); process.exitCode = 1; }
finally {
  fixture.close();
  writeFileSync(join(root, 'docs/verification/profile-geo-domain-acceptance.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, failure: report.failure, samples: report.samples.map(x => ({ expected: x.expected, code: x.result.code ?? x.result.error?.code ?? x.result.status })) }));
}
