// Isolated OpenClaw + loopback OneBot. Only the PDF CDN bytes and model are
// fixtures. No real account, translation, paid model, or production state.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {once} from 'node:events';
import {copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {dirname, isAbsolute, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {compileAccessConfig} from '../../packages/access-control/config.js';
import {Documents, sha256} from '../../packages/documents/index.js';
import {sendPayload} from '../../packages/qq-delivery/index.js';
import {memberRow, ownerPolicy} from '../access-control/fixtures.mjs';
import {withHostControl} from '../access-control/host-config.mjs';
import {fixturePdf, fixturePdfUrl} from './fixtures/pdf-fetch.mjs';
import {startIsolatedGateway} from './isolated-gateway.mjs';
import {createOneBotPeer, readOneBotLedger, textOfSend, waitForAcceptance, waitForOneBotTurn} from './onebot-peer.mjs';

const [flag, out, ...extra] = process.argv.slice(2);
assert(flag === '--out' && isAbsolute(out ?? '') && !extra.length && !existsSync(out), 'Require a new absolute --out');
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'kurumi-media-acceptance-'));
const owner = '810001', member = '810002', bot = '810003';
const token = randomBytes(24).toString('hex'), tokenFile = join(root, 'onebot-token');
const channelDir = join(root, 'channel'), mediaRoot = join(root, 'media'), papers = join(root, 'documents');
const workspace = join(root, 'workspace'), memberWorkspace = join(root, 'users', member, 'workspace');
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXx0AAAAASUVORK5CYII=', 'base64');
const imageFile = join(mediaRoot, 'fixture.png'), quoteId = 200, quote = '只属于合成主人的引用正文';
const uploads = [], lookups = [];
const report = {cases: [], primaryModel: 'fixture/fixture',
  boundary: 'Formal OneBot WebSocket, media adapter and PDF catalog; deterministic model, local PNG, substitute CDN bytes.'};
let peer, model, gateway, modelFault, mode, cfg, documentId, calls = 0;

function answer(request, response) {
  const turn = request.messages.findLast(message => message.role === 'user' && JSON.stringify(message.content).includes('介质验收'));
  assert(turn, 'Model did not receive the scenario input');
  const content = JSON.stringify(turn.content);
  const call = request.messages.findLast(message => message.role === 'tool');
  let message = {role: 'assistant', content: '介质验收回执'};
  if (mode === 'quote-image') {
    assert(content.includes(quote), 'The owner quote was not rendered');
    assert(Array.isArray(turn.content) && turn.content.some(part => part.type === 'image_url'), 'The PNG was not delivered to the model');
  } else if (mode === 'foreign-quote') {
    assert(content.includes('引用正文未加载') && !content.includes(quote), 'Member context contains the owner quote');
  } else if (mode === 'pdf') {
    assert(content.includes('验收论文.pdf'), 'The imported attachment was not announced to the model');
    documentId = content.match(/doc_[a-f0-9]{32}/u)?.[0];
    assert(documentId, 'The current attachment has no managed ID');
    if (!call) {
      assert(request.tools?.some(tool => tool.function.name === 'kurumi_document_send'));
      message = {role: 'assistant', content: null, tool_calls: [{id: 'fixture_pdf_delivery', type: 'function',
        function: {name: 'kurumi_document_send', arguments: JSON.stringify({documentId})}}]};
    } else {
      assert(JSON.stringify(call.content).includes('platform_accepted'), 'The managed PDF tool has no receipt');
    }
  }
  const finish = message.tool_calls ? 'tool_calls' : 'stop';
  const base = {id: 'media-fixture-' + calls, model: 'fixture', created: 1};
  if (!request.stream) {
    response.setHeader('content-type', 'application/json');
    return response.end(JSON.stringify({...base, object: 'chat.completion', choices: [{index: 0, message, finish_reason: finish}]}));
  }
  const chunk = (delta, reason) => 'data: ' + JSON.stringify({...base, object: 'chat.completion.chunk',
    choices: [{index: 0, delta, finish_reason: reason}]}) + '\n\n';
  if (message.tool_calls) message.tool_calls[0].index = 0;
  response.setHeader('content-type', 'text/event-stream');
  response.end(chunk(message, null) + chunk({}, finish) + 'data: [DONE]\n\n');
}

const textSegment = text => ({type: 'text', data: {text}});
const replySegment = {type: 'reply', data: {id: String(quoteId)}};
function check() {
  peer.check();
  if (modelFault) throw modelFault;
}
async function exchange(subject, segments, kind) {
  mode = kind;
  const before = peer.sends.length;
  const event = peer.message(subject, segments);
  const id = await peer.send(event);
  await waitForOneBotTurn(channelDir, [id], {check});
  const replies = peer.sends.slice(before);
  assert(replies.some(entry => String(entry.user_id) === subject && entry.accepted && textOfSend(entry).includes('介质验收回执')));
  assert(replies.every(entry => String(entry.user_id) === subject));
  return event;
}

try {
  for (const dir of [workspace, memberWorkspace, mediaRoot, channelDir]) mkdirSync(dir, {recursive: true, mode: 0o700});
  writeFileSync(tokenFile, token, {mode: 0o600});
  writeFileSync(imageFile, image, {mode: 0o600});
  copyFileSync(join(repo, 'scripts/fusion/templates/MEMBER_AGENTS.md'), join(memberWorkspace, 'AGENTS.md'));
  peer = await createOneBotPeer({token, botId: bot, subjects: [owner, member], methods: {
    get_msg({message_id}) {
      assert.equal(message_id, quoteId);
      return {message_type: 'private', sender: {user_id: Number(owner)}, target_id: Number(bot), message: [textSegment(quote)]};
    },
    get_private_file_url({user_id, file_id}) {
      assert.equal(String(user_id), member);
      assert.equal(file_id, 'synthetic-paper');
      lookups.push(file_id);
      return {url: fixturePdfUrl};
    },
    upload_private_file({user_id, file, name}) {
      assert.equal(String(user_id), member);
      assert(realpathSync(file).startsWith(join(papers, 'subjects', member) + '/'));
      uploads.push({filename: name, hash: sha256(readFileSync(file))});
      return {file_id: 'fixture-upload'};
    },
  }});
  model = createServer(async (request, response) => {
    try {
      assert.equal(request.url, '/v1/chat/completions');
      assert(++calls <= 12, 'Fixture model request budget exceeded');
      let body = '';
      for await (const piece of request) body += piece;
      answer(JSON.parse(body), response);
    } catch (error) {
      modelFault ??= error;
      response.writeHead(400).end('{"error":{"message":"media fixture failed"}}');
    }
  });
  model.listen(0, '127.0.0.1');
  await once(model, 'listening');
  const modelChoice = {primary: 'fixture/fixture'};
  const ids = ['kurumi-qq', 'kurumi-papers'];
  const policy = ownerPolicy(owner);
  policy.subjects.push({...memberRow(member), permissions: {
    'chat.use': true, 'qq.reply': true, 'papers.import': true, 'papers.read': true, 'qq.file.reply': true,
  }});
  cfg = withHostControl(compileAccessConfig({
    agents: {ownership: 'explicit', defaults: {workspace, systemAgent: {agentId: 'main'}, model: modelChoice, heartbeat: {every: '0m'}},
      entries: {main: {workspace, model: modelChoice, tools: {allow: ['kurumi_document_send']}}}},
    models: {catalogRefresh: {enabled: false}, providers: {fixture: {baseUrl: 'http://127.0.0.1:' + model.address().port + '/v1',
      apiKey: 'synthetic', api: 'openai-completions', models: [{id: 'fixture', name: 'fixture',
        input: ['text', 'image'], contextWindow: 64000, maxTokens: 600}]}}},
    plugins: {allow: ids, load: {paths: ids.map(id => join(repo, 'chatbot/plugins', id))}, entries: {
      'kurumi-qq': {enabled: true}, 'kurumi-papers': {enabled: true, config: {
        root: papers, python: '/usr/bin/false', credentialsFile: join(root, 'absent'), liveTranslationEnabled: false}},
    }, slots: {memory: 'none'}},
    channels: {'kurumi-qq': {enabled: true, httpUrl: peer.httpUrl, wsUrl: peer.wsUrl, httpTokenFile: tokenFile,
      wsTokenFile: tokenFile, stateDir: channelDir, mediaRoot, testIngress: false}},
    tools: {toolSearch: false, codeMode: false, web: {search: {enabled: false}, fetch: {enabled: false}}},
    session: {dmScope: 'per-channel-peer'}, cron: {enabled: false}, update: {checkOnStart: false},
    logging: {file: join(root, 'runtime.log')},
  }, policy), repo);
  gateway = await startIsolatedGateway({repo, root, token, configure: () => cfg, preload: new URL('./fixtures/pdf-fetch.mjs', import.meta.url).href});
  await gateway.ready();
  await waitForAcceptance(peer.connected, 'media OneBot socket');
  const event = await exchange(owner, [textSegment('介质验收，查看图片和引用。'), replySegment, {type: 'image', data: {file: imageFile}}], 'quote-image');
  const receipt = await sendPayload({cfg, to: 'user:' + owner, text: '返图', mediaUrl: imageFile, replyToId: event.message_id, key: 'fixture-image'});
  const imageReply = peer.sends.find(entry => entry.messageId === receipt.messageId);
  assert.equal(String(imageReply.user_id), owner);
  assert.deepEqual(imageReply.message.find(segment => segment.type === 'reply'), {type: 'reply', data: {id: String(event.message_id)}});
  assert.equal(imageReply.message.find(segment => segment.type === 'image')?.data.file, 'base64://' + image.toString('base64'));
  assert.equal(readOneBotLedger(channelDir, db => db.prepare('SELECT status FROM outbound WHERE message_id=?').get(receipt.messageId))?.status, 'sent');
  report.cases.push('Private quote and staged image reach the model; image and explicit reply have a recorded OneBot receipt');

  await exchange(member, [textSegment('介质验收，查看他人的引用。'), replySegment], 'foreign-quote');
  report.cases.push('A member cannot read the owner quote');

  const upload = await exchange(member, [textSegment('介质验收，请把这份 PDF 发给我。'),
    {type: 'file', data: {name: '验收论文.pdf', file_id: 'synthetic-paper'}}], 'pdf');
  const doc = new Documents(join(papers, 'subjects', member)).describe(documentId);
  assert.equal(doc.pages, 1);
  assert.equal(doc.sha256, sha256(fixturePdf()));
  assert.deepEqual(uploads, [{filename: '验收论文.pdf', hash: doc.sha256}]);
  await peer.send(upload);
  await exchange(member, '介质验收，核对重复消息。', 'follow-up');
  assert.deepEqual(lookups, ['synthetic-paper']);
  assert.equal(uploads.length, 1);
  report.cases.push('PDF intake verifies the real file and same-member receipt; a replay adds neither a lookup nor an upload');
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = modelFault?.message ?? error.message;
} finally {
  if (await gateway?.close() === false) {
    report.passed = false;
    report.error ??= 'Isolated Gateway did not stop gracefully';
  }
  model?.closeAllConnections();
  await Promise.all([peer?.close(), model && new Promise(resolve => model.close(resolve))]);
  report.configSha256 = gateway?.configSha256;
  if (report.passed) rmSync(root, {recursive: true, force: true});
  else {report.diagnosticsRoot = root; process.exitCode = 1;}
  report.fixtureCleaned = !existsSync(root);
  mkdirSync(dirname(out), {recursive: true});
  writeFileSync(out, JSON.stringify(report, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  console.log(JSON.stringify({passed: report.passed, cases: report.cases.length, error: report.error, evidence: out}));
}
