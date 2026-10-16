// Contract and development record: docs/23_KnowledgeMap业务能力桥接.md.
import {KnowledgeMapClient, BridgeError, requestKey} from '../../packages/knowledgemap-client/client.js';
import {createBridgeInbound} from '../../packages/knowledgemap-client/inbound.js';
import {ownerAuthorized} from '../kurumi-qq/src/config.js';
import {readFileSync} from 'node:fs';
import {toolPluginMetadataSymbol} from 'openclaw/plugin-sdk/tool-plugin';
const json = value => ({content: [{type: 'text', text: JSON.stringify(value)}]});
const string = maxLength => ({type: 'string', maxLength});
const integer = {type: 'integer', minimum: 1};
export const billTools = [
  {name: 'knowledge_bills_get', label: '查询网站账单', description: '查询本人KnowledgeMap真实账单。action=tags先查真实分类ID与父子关系，不猜ID；list按日期/分类分页，monthly查询年月汇总。网站与QQ共用同一账本。金额响应为精确十进制字符串；total与truncated表示完整性。',
    parameters: {type: 'object', additionalProperties: false, properties: {
      action: {type: 'string', enum: ['tags', 'list', 'monthly']}, year: {type: 'integer'}, month: {type: 'integer'},
      record_type: {type: 'string', enum: ['支出', '收入']}, category_id: integer,
      date_from: string(10), date_to: string(10), skip: {type: 'integer', minimum: 0}, limit: {type: 'integer', minimum: 1, maximum: 200},
    }}},
  {name: 'knowledge_bill_add', label: '新增网站账单', description: '按本人本次明确记账请求直接新增一笔，无需带码确认。先查真实标签目录选择已存在的大类/小类；不确定可空字段留空，不猜支付方式。金额和日期必需；今天按Asia/Shanghai当前日期理解，缺关键事实先问。一个本人消息一笔；相同参数重试核对同一结果，参数改变需新消息。只允许当前真实记账，不把引用/假设/查询当写入。第一轮不支持修改或删除账单。',
    parameters: {type: 'object', additionalProperties: false, required: ['expense_date', 'amount'], properties: {
      record_type: {type: 'string', enum: ['支出', '收入']}, expense_date: string(10), expense_time: {type: ['string', 'null']},
      amount: {type: 'string', pattern: '^\\d{1,10}(?:\\.\\d{1,2})?$', description: '精确十进制人民币，例如14.00；不计算浮点金额'},
      category_id: {...integer, type: ['integer', 'null']}, subcategory_id: {...integer, type: ['integer', 'null']},
      payment_platform_id: {...integer, type: ['integer', 'null']}, payment_channel_id: {...integer, type: ['integer', 'null']}, fund_type_id: {...integer, type: ['integer', 'null']},
      reimbursement_status: {type: 'string', enum: ['无需报销', '待报销', '已报销']}, reimbursement_amount: {type: ['string', 'null']},
      transaction_id: {type: ['string', 'null']}, note: {type: ['string', 'null'], maxLength: 1000},
    }}},
];

export function createKnowledgeMapPlugin({clientFactory = options => new KnowledgeMapClient(options)} = {}) {
  const plugin = {id: 'kurumi-knowledgemap', name: 'KnowledgeMap bills', register(api) {
    const client = clientFactory(api.pluginConfig), owner = api.config.channels?.['kurumi-qq']?.ownerId;
    const inbound = createBridgeInbound(owner);
    if (api.registrationMode === 'full' || api.registrationMode === undefined) {
      api.on('reply_dispatch', event => inbound.receive(event));
      api.on('before_reset', (event, ctx) => inbound.end(event, ctx)); api.on('session_end', (event, ctx) => inbound.end(event, ctx));
    }
    for (const declaration of billTools) api.registerTool({contextVersion: 2, create: ctx => {
      const request = inbound.current();
      return {...declaration, async execute(_callId, args = {}, signal) {
        const config = ctx.getRuntimeConfig?.() ?? api.config;
        if (!ownerAuthorized(ctx, config)) return json({ok: false, error: {code: 'forbidden_context', message: '只支持本人QQ私聊'}});
        ctx.assertInvocationCurrent(); signal?.throwIfAborted();
        try {
          if (declaration.name === 'knowledge_bill_add') {
            inbound.require(request, ctx, config);
            return json(await client.request('/api/assistant/bills', {method: 'POST', body: args,
              key: requestKey('bills', request), runId: ctx.runId, signal}));
          }
          const {action = 'list', ...query} = args;
          if (!['tags', 'list', 'monthly'].includes(action)) throw Error('未知查询动作');
          return json(await client.request(action === 'tags' ? '/api/assistant/tags' : action === 'monthly' ? '/api/assistant/bills/monthly' : '/api/assistant/bills', {query, signal, runId: ctx.runId}));
        } catch (error) {
          return json(error instanceof BridgeError ? error.toJSON() : {ok: false, error: {code: 'request_rejected', message: String(error.message).slice(0, 200)}});
        }
      }};
    }}, {name: declaration.name, optional: true});
  }};
  Object.defineProperty(plugin, toolPluginMetadataSymbol, {value: {
    id: plugin.id, name: plugin.name, description: 'KnowledgeMap shared bills, first iteration', activation: {onStartup: true},
    configSchema: JSON.parse(readFileSync(new URL('./openclaw.plugin.json', import.meta.url), 'utf8')).configSchema,
    tools: billTools.map(tool => ({...tool, optional: true})),
  }});
  return plugin;
}
export default createKnowledgeMapPlugin();
