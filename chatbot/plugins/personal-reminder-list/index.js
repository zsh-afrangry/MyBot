import {manageList} from './service.js';
import {ownerAuthorized} from '../kurumi-qq/src/config.js';
import {ListStore, stateRoot} from './store.js';
import {createListIntake} from './intake.js';
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
  content: {...optionalText(800), description: '可空；从本次原文连续摘录地点、作业格式、交付方式等资料，可保留原句，不自行改写或拼接不连续事实'},
  note: {...optionalText(400), description: '可空；连续摘录原文中的越快越好、选举后/活动结束后等条件，不编造具体日期'},
  ddl: {type: ['string', 'null'], description: '可空；无DDL/越快越好/活动结束后未给截止日期时必须null，条件保存在内容或备注。Asia/Shanghai YYYY-MM-DD（当日结束）或 YYYY-MM-DDTHH:mm；缺失日期先澄清'},
  times: {type: 'array', minItems: 1, maxItems: 24, items: {type: 'string'}, description: 'schedule 完整替换每日 HH:mm 集合；24:00等同00:00；次数等于时刻数'},
}};
const toolDeclarations = [
  {name: 'personal_reminder_list_get', label: '查看提醒列表', parameters: getParameters,
    description: '查询本人持久提醒列表、历史及每日播报设置；包含后端当前时间。DDL过期自动退出有效列表。完成、作废、修改先查真实ID/version。'},
  {name: 'personal_reminder_list_manage', label: '维护提醒列表', parameters: manageParameters,
    description: '本人明确提醒列表维护可直接保存，无需带码确认，一条消息一项。已开启的短时连续录入可省略列表名，但只授权add；其他操作仍须本次明确请求。标题/内容/备注取本次原文，越快越好和活动结束后等条件须保留；无DDL必须null。失败须澄清，不能转一次性提案或批量确认。update/complete/void/reopen先get，传唯一id或query及expectedVersion。多候选先澄清。schedule完整替换每日时刻；pause/resume暂停恢复播报。现有一次性提醒仍走personal_reminder提案确认，不混用。'},
];
const plugin = {id: 'personal-reminder-list', name: 'Personal reminder list', register(api) {
  const ownerId = api.config.channels?.['kurumi-qq']?.ownerId;
  const options = {root: stateRoot(), ownerId, repo: api.pluginConfig?.backendRoot, defaultTimes: api.pluginConfig?.defaultTimes, port: api.config.gateway?.port ?? 18890, logger: api.logger};
  const scheduler = createScheduler(options), intake = createListIntake(ownerId);
  if (api.registrationMode === 'full' || api.registrationMode === undefined) {
    api.on('reply_dispatch', event => {intake.receive(event);});
    api.on('before_tool_call', (event, ctx) => {
      if (intake.blocksTool(event, ctx)) return {block: true, blockReason: '当前请求是提醒列表；失败须说明原因或澄清，不能改建一次性提醒或自动化任务'};
    }, {matcher: ['personal_reminder_propose', 'personal_reminder_commit', 'personal_reminder_change_propose', 'personal_reminder_change_commit', 'personal_reminder_cancel_propose', 'personal_reminder_cancel_commit', 'automations']});
    api.on('before_reset', (event, ctx) => intake.end(event, ctx));
    api.on('session_end', (event, ctx) => intake.end(event, ctx));
    api.registerService({id: 'personal-reminder-list-scheduler', start: () => scheduler.start(), stop: () => scheduler.stop()});
  }
  for (const declaration of toolDeclarations) {
    const {name} = declaration;
    api.registerTool({contextVersion: 2, create: ctx => {
      const request = intake.current();
      return {...declaration,
        async execute(_callId, args, signal) {
          const cfg = ctx.getRuntimeConfig?.() ?? api.config;
          if (!ownerAuthorized(ctx, cfg)) return json({ok: false, error: {code: 'forbidden_context', message: '只支持本人 QQ 私聊'}});
          ctx.assertInvocationCurrent(); signal?.throwIfAborted();
          let store;
          try {
            const permit = intake.bind(request, ctx);
            store = new ListStore(options);
            if (name === 'personal_reminder_list_get') return json({...store.get(args), scheduleSync: scheduler.status()});
            if (intake.current() !== request) throw Error('本次请求已被后续消息替代');
            const result = manageList(store, args, permit, {runId: ctx.runId});
            store.close(); store = undefined;
            if (result.ok && args.action === 'add') intake.added(request, ctx, permit);
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
