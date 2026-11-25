// Isolated Gateway, disposable Profile SQLite and authenticated KnowledgeMap test client.
// No model, production state, QQ messages or external weather requests.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHmac, randomBytes} from 'node:crypto';
import {existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {isAbsolute, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {WeatherStore} from '../../packages/personal-domains/dist/store.js';
import {createProfileCatalog} from '../../packages/personal-domains/dist/profile-catalog.js';
import {commitProfileChange, proposeProfileChange} from '../../packages/personal-domains/dist/profile.js';
import {scopeFromToolContext} from '../../packages/confirmation-core/dist/index.js';
import {SHARED_LOCATION_PATH} from '../../packages/personal-domains/dist/shared-location.js';
import {startIsolatedGateway} from './isolated-gateway.mjs';

const [flag, out, ...extra] = process.argv.slice(2);
assert(flag === '--out' && isAbsolute(out ?? '') && !existsSync(out) && !extra.length);
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const km = process.env.KM_TEST_REPO ?? '/home/afrangry/repository';
const python = process.env.KM_TEST_PYTHON ?? '/home/afrangry/miniconda3/envs/desheng/bin/python';
const root = mkdtempSync(join(tmpdir(), 'kurumi-shared-city-host-'));
const tokenFile = join(root, 'token');
const token = 'fixture-shared-city-' + 'x'.repeat(40);
const gatewayToken = randomBytes(24).toString('hex');
writeFileSync(tokenFile, token, {mode: 0o600});
mkdirSync(join(root, 'workspace'));
const store = new WeatherStore({stateDirectory:join(root, 'state/personal-weather')});
store.close();
let gateway, gatewayPort;
const report = {passed:false, boundary:'Isolated real Gateway and KnowledgeMap website auth; temporary SQLite, fake weather, no QQ or external network.', cases:[]};
try {
  gateway = await startIsolatedGateway({repo, root, token:gatewayToken, configure(port) {
    gatewayPort = port;
    return {agents:{defaults:{workspace:join(root,'workspace')},
      entries:{main:{workspace:join(root,'workspace')}}},
    plugins:{allow:['personal-profile'], load:{paths:[join(repo,'chatbot/plugins/personal-profile')]},
      slots:{memory:'none'}, entries:{'personal-profile':{enabled:true, config:{shareDefaultCity:true, bridgeTokenFile:tokenFile}}}},
    cron:{enabled:false}, tools:{web:{search:{enabled:false},fetch:{enabled:false}}}, logging:{file:join(root,'runtime.log')}};
  }});
  await gateway.ready();
  const url = `http://127.0.0.1:${gatewayPort}${SHARED_LOCATION_PATH}`;
  const key = createHmac('sha256', token).update('kurumi:shared-default-city:v1').digest('hex');
  let ready;
  for (let attempt = 0; attempt < 50; attempt++) {
    ready = await fetch(url, {headers:{authorization:`Bearer ${key}`}});
    if (ready.status !== 503) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(ready.status, 200);
  assert.equal((await ready.json()).location, '101280109');
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, {headers:{authorization:`Bearer ${token}`}})).status, 401);
  report.cases.push({label:'gateway scoped authentication and read-only confirmed location', passed:true});

  const script = join(km, 'backend/tests/shared_city_cases.py');
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(python, [script, '--external-profile'], {cwd:km, stdio:['ignore','pipe','pipe'],
      env:{PATH:process.env.PATH, HOME:root, LANG:'C.UTF-8', KM_ASSISTANT_TOKEN_FILE:tokenFile, KURUMI_SHARED_LOCATION_URL:url}});
    let text = '';
    child.stdout.on('data', data => {text += data.toString().slice(0, 4000);});
    child.stderr.on('data', data => {text += data.toString().slice(0, 4000);});
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve(code) : reject(Error(`Isolated website test failed (${code}): ${text.slice(-4000)}`)));
  });
  assert.equal(exitCode, 0);
  report.cases.push({label:'authenticated website uses real Gateway; unguarded website rejected; local city separate', passed:true});

  const changedStore = new WeatherStore({stateDirectory:join(root, 'state/personal-weather')});
  try {
    const scope = scopeFromToolContext({messageChannel:'qqbot', senderIsOwner:true,
      deliveryContext:{to:'qqbot:c2c:fixture-owner', accountId:'default'}});
    const resolve = createProfileCatalog([{id:'fixture-point', name:'测试地点', countryCode:'CN',
      latitude:35.1234, longitude:114.5678, timezone:'Asia/Shanghai', precision:'point'}]);
    const proposal = await proposeProfileChange(changedStore, resolve, {schema_version:1,
      request:{kind:'current_location.set', location:{text:'测试地点'}}}, undefined, scope);
    assert.equal(proposal.status, 'pending');
    assert.equal((await (await fetch(url, {headers:{authorization:`Bearer ${key}`}})).json()).location, '101280109');
    assert.equal(changedStore.recordInboundConfirmation({channel:'qqbot', conversationId:'qqbot:c2c:fixture-owner',
      accountId:'default', senderIsOwner:true, isGroup:false, messageId:'fixture-confirm',
      content:`确认 ${proposal.proposalId} ${proposal.payloadHash}`}), true);
    assert.equal(commitProfileChange(changedStore, {proposal_id:proposal.proposalId, payload_hash:proposal.payloadHash}, scope).ok, true);
    assert.equal((await (await fetch(url, {headers:{authorization:`Bearer ${key}`}})).json()).location, '114.57,35.12');
  } finally {changedStore.close();}
  report.cases.push({label:'gateway reflects confirmed changes and ignores pending proposals', passed:true});
  report.passed = true;
} catch (error) {
  report.error = error.stack ?? String(error);
  process.exitCode = 1;
} finally {
  if (gateway) report.gatewayStopped = await gateway.close();
  if (report.passed && report.gatewayStopped === true) {
    rmSync(root, {recursive:true, force:true});
    report.fixtureRemoved = !existsSync(root);
  } else {
    report.fixtureRemoved = false;
    report.diagnosticDirectory = root;
    if (report.passed) {report.passed = false; report.error = 'Isolated Gateway did not stop cleanly'; process.exitCode = 1;}
  }
  writeFileSync(out, JSON.stringify(report, null, 2), {flag:'wx', mode:0o600});
  console.log(JSON.stringify({passed:report.passed, cases:report.cases.length, error:report.error}));
}
