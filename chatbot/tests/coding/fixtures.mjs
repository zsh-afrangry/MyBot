// Synthetic identities, temporary repositories and injected ACP peers; never production configuration.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {setImmediate as tick} from 'node:timers/promises';
import {withAccess, memberRow} from '../access-control/fixtures.mjs';
import {createCodingPlugin} from '../../plugins/kurumi-coding/index.js';
import {git} from '../../plugins/kurumi-coding/workspaces.js';
import * as core from '../../packages/confirmation-core/dist/index.js';
export {core};
export const owner = '100001', member = '100002';
export function liveConfig() {
  const config = JSON.parse(fs.readFileSync(new URL('../../../config/runtime.config.json', import.meta.url)));
  const plugin = config.plugins.entries['kurumi-coding'].config, parent = plugin.writeBoundary.root;
  if (parent !== '/home/afrangry/.local/share/kurumi-coding-pilot-20261029' || fs.realpathSync(parent) !== parent) throw Error('Live validation requires the explicitly approved pilot folder');
  return {parent, dsh: plugin.dsh};
}
export async function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(options.parent ?? os.tmpdir(), 'kurumi-coding-'));
  fs.chmodSync(root, 0o700);
  const source = path.join(root, 'source'); fs.mkdirSync(source);
  git(source, 'init', '-b', 'main');
  fs.writeFileSync(path.join(source, 'value.mjs'), 'export const value = 1;\n');
  fs.writeFileSync(path.join(source, 'README.md'), 'committed baseline\n');
  fs.writeFileSync(path.join(source, 'notes.txt'), 'notes baseline\n');
  git(source, 'add', '.'); git(source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'Synthetic baseline');
  const baseline = git(source, 'rev-parse', 'HEAD').trim();
  if (options.directoryProject) fs.rmSync(path.join(source, '.git'), {recursive: true});
  options.sourceSetup?.(source);
  const checks = path.join(root, 'check.mjs');
  fs.writeFileSync(checks, `import assert from 'node:assert/strict'; import {pathToFileURL} from 'node:url'; import path from 'node:path';\nconst {value} = await import(pathToFileURL(path.join(process.env.CODING_WORKTREE, 'value.mjs'))); assert.ok(Number.isInteger(value) && value > 0); console.log('registered fixture check passed');\n`);
  const config = withAccess({channels: {'kurumi-qq': {ownerId: owner, stateDir: path.join(root, 'channel')}}}, owner);
  config.channels['kurumi-qq'].accessControl.subjects.push(memberRow(member));
  const pluginConfig = {pilot: true, writeBoundary: {root, launcher: '/home/afrangry/.openclaw-fusion/tools/node-addon-system-linux-x64/bin/landlock-run'}, root: path.join(root, 'state'), worktrees: path.join(root, 'worktrees'), dsh: {command: process.execPath, home: root, model: ['fixture', 'fixture']},
    projects: [{id: 'fixture', root: source, branch: 'main', checks: [{name: 'independent check', argv: [process.execPath, checks]}]}]};
  // The fake DSH home must be separate from the registered project, as in the real runtime.
  pluginConfig.dsh.home = path.join(root, 'dsh'); fs.mkdirSync(pluginConfig.dsh.home);
  if (options.directoryProject) {pluginConfig.projects[0].kind = 'directory'; delete pluginConfig.projects[0].branch;}
  options.configure?.(pluginConfig);
  const calls = [], events = [], deliveries = [], hooks = {}, services = [], tools = {};
  let service;
  const behavior = options.behavior ?? (async ({cwd, turn}) => fs.writeFileSync(path.join(cwd, 'value.mjs'), `export const value = ${turn + 1};\n`));
  class Peer extends EventEmitter {
    constructor(args) { super(); this.args = args; this.identity = null; calls.push({method: 'spawn', cwd: args.cwd}); }
    async initialize() { calls.push({method: 'initialize'}); }
    async open(cwd, args) { this.sessionId = args.sessionId ?? randomUUID(); calls.push({method: args.sessionId ? 'resume' : 'new', cwd, sessionId: this.sessionId}); return this.sessionId; }
    async request(method) { calls.push({method}); return {}; }
    async prompt(text) {
      const turn = calls.filter(c => c.method === 'prompt' && c.sessionId === this.sessionId).length + 1;
      calls.push({method: 'prompt', sessionId: this.sessionId});
      return await behavior({cwd: this.args.cwd, text, turn, peer: this}) ?? {stopReason: 'end_turn'};
    }
    cancel() { calls.push({method: 'cancel', sessionId: this.sessionId}); this.cancelled = true; this.emit('cancel'); }
    async stop() { this.closed = true; }
    async cancellationStopped() { await this.stop(); return true; }
  }
  createCodingPlugin({clientFactory: options.clientFactory ?? (args => new Peer(args)), trace: e => events.push(e), delivery: {async sendText(message) {
    deliveries.push(message); return options.delivery ? options.delivery(message) : {channel: 'kurumi-qq', messageId: String(deliveries.length)};
  }}, onService: s => service = s}).register({config, pluginConfig, registrationMode: 'full', logger: {info() {}, warn() {}},
    on: (name, fn) => (hooks[name] ??= []).push(fn), registerTool: (factory, meta) => tools[meta.name] = factory,
    registerService: s => services.push(s)});
  for (const s of services) await s.start();
  t?.after(async () => {for (const s of services.toReversed()) await s.stop(); core.clearNaturalConfirmationRequest(context.sessionKey); fs.rmSync(root, {recursive: true, force: true});});
  const context = {senderIsOwner: true, requesterSenderId: owner, agentId: 'main', messageChannel: 'kurumi-qq', sessionId: 'fixture-session',
    sessionKey: `agent:main:kurumi-qq:direct:${owner}`, deliveryContext: {channel: 'kurumi-qq', to: `user:${owner}`, accountId: 'default'},
    getRuntimeConfig: () => config, assertInvocationCurrent() {}};
  let sequence = 0;
  const run = async (args, ctx = context, callId = 'fixture-call-' + ++sequence) => {
    for (const fn of hooks.before_tool_call ?? []) await fn({toolName: 'kurumi_code', params: args, toolCallId: callId}, {...ctx, runId: 'fixture-real-hook-run'});
    const result = await tools.kurumi_code.create(ctx).execute(callId, args);
    for (const fn of hooks.after_tool_call ?? []) await fn({toolName: 'kurumi_code', result, toolCallId: callId}, {...ctx, runId: 'fixture-real-hook-run'});
    return JSON.parse(result.content[0].text);
  };
  const event = (text = '确认合入此测试任务') => ({channel: 'kurumi-qq', accountId: 'default', senderId: owner, conversationId: `user:${owner}`, sessionKey: context.sessionKey, messageId: randomUUID(), timestamp: Date.now(), content: text, isGroup: false});
  const present = preview => {
    const e = event('请展示待合入预览');
    const choice = {domain: 'coding', proposalId: preview.proposalId, payloadHash: preview.payloadHash};
    if (!core.prepareConfirmationPreview(e, choice, preview.previewText)) throw Error('preview not prepared');
    core.recordConfirmationDelivery({accountId: e.accountId, conversationId: e.conversationId, sourceMessageId: e.messageId, messageId: randomUUID(), text: preview.previewText});
    return choice;
  };
  const approve = preview => {
    const choice = present(preview), e = event(); core.captureNaturalConfirmationRequest(e);
    const result = core.confirmNaturalProposal(e, choice); if (!result.ok) throw Error(JSON.stringify(result)); return result;
  };
  const settle = async id => {await service.idle(id); await tick(); return run({action: 'status', taskId: id});};
  return {root, source, baseline, config, pluginConfig, context, service, run, settle, calls, events, deliveries, hooks, services, tools, approve, present, event};
}
