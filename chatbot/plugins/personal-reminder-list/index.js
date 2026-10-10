import {ownerAuthorized} from '../kurumi-qq/src/config.js';
import {ListStore, stateRoot} from './store.js';
import {listIntent} from './intent.js';
import {createScheduler} from './scheduler.js';
import {readFileSync} from 'node:fs';
import {toolPluginMetadataSymbol} from 'openclaw/plugin-sdk/tool-plugin';
const json = result => ({content: [{type: 'text', text: JSON.stringify(result)}]});
const optionalText = max => ({type: ['string', 'null'], maxLength: max});
export const getParameters = {type: 'object', additionalProperties: false, properties: {
  history: {type: 'boolean', description: '包含已完成、作废、过期历史；默认只列有效待办'},
  query: {type: 'string', maxLength: 200},
}};
export const manageParameters = {type: 'object', additionalProperties: false, required: ['action'], properties: {
  action: {type: 'string', enum: ['add', 'update', 'complete', 'void', 'reopen', 'schedule', 'pause', 'resume']},
  id: {type: 'string', pattern: '^[a-f0-9]{12}$'}, query: {type: 'string', minLength: 2, maxLength: 200},
  expectedVersion: {type: 'integer', minimum: 1, description: '维护已有项必需，取自 get 返回的 version'},
  title: {type: 'string', minLength: 1, maxLength: 120, description: '添加必需；取自本人原文'},
  content: optionalText(800), note: optionalText(400),
  ddl: {type: ['string', 'null'], description: '可空；Asia/Shanghai 的 YYYY-MM-DD（当日结束）或 YYYY-MM-DDTHH:mm。不要猜测下次课前等缺失时间'},
  times: {type: 'array', minItems: 1, maxItems: 24, items: {type: 'string'}, description: 'schedule 完整替换每日 HH:mm 集合；24:00等同00:00；次数等于时刻数'},
}};
const toolDeclarations = [
  {name: 'personal_reminder_list_get', label: '查看提醒列表', parameters: getParameters,
    description: '查询本人持久提醒列表、历史及每日播报设置；包含后端当前时间。DDL过期自动退出有效列表。完成、作废、修改先查真实ID/version。'},
  {name: 'personal_reminder_list_manage', label: '维护提醒列表', parameters: manageParameters,
    description: '仅本人本次原文明示提醒列表维护才执行，直接保存无需带码确认，一个消息只维护一项。标题/内容/备注必须取自原文。add可无DDL；update/complete/void/reopen先get，传唯一id或query及expectedVersion。多候选先澄清。schedule完整替换每日时刻；pause/resume暂停恢复播报。现有一次性提醒仍走personal_reminder提案确认，不混用。'},
];
const plugin = {id: 'personal-reminder-list', name: 'Personal reminder list', register(api) {
  const ownerId = api.config.channels?.['kurumi-qq']?.ownerId;
  const options = {root: stateRoot(), ownerId, repo: api.pluginConfig?.backendRoot, defaultTimes: api.pluginConfig?.defaultTimes, port: api.config.gateway?.port ?? 18890, logger: api.logger};
  const scheduler = createScheduler(options), permits = new Map();
  if (api.registrationMode === 'full' || api.registrationMode === undefined) {
    api.on('reply_dispatch', event => {
      const ctx = event.ctx;
      if (ctx.SessionKey !== `agent:main:kurumi-qq:direct:${ownerId}`) return;
      permits.delete(ctx.SessionKey);
      const permit = listIntent(ctx, ownerId, event);
      if (permit) permits.set(ctx.SessionKey, permit);
    });
    api.registerService({id: 'personal-reminder-list-scheduler', start: () => scheduler.start(), stop: () => scheduler.stop()});
  }
  for (const declaration of toolDeclarations) {
    const {name} = declaration;
    api.registerTool({contextVersion: 2, create: ctx => {
      const permit = permits.get(ctx.sessionKey);
      return {...declaration,
        async execute(_callId, args, signal) {
          const cfg = ctx.getRuntimeConfig?.() ?? api.config;
          if (!ownerAuthorized(ctx, cfg)) return json({ok: false, error: {code: 'forbidden_context', message: '只支持本人 QQ 私聊'}});
          ctx.assertInvocationCurrent(); signal?.throwIfAborted();
          let store;
          try {
            store = new ListStore(options);
            if (name === 'personal_reminder_list_get') return json({...store.get(args), scheduleSync: scheduler.status()});
            if (permits.get(ctx.sessionKey) !== permit) throw Error('本次请求已被后续消息替代');
            const result = store.manage(args, permit, {runId: ctx.runId});
            store.close(); store = undefined;
            if (result.ok && ['schedule', 'pause', 'resume'].includes(args.action)) result.scheduleSync = await scheduler.sync();
            return json(result);
          } catch (error) {
            api.logger?.warn?.('Reminder-list operation rejected or unavailable');
            return json({ok: false, error: {code: 'list_operation_rejected', message: String(error.message).slice(0, 240)}});
          } finally { store?.close(); }
        },
      };
    }}, {name, optional: true});
  }
}};
// Public authoring metadata shares the exact runtime declarations. We register
// v2 factories directly because defineToolPlugin currently wraps v1 factories.
Object.defineProperty(plugin, toolPluginMetadataSymbol, {value: {
  id: plugin.id, name: plugin.name, description: 'Owner reminder-list domain and deterministic native daily digest',
  activation: {onStartup: true},
  configSchema: JSON.parse(readFileSync(new URL('./openclaw.plugin.json', import.meta.url), 'utf8')).configSchema,
  tools: toolDeclarations.map(t => ({...t, optional: true})),
}});
export default plugin;
