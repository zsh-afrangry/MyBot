// Registered paper and mail tools with a fixture translator, loopback OneBot HTTP and temporary state.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {Documents} from '../../packages/documents/index.js';
import {createMailPlugin} from '../../plugins/kurumi-mail/index.js';
import {createPaperPlugin} from '../../plugins/kurumi-papers/index.js';
import {PaperService} from '../../plugins/kurumi-papers/service.js';
import {context, memberRow, withAccess} from '../access-control/fixtures.mjs';
import {waitForAcceptance} from '../acceptance/onebot-peer.mjs';
import {pdf} from './fixtures.mjs';

const ownerId = '810001';
const member = memberRow('810002');
const recipient = 'owner@example.test';
const dual = pdf('Synthetic dual translation');
const mono = pdf('Synthetic mono translation');
const inspect = async () => ({pages: 1});

test('two generated PDFs retain distinct QQ and mail evidence, including a lost reply', async t => {
  const root = mkdtempSync(join(tmpdir(), 'kurumi-paper-feedback-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const savedStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = root;
  t.after(() => {
    if (savedStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = savedStateDir;
  });
  const tokenFile = join(root, 'onebot-token');
  writeFileSync(tokenFile, 'onebot-fixture', {mode: 0o600});
  const uploads = [];
  let fault;
  const onebot = createServer(async (req, res) => {
    try {
      assert.equal(req.url, '/upload_private_file');
      assert.equal(req.headers.authorization, 'Bearer onebot-fixture');
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const {file, user_id: to} = JSON.parse(Buffer.concat(chunks));
      assert.equal(String(to), ownerId);
      uploads.push(file);
      if (uploads.length === 2) {
        assert.deepEqual(readFileSync(file), mono);
        req.socket.destroy();
        return;
      }
      assert.deepEqual(readFileSync(file), uploads.length === 1 ? dual : mono);
      res.end(JSON.stringify({status: 'ok', retcode: 0, data: uploads.length === 1 ? null : {file_id: 'fixture-manual'}}));
    } catch (error) { fault = error; res.writeHead(400).end(); }
  });
  onebot.listen(0, '127.0.0.1');
  await once(onebot, 'listening');
  t.after(() => new Promise(resolve => {onebot.closeAllConnections(); onebot.close(resolve);}));

  const paper = {root: join(root, 'papers'), liveTranslationEnabled: true};
  const mail = {allowedRecipients: [recipient]};
  const cfg = withAccess({
    channels: {'kurumi-qq': {enabled: true, httpUrl: 'http://127.0.0.1:' + onebot.address().port,
      wsUrl: 'ws://127.0.0.1:1', httpTokenFile: tokenFile, stateDir: join(root, 'qq')}},
    agents: {entries: {main: {tools: {alsoAllow: ['email_outbox']}}}},
    plugins: {entries: {'kurumi-papers': {config: paper}, 'kurumi-mail': {enabled: true, config: mail}}},
  }, ownerId);
  const {subjects} = cfg.channels['kurumi-qq'].accessControl;
  const [owner] = subjects;
  subjects.push(member);
  const documents = new Documents(paper.root);
  const input = await documents.add(pdf('Synthetic source'), {filename: 'fixture.pdf'}, {inspect});
  const tools = new Map();
  let service, workerRuns = 0;
  const paperPlugin = createPaperPlugin({serviceFactory(config, deps) {
    service = new PaperService(config, {...deps, inspect,
      async runner({work}) {
        workerRuns++;
        const files = {dual: join(work, 'dual.pdf'), mono: join(work, 'mono.pdf')};
        writeFileSync(files.dual, dual);
        writeFileSync(files.mono, mono);
        return files;
      },
    });
    return service;
  }});
  const register = (plugin, pluginConfig) => plugin.register({config: cfg, pluginConfig,
    registerService() {}, registerTool(definition, {name} = {}) {
      tools.set(name ?? definition.create(context(owner)).name, definition);
    },
  });
  register(paperPlugin, paper);
  register(createMailPlugin(), mail);
  service.start();
  t.after(() => service.stop());

  const call = async (tool, args, actor = owner, invocation = tool) => {
    const result = await tools.get(tool).create(context(actor)).execute(invocation, args);
    return JSON.parse(result.content[0].text);
  };
  const start = await call('kurumi_translate', {action: 'start', documentId: input.id, output: 'both'});
  assert(start.ok);
  const jobId = start.job.id;
  await waitForAcceptance(() => !service.active && service.get(jobId).delivery?.status === 'failed_or_unknown', 'PDF receipts');
  if (fault) throw fault;
  assert.equal(workerRuns, 1);
  assert.equal(uploads.length, 2);

  const status = async (actor = owner) => (await call('kurumi_translate', {action: 'status', jobId}, actor)).job;
  const get = (documentId, actor = owner) => call('kurumi_document', {action: 'get', documentId}, actor);
  const find = (view, action, id) => view.feedback.find(row => row.action === action && (!id || row.evidence.documentId === id));
  const before = await status();
  const {dual: dualId, mono: monoId} = before.artifacts;
  assert.equal(before.status, 'succeeded');
  assert.deepEqual(find(before, 'paper.translate').evidence.outputs,
    [{kind: 'dual', documentId: dualId, status: 'generated'}, {kind: 'mono', documentId: monoId, status: 'generated'}]);
  const dualQQ = find(before, 'paper.qq_upload', dualId);
  assert.equal(dualQQ.status, 'accepted');
  assert.equal(dualQQ.evidence.automatic.fileId, undefined);
  assert.equal(dualQQ.evidence.clientDelivery, 'unknown');
  assert.equal(find(before, 'paper.qq_upload', monoId).status, 'unknown');
  assert.equal(find(await get(monoId), 'paper.qq_upload').status, 'unknown');
  assert.equal(find(await get(dualId), 'paper.mail_draft').status, 'unrecorded');

  const draft = await call('email_draft', {to: recipient, subject: 'Synthetic fixture subject', text: 'Private fixture body',
    attachments: [{documentId: monoId}]});
  assert(draft.ok);
  const after = await status();
  assert.equal(find(after, 'paper.mail_draft', dualId).status, 'unrecorded');
  assert.equal(find(after, 'paper.mail_draft', monoId).evidence.drafts[0].draftId, draft.draftId);
  assert.equal(find(await get(monoId), 'paper.mail_draft').status, 'drafted');
  assert(!JSON.stringify(after.feedback).includes('Private fixture body'));
  assert(!JSON.stringify(after.feedback).includes(recipient));
  assert.equal(await status(member), undefined);
  assert.equal((await get(monoId, member)).ok, false);
  // Identical output bytes can have the same ID in another member's private catalog.
  const memberDocs = new Documents(join(paper.root, 'subjects', member.qq));
  assert.equal((await memberDocs.add(mono, {kind: 'artifact'}, {inspect})).id, monoId);
  const memberPdf = await get(monoId, member);
  assert.equal(find(memberPdf, 'paper.qq_upload').status, 'unrecorded');
  assert.equal(find(memberPdf, 'paper.mail_draft'), undefined);
  owner.permissions['mail.history'] = false;
  assert.equal(find(await get(monoId), 'paper.mail_draft'), undefined);
  owner.permissions['mail.history'] = true;
  cfg.agents.entries.main.tools.alsoAllow = [];
  assert.equal(find(await get(monoId), 'paper.mail_draft'), undefined);
  cfg.agents.entries.main.tools.alsoAllow = ['email_outbox'];

  assert.deepEqual(await status(), after);
  await service.stop();
  service.start();
  assert.deepEqual(await status(), after);
  assert.equal(workerRuns, 1);
  assert.equal(uploads.length, 2);

  const resend = await call('kurumi_document_send', {documentId: monoId});
  assert.equal(resend.status, 'platform_accepted');
  const latest = find(await get(monoId), 'paper.qq_upload');
  assert.equal(latest.status, 'accepted');
  assert.equal(latest.evidence.attempts[0].fileId, 'fixture-manual');
  assert.equal(find(await status(), 'paper.qq_upload', monoId).evidence.automatic.platformStatus, 'unknown');
  assert.equal(uploads.length, 3);
  if (fault) throw fault;
});
