// Contract and development record: docs/23_KnowledgeMap业务能力桥接.md.
import {KnowledgeMapClient, BridgeError, requestKey} from '../../packages/knowledgemap-client/client.js';
import {createBridgeInbound} from '../../packages/knowledgemap-client/inbound.js';
import {createToolTrace} from '../../packages/knowledgemap-client/tool-trace.js';
import {businessFeedback} from '../../packages/feedback-core/index.js';
import {authorizedOwner as ownerAuthorized} from '../../packages/access-control/index.js';
import {readFileSync} from 'node:fs';
import {toolPluginMetadataSymbol} from 'openclaw/plugin-sdk/tool-plugin';
const json = value => ({content: [{type: 'text', text: JSON.stringify(value)}]});
const string = maxLength => ({type: 'string', maxLength});
const integer = {type: 'integer', minimum: 1};
const billActions = ['bill.create','bill.update','bill.delete'];
const messageIdPattern = '^-?[1-9][0-9]{0,15}$';
const messageIdFormat = new RegExp(messageIdPattern, 'u');
const receiptPath = '/api/assistant/bills/receipt';

function billFeedback(result, messageId, action, source) {
  const bill = result.item;
  const committed = result.ok === true && 'bill.'+result.action === action
    && Number.isSafeInteger(bill?.id) && bill.id > 0 && Number.isSafeInteger(bill.version) && bill.version > 0
    && (action !== 'bill.delete' || bill.deleted === true);
  const status = committed ? 'succeeded'
    : result.ok === false && result.error?.code !== 'write_result_unknown' && source === 'transaction_response' ? 'failed'
      : 'unknown';
  return businessFeedback(action, status, {
    source, sourceMessageId: messageId,
    ...(committed && {billId: bill.id, version: bill.version, ...(bill.deleted && {deleted:true})}),
    ...(result.error?.code && {code: result.error.code}),
  });
}
const billFields = {
  record_type: {type: 'string', enum: ['支出', '收入']}, expense_date: {...string(10), description: '日期YYYY-MM-DD；字段名为expense_date，不是date'}, expense_time: {type: ['string', 'null']},
  amount: {type: 'string', pattern: '^\\d{1,10}(?:\\.\\d{1,2})?$', description: '精确十进制人民币，例如36.80；先计算合计，不传算式'},
  category_id: {...integer, type: ['integer', 'null'], description: '仅使用tags返回type=category的ID；子类ID不可填此字段，不明确则省略'}, subcategory_id: {...integer, type: ['integer', 'null'], description: '仅用type=subcategory的ID，且parent_id必须等于category_id'},
  payment_platform_id: {...integer, type: ['integer', 'null']}, payment_channel_id: {...integer, type: ['integer', 'null']}, fund_type_id: {...integer, type: ['integer', 'null']},
  reimbursement_status: {type: 'string', enum: ['无需报销', '待报销', '已报销']}, reimbursement_amount: {type: ['string', 'null']},
  transaction_id: {type: ['string', 'null']}, note: {type: ['string', 'null'], maxLength: 1000},
};
export const billTools = [
  {name: 'knowledge_bills_get', label: '查询网站账单', description: '查询本人 KnowledgeMap 账单。tags 查分类，list 按日期、分类或关键词分页，get 按真实 id 查单笔及 version，monthly 查年月汇总。追问上一笔写入结果时用 action=receipt，只传写入工具返回的原消息 message_id。receipt 只读，查不到回执时结果仍待核实。',
    parameters: {type: 'object', additionalProperties: false, properties: {
      action: {type: 'string', enum: ['tags', 'list', 'get', 'monthly', 'receipt']},
      message_id: {type:'string', pattern:messageIdPattern, description:'仅 receipt，使用原来请求写账的 QQ 入站消息 ID'},
      id: integer, query: string(200), year: {type: 'integer', minimum: 2000, maximum: 2100}, month: {type: 'integer', minimum: 1, maximum: 12},
      record_type: {type: 'string', enum: ['支出', '收入']}, category_id: integer,
      date_from: string(10), date_to: string(10), skip: {type: 'integer', minimum: 0}, limit: {type: 'integer', minimum: 1, maximum: 200},
    }}},
  {name: 'knowledge_bill_add', label: '新增网站账单', description: '本人明确记账直接保存一笔，无需带码确认。必需参数amount(十进制字符串)和expense_date(YYYY-MM-DD)，不要传date。例如{"amount":"36.80","expense_date":"2026-10-17","note":"午饭29.9+6.9"}。今天按Asia/Shanghai。先查真实标签ID；未知可空信息省略，缺关键事实先问。一条消息一笔，同参重试；不是引用/假设/查询就创建。修改删除用knowledge_bill_manage。',
    parameters: {type: 'object', additionalProperties: false, required: ['expense_date', 'amount'], properties: billFields}},
  {name: 'knowledge_bill_manage', label: '修改或删除单笔账单', description: '本人明确且唯一的单笔修改/删除直接执行，无需带码确认；先knowledge_bills_get取得真实id及version。有歧义先澄清，不批量。参数action=update|delete、id、expected_version。update的fields只传改动字段，省略保持、null仅清可空值；日期键expense_date。delete省略fields，实际删除，不承诺可撤销。不同参数不能借同一消息重复写；失败不谎报成功。',
    parameters: {type: 'object', additionalProperties: false, required: ['action', 'id', 'expected_version'], properties: {
      action: {type: 'string', enum: ['update', 'delete']}, id: integer, expected_version: integer,
      fields: {type: 'object', additionalProperties: false, minProperties: 1, properties: billFields},
    }}},
];

export function createKnowledgeMapPlugin({clientFactory = options => new KnowledgeMapClient(options)} = {}) {
  const plugin = {id: 'kurumi-knowledgemap', name: 'KnowledgeMap bills', register(api) {
    const client = clientFactory(api.pluginConfig), owner = api.config.channels?.['kurumi-qq']?.ownerId;
    const feedbackActions = new Set(api.pluginConfig?.feedbackActions ?? billActions);
    const inbound = createBridgeInbound(owner);
    const trace = createToolTrace(billTools.map(t => t.name)); trace.attach(api);
    if (api.registrationMode === 'full' || api.registrationMode === undefined) {
      api.on('reply_dispatch', event => inbound.receive(event));
      api.on('before_reset', (event, ctx) => inbound.end(event, ctx)); api.on('session_end', (event, ctx) => inbound.end(event, ctx));
    }
    for (const declaration of billTools) api.registerTool({contextVersion: 2, create: ctx => {
      const request = inbound.current();
      return {...declaration, async execute(callId, args = {}, signal) {
        const config = () => ctx.getRuntimeConfig?.() ?? api.config;
        const permission = declaration.name==='knowledge_bills_get'?'bills.read':'bills.manage';
        const authorized = () => ownerAuthorized(ctx, config(), permission);
        const forbidden = () => json({ok:false,error:{code:'forbidden_context',message:'只支持本人QQ私聊'}});
        if (!authorized()) return forbidden();
        ctx.assertInvocationCurrent(); signal?.throwIfAborted();
        try {
          const runId = trace.resolve(ctx, callId, declaration.name);
          if (declaration.name !== 'knowledge_bills_get') {
            const current = inbound.require(request, ctx, config());
            const create = declaration.name === 'knowledge_bill_add';
            const action = create ? 'bill.create' : 'bill.'+args.action;
            let result;
            try {
              result = await client.request(create ? '/api/assistant/bills' : '/api/assistant/bills/manage', {
                method:'POST', body:args, key:requestKey('bills', current), runId, signal,
              });
            } catch (error) {
              if (!(error instanceof BridgeError)) throw error;
              result = error.toJSON();
            }
            if (!authorized()) return forbidden();
            ctx.assertInvocationCurrent(); signal?.throwIfAborted();
            return json(feedbackActions.has(action)
              ? {...result, feedback:billFeedback(result,current.messageId,action,'transaction_response')} : result);
          }
          const {action = 'list', ...query} = args;
          if (action === 'receipt') {
            if (!feedbackActions.size) return json({ok:false,error:{code:'feedback_disabled'}});
            if (Object.keys(query).length !== 1 || typeof query.message_id !== 'string'
              || !messageIdFormat.test(query.message_id) || !Number.isSafeInteger(Number(query.message_id))) {
              throw Error('请提供原记账消息的 ID');
            }
            const key = requestKey('bills',{sessionKey:ctx.sessionKey,messageId:query.message_id});
            let result;
            try { result = await client.request(receiptPath,{key,runId,signal}); }
            catch (error) {
              if (!(error instanceof BridgeError)) throw error;
              result = error.toJSON();
            }
            if (!authorized()) return forbidden();
            ctx.assertInvocationCurrent(); signal?.throwIfAborted();
            const recordedAction = result.ok === true ? 'bill.'+result.action : 'bill.receipt';
            if (result.ok === true && !feedbackActions.has(recordedAction)) return json({ok:false,error:{code:'feedback_disabled'}});
            return json({...result,feedback:billFeedback(result,query.message_id,recordedAction,'request_receipt')});
          }
          if (Object.hasOwn(query,'message_id')) throw Error('message_id 仅用于回执查询');
          if (!['tags', 'list', 'get', 'monthly'].includes(action)) throw Error('未知查询动作');
          if (action === 'get' && (!Number.isSafeInteger(query.id) || query.id < 1)) throw Error('查询单笔账单需要真实id');
          const result = await client.request(action === 'tags' ? '/api/assistant/tags' : action === 'monthly' ? '/api/assistant/bills/monthly' : '/api/assistant/bills', {query: action === 'get' ? {id: query.id, limit: 1} : query, signal, runId});
          return json(action === 'get' ? result.items?.length ? {ok: true, item: result.items[0]} : {ok: false, error: {code: 'not_found', message: '未找到账单，请重新查询'}} : result);
        } catch (error) {
          return json(error instanceof BridgeError ? error.toJSON() : {ok: false, error: {code: 'request_rejected', message: String(error.message).slice(0, 200)}});
        }
      }};
    }}, {name: declaration.name, optional: true});
  }};
  Object.defineProperty(plugin, toolPluginMetadataSymbol, {value: {
    id: plugin.id, name: plugin.name, description: 'KnowledgeMap shared bills with single-record maintenance', activation: {onStartup: true},
    configSchema: JSON.parse(readFileSync(new URL('./openclaw.plugin.json', import.meta.url), 'utf8')).configSchema,
    tools: billTools.map(tool => ({...tool, optional: true})),
  }});
  return plugin;
}
export default createKnowledgeMapPlugin();
