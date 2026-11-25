#!/usr/bin/env node
// Real configured model and running Gateway: creates a new production agent session and calls a paid model.
// Uses an independent local session, does not deliver through QQ or impersonate a QQ identity.
// Obtain authorization before running. Only technical evidence is written to test-output/.
import {spawn} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {closeSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {redactText} from '../packages/observability/index.js';

const repo = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/u, '');
const runtimeRoot = '/home/afrangry/.openclaw-fusion';
const usage = `node chatbot/scripts/acceptance-live-dialogue.mjs --message <text> [--message <next turn>] [--expect-tool <name>] [--expect-reply <text>] [--out <new JSON>]

Creates a separate local Gateway session and calls the configured real model. No QQ delivery.
The report records hashes and technical evidence, not prompts or reply text. A denied tool is blocked, not passed.`;

function options(argv) {
  if (argv.length === 1 && argv[0] === '--help') return {help: true};
  const result = {messages: []};
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i], value = argv[++i];
    if (!['--message', '--expect-tool', '--expect-reply', '--out'].includes(name)
      || typeof value !== 'string' || !value.trim() || value.startsWith('--')) throw Error('Invalid or missing argument');
    if (name === '--message') result.messages.push(value);
    else {
      const key = {'--expect-tool': 'expectTool', '--expect-reply': 'expectReply', '--out': 'out'}[name];
      if (result[key]) throw Error('Duplicate option: ' + name);
      result[key] = value;
    }
  }
  if (!result.messages.length || result.messages.length > 32 || result.messages.some(text => text.length > 10000)) {
    throw Error('Require 1–32 messages of at most 10000 characters');
  }
  if (result.expectTool && !/^[a-z][a-z0-9_]{0,79}$/u.test(result.expectTool)) throw Error('Invalid expected tool name');
  return result;
}

function reserveOutput(requested) {
  const root = join(repo, 'test-output');
  const out = requested ? resolve(requested) : join(root, 'scenario-acceptance', 'live-dialogue-' + randomUUID() + '.json');
  if (!out.startsWith(root + '/') || !out.endsWith('.json')) throw Error('--out must be a new JSON file under test-output/');
  mkdirSync(root, {recursive: true, mode: 0o700});
  if (realpathSync(root) !== root) throw Error('test-output must be a real directory');
  let parent = root;
  for (const part of out.slice(root.length + 1).split('/').slice(0, -1)) {
    parent = join(parent, part);
    try {mkdirSync(parent, {mode: 0o700});} catch (error) {if (error.code !== 'EEXIST') throw error;}
    if (lstatSync(parent).isSymbolicLink() || !lstatSync(parent).isDirectory()) throw Error('Output directory must not be a symlink');
  }
  return {out, fd: openSync(out, 'wx', 0o600)};
}

const digest = value => createHash('sha256').update(value).digest('hex');

export function summarizeEvents(events) {
  return events.map(row => ({source: row.source, kind: row.kind,
    ...(typeof (row.data?.tool ?? row.data?.toolName) === 'string' && {tool: row.data.tool ?? row.data.toolName}),
    ...(typeof row.data?.decision === 'string' && {decision: row.data.decision}),
    ...(typeof row.data?.code === 'string' && {code: row.data.code})}));
}

export function verdict({turns, events, sources, expectTool, expectReplyMatched = true}) {
  const denied = events.filter(row => row.source === 'access-control' && row.decision === 'deny');
  if (denied.length) return {status: 'blocked', reason: 'tool_authorization_denied'};
  if (!turns.length || turns.some(turn => turn.status !== 'ok' || !turn.replyChars)) return {status: 'failed', reason: 'dialogue_incomplete'};
  if (!sources.some(source => source.source === 'openclaw-session' && source.status === 'available')
    || !sources.some(source => source.source === 'access-control' && source.status === 'available')
    || events.filter(row => row.kind === 'agent.inbound').length < turns.length
    || events.filter(row => row.kind === 'agent.reply').length < turns.length) {
    return {status: 'blocked', reason: 'log_evidence_unavailable'};
  }
  if (expectTool && !events.some(row => row.kind === 'agent.tool_call' && row.tool === expectTool)) {
    return {status: 'failed', reason: 'expected_tool_not_observed'};
  }
  if (!expectReplyMatched) return {status: 'failed', reason: 'expected_reply_not_observed'};
  if (expectTool) return {status: 'unverified', reason: 'business_result_requires_domain_assertion'};
  return {status: 'passed', scope: 'dialogue_only'};
}

export async function sendGatewayTurn({config, token, sessionKey, message}) {
  const port = config?.gateway?.port;
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || typeof token !== 'string' || !token
    || !/^agent:main:codex-acceptance-[a-f0-9-]{36}$/u.test(sessionKey)) throw Error('invalid_local_dialogue_connection');
  const {callGatewayFromCli} = await import('openclaw/plugin-sdk/gateway-runtime');
  return callGatewayFromCli('agent', {config, token, url: 'ws://127.0.0.1:' + port, timeout: '130000', json: true},
    {agentId: 'main', sessionKey, message, deliver: false, timeout: 120, idempotencyKey: randomUUID()},
    {expectFinal: true, deviceIdentity: null, sharedStateMode: 'read-only', scopes: ['operator.write']});
}

async function queryLogs(args) {
  const child = spawn(process.execPath, args, {cwd: repo, stdio: ['ignore', 'pipe', 'ignore']});
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', value => {stdout += value;});
  const code = await new Promise(resolveCode => {
    child.once('error', () => resolveCode(null));
    child.once('close', resolveCode);
  });
  if (code !== 0) return undefined;
  try {return JSON.parse(stdout);} catch {return undefined;}
}

async function main(argv) {
  const args = options(argv);
  if (args.help) {console.log(usage); return;}
  const {out, fd} = reserveOutput(args.out);
  const sessionKey = 'agent:main:codex-acceptance-' + randomUUID();
  const report = {at: new Date().toISOString(), target: 'live-local-dialogue', sessionKey,
    boundary: 'real Gateway and model, local session, no QQ delivery or synthetic QQ authority', turns: []};
  try {
    const {OPENCLAW_GATEWAY_TOKEN: token} = JSON.parse(readFileSync(join(runtimeRoot, 'runtime-env.json'), 'utf8'));
    const config = JSON.parse(readFileSync(join(runtimeRoot, 'openclaw.json'), 'utf8'));
    let lastReply = '';
    for (const message of args.messages) {
      let result;
      try {result = await sendGatewayTurn({config, token, sessionKey, message});}
      catch {
        report.turns.push({status: 'gateway_error', promptSha256: digest(message), replyChars: 0});
        break;
      }
      const payloads = result?.result?.payloads ?? result?.payloads ?? [];
      lastReply = payloads.filter(row => typeof row?.text === 'string' && !row.isError && !row.isReasoning && !row.isCommentary)
        .map(row => row.text).join('\n');
      const status = result?.status ?? 'unknown';
      report.turns.push({status, ...(typeof result?.runId === 'string' && {runId: result.runId}), promptSha256: digest(message),
        replySha256: lastReply ? digest(lastReply) : undefined, replyChars: lastReply.length});
      if (status !== 'ok' || !lastReply) break;
    }
    const finishedAt = new Date().toISOString();
    const logArgs = [join(repo, 'chatbot/scripts/log-query.mjs'), '--from', report.at,
      '--to', new Date(Date.parse(finishedAt) + 10000).toISOString(), '--session-key', sessionKey,
      '--source', 'openclaw-session', '--source', 'access-control', '--source', 'trace-events',
      '--source', 'openclaw-runtime', '--no-text', '--json'];
    const logs = await queryLogs(logArgs);
    const events = summarizeEvents(logs?.events ?? []);
    const sources = (logs?.sourceStatus ?? []).map(({source, status}) => ({source, status}));
    Object.assign(report, verdict({turns: report.turns, events, sources, expectTool: args.expectTool,
      expectReplyMatched: !args.expectReply || lastReply.includes(args.expectReply)}),
    {finishedAt, events, sources, logQuery: {command: process.execPath, args: logArgs},
      ...(args.expectTool && {expectedTool: args.expectTool}),
      ...(args.expectReply && {expectedReplyMatched: lastReply.includes(args.expectReply)})});
  } catch (error) {
    report.status = 'blocked';
    report.reason = 'local_gateway_or_environment_unavailable';
    report.error = typeof error?.code === 'string' && /^[A-Z0-9_]+$/u.test(error.code) ? error.code : 'environment_error';
    report.finishedAt = new Date().toISOString();
  } finally {
    try {writeFileSync(fd, JSON.stringify(report, null, 2) + '\n');} finally {closeSync(fd);}
  }
  console.log(JSON.stringify({status: report.status, reason: report.reason, scope: report.scope, turns: report.turns.length,
    sessionKey, report: out, logQuery: report.logQuery}));
  if (report.status !== 'passed') process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {await main(process.argv.slice(2));} catch (error) {console.error(redactText(error.message)); process.exitCode = 1;}
}
