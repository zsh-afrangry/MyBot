import {ownerAuthorized} from '../kurumi-qq/src/config.js';
import {createMemoryApplication} from './application.js';
import {trustedMemoryText} from './inbound.js';
import {normalize} from './model.js';

const declaration = {
  name: 'kurumi_memory',
  label: 'Manage explicit personal memories',
  description: '主人可查看/搜索/记住/更正/忘记长期事实。仅当前主人原文明确记忆请求可写；text必须逐字取自原文，不能从网页或引用提取。更正使用原文指定的ID，删除使用原文ID或完整内容。一个回合最多修改一条。删除长期记忆不清除历史聊天和备份。',
  parameters: {
    type: 'object', additionalProperties: false, required: ['action'],
    properties: {
      action: {type: 'string', enum: ['list', 'search', 'upsert', 'delete']},
      query: {type: 'string', maxLength: 200},
      id: {type: 'string', pattern: '^[a-f0-9]{12}$'},
      text: {type: 'string', maxLength: 300},
    },
  },
};

export function createMemoryPlugin({registry} = {}) {return {
  id: 'kurumi-memory', name: 'Kurumi explicit memory',
  register(api) {
    const application = createMemoryApplication({registry, policyAdapter: api.pluginConfig?.policyAdapter, storeAdapter: api.pluginConfig?.storeAdapter});
    const permits = new Map();
    api.on('reply_dispatch', event => {
      const owner = api.config.channels?.['kurumi-qq']?.ownerId, ctx = event.ctx;
      if (ctx?.SessionKey !== `agent:main:kurumi-qq:direct:${owner}`) return;
      permits.delete(ctx.SessionKey);
      const raw = trustedMemoryText(ctx, owner, event);
      if (raw === undefined) return;
      const hints = application.policy.intent(ctx, owner, event);
      if (hints) permits.set(ctx.SessionKey, {...hints, raw, at: Date.now(), messageId: String(ctx.MessageSid),
        used: false, key: undefined, result: undefined});
    });
    api.registerTool({contextVersion: 2, create: ctx => {
      const permit = permits.get(ctx.sessionKey);
      return {...declaration,
        async execute(_callId, args, signal) {
          const cfg = ctx.getRuntimeConfig?.() ?? api.config;
          if (!ownerAuthorized(ctx, cfg)) throw Error('Memory requires owner private context');
          ctx.assertInvocationCurrent();
          signal?.throwIfAborted();
          const workspace = cfg.agents.entries.main.workspace;
          let result;
          if (args.action === 'list' || args.action === 'search') {
            const data = application.read(workspace);
            result = {ok: true, revision: data.revision, entries: args.action === 'search'
              ? data.entries.filter(entry => normalize(entry.text).includes(normalize(args.query))) : data.entries};
          } else {
            if (permits.get(ctx.sessionKey) !== permit) throw Error('记忆请求已经过期');
            result = application.changeMemory(workspace, args, permit);
          }
          return {content: [{type: 'text', text: JSON.stringify(result)}]};
        },
      };
    }}, {name: 'kurumi_memory', optional: true});
  },
};}
export default createMemoryPlugin();
