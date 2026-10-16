// Explicit asynchronous boundary. SQLite here owns only settings/receipts, not items.
import {ListStore} from './store.js';
import {createListService} from './service.js';
import {defaultListPolicy} from './policy.js';
import {createScheduler} from './scheduler.js';
import {stateRoot} from './application.js';
import {parseDeadline, localTime, dueSlot} from './time.js';
import {formatDigest} from './formatter.js';
import {ownerAuthorized} from '../kurumi-qq/src/config.js';
import {KnowledgeMapClient, BridgeError, requestKey} from '../../packages/knowledgemap-client/client.js';
import {createBridgeInbound} from '../../packages/knowledgemap-client/inbound.js';

export class ListControlStore extends ListStore {
  expire() {return 0;}
  get() {throw Error('业务事项必须从KnowledgeMap查询');}
  addItem() {throw Error('旧事项存储已退出写入');}
  changeItem() {throw Error('旧事项存储已退出写入');}
  claimDigest() {throw Error('播报必须读取KnowledgeMap');}
  claimRemoteDigest(time, items, settingsVersion) {
    return this.transaction(() => {
      const settings = this.settings(), slot = dueSlot(time, this.now());
      if (!slot || !settings.enabled || !settings.times.includes(time) || settings.version !== settingsVersion) return;
      if (this.db.prepare('SELECT slot_key FROM deliveries WHERE slot_key=?').get(slot.key)) return;
      const output = formatDigest(items, slot.at), status = output ? 'prepared' : 'skipped';
      if (Buffer.byteLength(output, 'utf8') > 500000) throw Error('完整列表超过播报输出上限，未截断或占用投递slot');
      this.db.prepare('INSERT INTO deliveries VALUES(?,?,?,?,?,?,?,NULL)').run(slot.key, slot.at, settings.version,
        status, JSON.stringify(items.map(i => i.id)), output, this.now());
      this.audit('digest.' + status, null, {slotKey: slot.key, count: items.length, dataSource: 'knowledgemap'});
      return {slotKey: slot.key, text: output, count: items.length};
    });
  }
}

export function taskItem(row) {
  if (!Number.isSafeInteger(row.id) || row.id < 1 || !Number.isSafeInteger(row.version) || row.version < 1 || typeof row.title !== 'string') throw new BridgeError('invalid_response', '事项缺少真实ID或版本');
  return {id: `km:${row.id}`, title: row.title, content: row.detail, note: row.note ?? null,
    ddl: row.event_date ? row.event_date + (row.event_time ? 'T' + row.event_time.slice(0, 5) : '') : null,
    tone: row.tone, status: row.archived_at ? 'void' : row.completed_at ? 'completed' : 'active',
    version: row.version, createdAt: row.created_at, updatedAt: row.updated_at};
}

export async function manageRemoteList(client, args, request, {runId, signal} = {}) {
  const allowed = ['action', 'id', 'query', 'expectedVersion', 'title', 'content', 'note', 'ddl', 'tone'];
  if (Object.keys(args).some(k => !allowed.includes(k)) || !['add', 'update', 'complete', 'void', 'reopen'].includes(args.action)) throw Error('未知事项参数或动作');
  const fields = {};
  for (const [tool, api] of [['title', 'title'], ['content', 'detail'], ['note', 'note'], ['tone', 'tone']]) if (tool in args) fields[api] = args[tool];
  if ('ddl' in args) {
    const {ddl} = parseDeadline(args.ddl);
    fields.event_date = ddl ? ddl.slice(0, 10) : null;
    fields.event_time = ddl && ddl.length > 10 ? ddl.slice(11) + ':00' : null;
  }
  let id;
  if (args.action !== 'add') {
    if (!/^km:[1-9]\d*$/.test(args.id ?? '')) throw Error('先查询网站共享列表的真实km:ID与version，不使用旧列表ID');
    id = Number(args.id.slice(3));
    if (!Number.isSafeInteger(id) || !Number.isSafeInteger(args.expectedVersion) || args.expectedVersion < 1) throw Error('先查询真实ID与版本');
  } else if (args.id !== undefined || args.expectedVersion !== undefined || args.query !== undefined) throw Error('新增不指定已有目标');
  const result = await client.request('/api/assistant/tasks', {method: 'POST', key: requestKey('tasks', request), runId, signal,
    body: {action: args.action, ...(id === undefined ? {} : {id, expected_version: args.expectedVersion}), fields}});
  if (result.ok !== true || !result.item) throw new BridgeError('write_result_unknown', '未得到确定维护结果；仅用相同参数重试核对');
  return {...result, item: taskItem(result.item), dataSource: 'knowledgemap'};
}

export async function runRemoteDigest(options, client, time, write = value => process.stdout.write(value)) {
  const store = new ListControlStore(options);
  try {
    const settings = store.settings();
    if (!settings.enabled || !settings.times.includes(time) || !dueSlot(time, store.now())) return 0;
    // Failure happens before claiming the slot. No stale/empty fallback can be announced.
    const items = (await client.allTasks()).map(taskItem);
    const digest = store.claimRemoteDigest(time, items, settings.version);
    if (digest?.text) write(digest.text + '\n');
    return 0;
  } finally {store.close();}
}

export function registerRemoteList(api, declarations, {clientFactory = options => new KnowledgeMapClient(options)} = {}) {
  const ownerId = api.config.channels?.['kurumi-qq']?.ownerId;
  const client = clientFactory({baseUrl: api.pluginConfig.bridgeBaseUrl, tokenFile: api.pluginConfig.bridgeTokenFile});
  const inbound = createBridgeInbound(ownerId), options = {root: stateRoot(), ownerId,
    repo: api.pluginConfig.backendRoot, defaultTimes: api.pluginConfig.defaultTimes, port: api.config.gateway?.port ?? 18890,
    dataSource: 'knowledgemap', bridgeBaseUrl: api.pluginConfig.bridgeBaseUrl, bridgeTokenFile: api.pluginConfig.bridgeTokenFile,
    openStore: opts => new ListControlStore(opts), logger: api.logger};
  const scheduler = createScheduler(options), manageControls = createListService(defaultListPolicy);
  if (api.registrationMode === 'full' || api.registrationMode === undefined) {
    api.on('reply_dispatch', event => inbound.receive(event));
    api.on('before_reset', (event, ctx) => inbound.end(event, ctx)); api.on('session_end', (event, ctx) => inbound.end(event, ctx));
    api.on('before_tool_call', (event, ctx) => {
      if (event.toolName === 'automations' && ['list', 'get', 'status', 'runs'].includes(event.params?.action)) return;
      const request = inbound.current();
      if (request?.listTarget && request.sessionKey === ctx.sessionKey && request.sessionId === ctx.sessionId) return {
        block: true, blockReason: '本次已选择提醒列表维护；失败须说明或澄清，不能改建一次性提醒或自动化任务',
      };
    }, {matcher: ['personal_reminder_propose', 'personal_reminder_commit', 'personal_reminder_change_propose', 'personal_reminder_change_commit', 'personal_reminder_cancel_propose', 'personal_reminder_cancel_commit', 'automations']});
    api.registerService({id: 'personal-reminder-list-scheduler', start: () => scheduler.start(), stop: () => scheduler.stop()});
  }
  for (const declaration of declarations) api.registerTool({contextVersion: 2, create: ctx => {
    const request = inbound.current();
    return {...declaration, async execute(_callId, args = {}, signal) {
      const config = ctx.getRuntimeConfig?.() ?? api.config;
      if (!ownerAuthorized(ctx, config)) return {content: [{type: 'text', text: JSON.stringify({ok: false, error: {code: 'forbidden_context', message: '只支持本人QQ私聊'}})}]};
      try {
        ctx.assertInvocationCurrent(); signal?.throwIfAborted();
        let result;
        if (declaration.name === 'personal_reminder_list_get') {
          const store = new ListControlStore(options);
          try {
            result = {ok: true, now: localTime(Date.now()), timezone: 'Asia/Shanghai', dataSource: 'knowledgemap',
              items: (await client.allTasks({history: args.history, query: args.query, signal, runId: ctx.runId})).map(taskItem), settings: store.settings(), scheduleSync: scheduler.status()};
          } finally {store.close();}
        } else {
          inbound.require(request, ctx, config);
          request.listTarget = true;
          if (['schedule', 'pause', 'resume'].includes(args.action)) {
            const store = new ListControlStore(options);
            try {result = manageControls(store, args, {...request, actions: new Set([args.action])}, {runId: ctx.runId});}
            finally {store.close();}
            if (result.ok) result.scheduleSync = await scheduler.sync();
          } else result = await manageRemoteList(client, args, request, {runId: ctx.runId, signal});
        }
        return {content: [{type: 'text', text: JSON.stringify(result)}]};
      } catch (error) {
        return {content: [{type: 'text', text: JSON.stringify(error instanceof BridgeError ? error.toJSON() : {ok: false, error: {code: 'request_rejected', message: String(error.message).slice(0, 240)}})}]};
      }
    }};
  }}, {name: declaration.name, optional: true});
}
