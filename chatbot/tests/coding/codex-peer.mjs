// Local app-server protocol fixture. No model, real credential, QQ or network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';

const [outside, mode] = process.argv.slice(2), home = process.env.CODEX_HOME;
const marker = path.join(home, 'thread-id'), cwd = process.cwd();
let threadId, turnId, approvalId, child;
const send = frame => process.stdout.write(JSON.stringify(frame) + '\n');
const reply = (id, result) => send({id, result});
const notice = (method, params) => send({method, params: {threadId, turnId, ...params}});
const complete = status => notice('turn/completed', {turn: {id: turnId, status}});
const commandItem = (id, output) => ({type: 'commandExecution', id, status: 'completed', aggregatedOutput: output});
readline.createInterface({input: process.stdin}).on('line', line => {
  const {id, method, params} = JSON.parse(line);
  if (method === 'initialize') {
    assert.equal(params.clientInfo.name, 'kurumi-coding');
    reply(id, {platformOs: 'linux', codexHome: home});
  } else if (method === 'initialized') {
    return;
  } else if (method === 'thread/start' || method === 'thread/resume') {
    assert.deepEqual([params.cwd, params.sandbox, params.approvalPolicy, params.approvalsReviewer], [cwd, 'workspace-write', 'on-request', 'user']);
    if (method === 'thread/resume') {
      assert.equal(params.threadId, fs.readFileSync(marker, 'utf8'));
      threadId = mode === 'wrong-thread' ? randomUUID() : params.threadId;
    } else {
      assert.equal(params.ephemeral, false);
      threadId = randomUUID(); fs.writeFileSync(marker, threadId);
    }
    reply(id, {thread: {id: threadId}, cwd, approvalPolicy: 'on-request', approvalsReviewer: 'user',
      sandbox: {type: 'workspaceWrite', networkAccess: mode === 'wrong-policy', writableRoots: []}});
  } else if (method === 'turn/start') {
    assert.equal(params.threadId, threadId);
    turnId = randomUUID();
    const text = params.input[0].text;
    if (text.endsWith('FIXTURE_WAIT')) {
      reply(id, {turn: {id: turnId, status: 'inProgress'}});
      child = spawn(process.execPath, ['-e', "const fs=require('node:fs');setInterval(()=>fs.appendFileSync('heartbeat','x'),20)"], {stdio: 'ignore'});
      return;
    }
    if (text.endsWith('FIXTURE_APPROVAL')) {
      reply(id, {turn: {id: turnId, status: 'inProgress'}});
      approvalId = 'fixture-approval';
      send({id: approvalId, method: 'item/commandExecution/requestApproval', params: {threadId, turnId, itemId: 'call_approval', cwd}});
      return;
    }
    // File and ledger writes are checked independently of the simulated backend's response.
    assert.throws(() => fs.writeFileSync(outside, 'must not change'), {code: 'EACCES'});
    const source = fs.readFileSync('value.mjs', 'utf8');
    const value = Number(/\d+/.exec(source)[0]) + 1;
    fs.writeFileSync('value.mjs', `export const value = ${value};\n`);
    notice('item/completed', {turnId: randomUUID(), item: commandItem('call_stale', 'unrelated turn output')});
    notice('item/completed', {item: commandItem('call_current', 'fixture actual stdout ' + value)});
    reply(id, {turn: {id: turnId, status: 'inProgress'}});
    notice('item/completed', {item: {type: 'reasoning', id: 'reasoning', content: ['private reasoning']}});
    notice('item/completed', {item: {type: 'agentMessage', id: 'report', text: 'fixture model report'}});
    complete('completed');
  } else if (method === 'turn/interrupt') {
    assert.deepEqual(params, {threadId, turnId});
    child?.kill('SIGTERM'); reply(id, {}); complete('interrupted');
  } else if (method === 'thread/unsubscribe') {
    assert.equal(params.threadId, threadId);
    reply(id, {status: 'unsubscribed'});
  } else if (id === approvalId && !method) {
    const result = JSON.parse(line).result;
    assert.deepEqual(result, {decision: 'decline'});
    complete('interrupted');
  } else throw Error('Unexpected fixture frame');
}).on('close', () => {child?.kill('SIGTERM'); process.exit(0);});
