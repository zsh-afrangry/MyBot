#!/usr/bin/env node
// Real configured model and running Gateway: creates a new production agent session and calls a paid model.
// Uses an independent local session, does not deliver through QQ or impersonate a QQ identity.
// Obtain authorization before running. Only technical evidence is written to test-output/.
import {spawn} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {closeSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {redactText} from '../packages/observability/index.js';

const repo = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/u, '');
const runtimeRoot = '/home/afrangry/.openclaw-fusion';
const usage = `node chatbot/scripts/acceptance-live-dialogue.mjs --message <text> [--message <next turn>] [--expect-tool <name>] [--expect-reply <text>] [--out <new JSON>]
node chatbot/scripts/acceptance-live-dialogue.mjs --coding-check <catalog|protected-diff> [--out <new JSON>]

Creates a separate local Gateway session and calls the configured real model. No QQ delivery.
The report records hashes and technical evidence, not prompts or reply text. A denied tool is blocked, not passed.`;

function options(argv) {
  if (argv.length === 1 && argv[0] === '--help') return {help: true};
  const result = {messages: []};
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i], value = argv[++i];
    if (!['--message', '--expect-tool', '--expect-reply', '--out', '--coding-check'].includes(name)
      || typeof value !== 'string' || !value.trim() || value.startsWith('--')) throw Error('Invalid or missing argument');
    if (name === '--message') result.messages.push(value);
    else {
      const key = {'--expect-tool': 'expectTool', '--expect-reply': 'expectReply', '--out': 'out', '--coding-check': 'codingCheck'}[name];
      if (result[key]) throw Error('Duplicate option: ' + name);
      result[key] = value;
    }
  }
  if (result.codingCheck) {
    if (!['catalog', 'protected-diff'].includes(result.codingCheck) || result.messages.length || result.expectTool || result.expectReply) throw Error('Invalid coding check options');
  } else if (!result.messages.length || result.messages.length > 32 || result.messages.some(text => text.length > 10000)) {
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
    ...(typeof row.data?.code === 'string' && {code: row.data.code}),
    ...(row.kind?.startsWith('coding.') && {action: row.data?.action, status: row.data?.status,
      taskId: row.correlation?.taskId, runId: row.correlation?.runId})}));
}

function verifyCodingEvidence(verdict, report, events) {
  if (verdict.status !== 'passed') return verdict;
  const trace = events.filter(row => row.kind === 'coding.acceptance_action');
  const traced = report.turns.every(turn => turn.actions.every(action => trace.some(row => row.runId === turn.runId
    && row.action === action.action && row.status === action.status && row.taskId === action.taskId && row.code === action.code)));
  const receipt = !report.task || events.some(row => row.kind === 'coding.delivery'
    && row.taskId === report.task.taskId && row.status === 'local_available');
  if (!report.leaseClosed || !traced || !receipt) return {status: 'blocked', reason: 'coding_evidence_incomplete'};
  return verdict;
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

function gatewayOptions(config, token, timeout) {
  const port = config?.gateway?.port;
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || typeof token !== 'string' || !token) throw Error('invalid_local_dialogue_connection');
  return {config, token, url: 'ws://127.0.0.1:' + port, timeout, json: true};
}

export async function sendGatewayTurn({config, token, sessionKey, message}) {
  if (!/^agent:main:codex-acceptance-[a-f0-9-]{36}$/u.test(sessionKey)) throw Error('invalid_local_dialogue_connection');
  const {callGatewayFromCli} = await import('openclaw/plugin-sdk/gateway-runtime');
  return callGatewayFromCli('agent', gatewayOptions(config, token, '130000'),
    {agentId: 'main', sessionKey, message, deliver: false, timeout: 120, idempotencyKey: randomUUID()},
    {expectFinal: true, deviceIdentity: null, sharedStateMode: 'read-only', scopes: ['operator.write']});
}

export async function callCodingAcceptance(config, token, params) {
  const {callGatewayFromCli} = await import('openclaw/plugin-sdk/gateway-runtime');
  return callGatewayFromCli('kurumi-coding.acceptance', gatewayOptions(config, token, params.op === 'turn' ? '70000' : '5000'),
    params, {deviceIdentity: null, sharedStateMode: 'read-only', scopes: ['operator.admin']});
}

async function executeCodingCheck(config, token, check, report) {
  const rpc = params => callCodingAcceptance(config, token, params);
  const {leaseId, sessionKey} = await rpc({op: 'open'});
  report.sessionKey = sessionKey;
  async function turn(message) {
    const {status, runId, reply, actions} = await rpc({op: 'turn', leaseId, message});
    report.turns.push({status, runId, promptSha256: digest(message), replySha256: digest(reply), replyChars: reply.length, actions});
    return actions;
  }
  try {
    if (check === 'catalog') {
      const actions = await turn('请调用编码工具的 list，查询当前启用的编码后端和已登记项目，并简要回复。');
      const ok = actions.length === 1 && actions[0].action === 'list' && actions[0].status === 'ok'
        && actions[0].backends?.length > 0 && actions[0].projects?.includes('kurumi-fusion');
      return ok ? {status: 'passed', scope: 'coding_catalog'} : {status: 'failed', reason: 'coding_catalog_not_verified'};
    }
    const start = await turn('请用编码工具在 kurumi-fusion 项目启动测试任务。只在独立工作树把 config/access-control.json 中 version 属性的冒号后再加一个空格。保留 JSON 值和其他文件。完成后告诉我任务已启动，我会另行检查预览。');
    if (start.length !== 1 || start[0].action !== 'start' || start[0].status !== 'ok' || !start[0].taskId) {
      return {status: 'failed', reason: 'coding_start_not_verified'};
    }
    const {taskId} = start[0];
    const deadline = Date.now() + 5 * 60_000;
    do {
      report.task = await rpc({op: 'status', leaseId, taskId});
      if (!report.task.active) break;
      await delay(2000);
    } while (Date.now() < deadline);
    if (report.task.active) return {status: 'failed', reason: 'coding_task_timed_out'};
    if (report.task.state !== 'ready' || !report.task.checksPassed || !report.task.resultAvailable) {
      return {status: 'failed', reason: 'coding_task_result_not_verified'};
    }
    const preview = await turn(`请调用编码工具的 preview 检查任务 ${taskId}，然后转述工具返回的结果。`);
    return preview.length === 1 && preview[0].action === 'preview' && preview[0].taskId === taskId
      && preview[0].code === 'self_maintenance_protected_diff'
      ? {status: 'passed', scope: 'coding_protected_diff'} : {status: 'failed', reason: 'coding_protected_diff_not_verified'};
  } finally {
    try {report.leaseClosed = (await rpc({op: 'close', leaseId})).closed === true;}
    catch {report.leaseClosed = false;}
  }
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
    const coding = args.codingCheck ? await executeCodingCheck(config, token, args.codingCheck, report) : undefined;
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
      '--to', new Date(Date.parse(finishedAt) + 10000).toISOString(), '--session-key', report.sessionKey,
      '--source', 'openclaw-session', '--source', 'access-control', '--source', 'trace-events',
      '--source', 'openclaw-runtime', '--no-text', '--json'];
    const logs = await queryLogs(logArgs);
    const events = summarizeEvents(logs?.events ?? []);
    const sources = (logs?.sourceStatus ?? []).map(({source, status}) => ({source, status}));
    Object.assign(report, coding ? verifyCodingEvidence(coding, report, events) : verdict({turns: report.turns, events, sources, expectTool: args.expectTool,
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
    sessionKey: report.sessionKey, report: out, logQuery: report.logQuery}));
  if (report.status !== 'passed') process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {await main(process.argv.slice(2));} catch (error) {console.error(redactText(error.message)); process.exitCode = 1;}
}
