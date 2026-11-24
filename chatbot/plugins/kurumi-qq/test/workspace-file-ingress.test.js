// Offline unit tests for owner QQ non-PDF workspace staging vs member PDF-only isolation.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {handleInbound} from '../src/inbound.js';
import {stageAttachment} from '../../../packages/qq-delivery/index.js';
import {collectEvents, filterEvents} from '../../../packages/log-query/index.js';
import {withAccess, memberRow, MEMBER, OWNER} from '../../../tests/access-control/fixtures.mjs';

const BOT = '123456789';

function setupFixture(t, sender = OWNER) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kurumi-qq-workspace-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));

  const homeDir = path.join(root, 'home');
  const kurumiSpace = path.join(homeDir, 'kurumi-space');
  const workspace = path.join(root, 'workspace');
  const channelDir = path.join(root, 'channel');
  const mediaRoot = path.join(root, 'media');
  const docsRoot = path.join(root, 'documents');
  for (const d of [homeDir, kurumiSpace, workspace, channelDir, mediaRoot, docsRoot]) {
    fs.mkdirSync(d, {recursive: true});
  }
  fs.writeFileSync(path.join(root, 'token'), 'synthetic', {mode: 0o600});

  const cfg = withAccess({
    agents: {entries: {main: {workspace}}},
    channels: {
      'kurumi-qq': {
        enabled: true,
        ownerId: OWNER,
        httpUrl: 'http://127.0.0.1:1',
        wsUrl: 'ws://127.0.0.1:2',
        httpTokenFile: path.join(root, 'token'),
        wsTokenFile: path.join(root, 'token'),
        stateDir: channelDir,
        mediaRoot,
        dailySendLimit: 50,
        naturalSegments: false,
      },
    },
    plugins: {
      entries: {
        'kurumi-papers': {config: {root: docsRoot}},
        'kurumi-files': {
          enabled: true,
          config: {
            homeDir,
            defaultWorkspace: kurumiSpace,
            t0Roots: [{path: kurumiSpace, label: 'Kurumi 工作区'}],
          },
        },
      },
    },
  });

  if (sender !== OWNER) {
    cfg.channels['kurumi-qq'].accessControl.subjects.push(memberRow(sender));
    const memberWs = path.join(root, 'users', sender, 'workspace');
    cfg.agents.entries['qq-user-' + sender] = {workspace: memberWs};
    fs.mkdirSync(memberWs, {recursive: true});
    fs.writeFileSync(path.join(memberWs, 'AGENTS.md'), '<!-- kurumi-isolated-member-v1 -->');
  }

  return {root, cfg, kurumiSpace, channelDir};
}

test('Owner QQ upload of .xlsx/.csv stages to kurumi-space/qq-inbox without leaking filename in trace logs', async t => {
  const {root, cfg, kurumiSpace, channelDir} = setupFixture(t, OWNER);
  const sampleBytes = Buffer.from('日期,金额\n2026-11-01,12.50\n', 'utf8');

  const staged = await stageAttachment(
    {type: 'file', data: {name: '2026-11测试账单.csv', file_id: 'f-csv-1', size: sampleBytes.length}},
    cfg,
    {
      subjectId: OWNER,
      messageId: '-901',
      sessionKey: `agent:main:kurumi-qq:direct:${OWNER}`,
      now: () => Date.UTC(2026, 10, 24, 12, 0, 0),
      apiCall: async () => ({url: 'https://multimedia.nt.qq.com/download?synthetic=1'}),
      fetcher: async () => new Response(sampleBytes, {status: 200}),
    },
  );

  assert.equal(staged.kind, 'workspace_file');
  assert(staged.path.startsWith(path.join(kurumiSpace, 'qq-inbox', '2026-11-24') + path.sep));
  assert.equal(fs.readFileSync(staged.path, 'utf8'), sampleBytes.toString('utf8'));
  assert.equal(fs.statSync(staged.path).mode & 0o777, 0o600);

  const traceFile = path.join(channelDir, 'trace-events.jsonl');
  const rawTrace = fs.readFileSync(traceFile, 'utf8');
  assert(!rawTrace.includes('2026-11测试账单'));
  const events = filterEvents(collectEvents({runtimeRoot: root, sources: ['trace-events'], from: 0, to: Date.now() + 1000}), {messageId: '-901'});
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'qq.workspace_file_receive');
  assert.equal(events[0].data.fileType, 'csv');
  assert.equal(events[0].data.status, 'staged_to_workspace');
});

test('Member QQ upload of .xlsx is strictly rejected before any download', async t => {
  const {cfg} = setupFixture(t, MEMBER);
  let called = 0;
  await assert.rejects(
    stageAttachment(
      {type: 'file', data: {name: 'bills.xlsx', file_id: 'f-xlsx-1'}},
      cfg,
      {
        subjectId: MEMBER,
        apiCall: async () => { called++; return {url: 'https://multimedia.nt.qq.com/download'}; },
      },
    ),
    {code: 'unsupported_file_type'},
  );
  assert.equal(called, 0);
});

test('Redline-named owner upload like .env.xlsx is neutralized before saving, and .env is rejected', async t => {
  const {cfg} = setupFixture(t, OWNER);
  await assert.rejects(
    stageAttachment(
      {type: 'file', data: {name: '.env', file_id: 'f-env-1'}},
      cfg,
      {subjectId: OWNER, apiCall: async () => { throw Error('must not download'); }},
    ),
    {code: 'unsupported_file_type'},
  );

  const bytes = Buffer.from('a,b\n1,2\n');
  const staged = await stageAttachment(
    {type: 'file', data: {name: '.env.csv', file_id: 'f-env-csv'}},
    cfg,
    {
      subjectId: OWNER,
      apiCall: async () => ({url: 'https://multimedia.nt.qq.com/download?synthetic=2'}),
      fetcher: async () => new Response(bytes, {status: 200}),
    },
  );
  assert(!path.basename(staged.path).endsWith('_.env.csv'));
  assert(path.basename(staged.path).includes('_env.csv'));
});

test('handleInbound routes staged_to_workspace attachment directly to model with real path in qq_attachment_results', async t => {
  const {cfg, kurumiSpace} = setupFixture(t, OWNER);
  const contexts = [];
  const deliveries = [];
  const runtime = {
    channel: {
      routing: {resolveAgentRoute: () => ({agentId: 'main', sessionKey: `agent:main:kurumi-qq:direct:${OWNER}`})},
      session: {resolveStorePath: () => '/unused', recordInboundSession: async () => {}},
      reply: {
        finalizeInboundContext: x => x,
        dispatchReplyWithBufferedBlockDispatcher: async ({ctx}) => { contexts.push(ctx); },
      },
    },
  };
  const stagedPath = path.join(kurumiSpace, 'qq-inbox', '2026-11-24', 'abc_bills.xlsx');
  const event = {
    post_type: 'message',
    message_type: 'private',
    self_id: Number(BOT),
    user_id: Number(OWNER),
    message_id: -902,
    message: [{type: 'file', data: {name: 'bills.xlsx', file_id: 'f-xlsx-2'}}],
  };

  const stageStub = async () => ({kind: 'workspace_file', path: stagedPath, sha256: 'a'.repeat(64), sizeBytes: 123});
  stageStub.supportsWorkspaceFiles = true;

  const res = await handleInbound({
    cfg,
    runtime,
    event,
    selfId: BOT,
    stageFile: stageStub,
    deliverOverride: async p => deliveries.push(p),
  });
  assert.equal(res.modelDispatched, true);
  assert.equal(contexts.length, 1);
  assert.equal(deliveries.length, 0);
  const match = contexts[0].BodyForAgent.match(/<qq_attachment_results>(.*?)<\/qq_attachment_results>/s);
  assert(match);
  const parsed = JSON.parse(match[1]);
  assert.equal(parsed[0].status, 'staged_to_workspace');
  assert.equal(parsed[0].path, stagedPath);
});
