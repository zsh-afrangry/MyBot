import {createHash} from 'node:crypto';
import {assertToolAccess} from '../../packages/access-control/index.js';
import {createQqDelivery} from '../../packages/qq-delivery/index.js';
import {IMAGE_KINDS} from './images.js';
import {E7Error} from './policy.js';

export const E7_IMAGE_TOOL = {
  name: 'e7_image', label: '发送第七史诗图片',
  description: '仅在主人本轮明确要图时调用一次，只发所指定的一种。要头像只用avatar；不要附送半身图或尝试其他类型。先用e7_data查真实heroCode；detail为半身详情图（不是完整立绘）、cover为封面、skill为技能图（附槽位）、effect为已关联效果图（附真实effectId）。发到当前本人QQ。收到sent或already_sent就结束发图；回执不明时不要再次调用。',
  parameters: {type: 'object', additionalProperties: false, required: ['heroCode', 'kind'], properties: {
    heroCode: {type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,79}$'},
    kind: {type: 'string', enum: IMAGE_KINDS},
    skill: {type: 'integer', minimum: 1, maximum: 3, description: '仅技能图必填'},
    effectId: {type: 'string', pattern: '^[A-Za-z0-9_-]{1,80}$', description: '仅效果图必填'},
  }},
};

const MESSAGES = {
  access_denied: '当前身份没有发送E7图片的权限',
  unknown_hero: '角色代码未找到，请先用资料查询确认角色',
  image_unavailable: '来源没有登记该角色对应的图片',
  invalid_query: '请核对图片类型及所需的技能槽位或效果ID',
  invalid_response: '图片格式与来源声明不符',
  image_request_required: '无法核对本次主人私聊回合，未尝试投递',
  response_too_large: '来源图片超过大小上限',
  qq_category_daily_limit: '已达到过去24小时的图片投递上限',
  qq_receipt_unresolved: '本轮已尝试投递，仍无可确认的回执，未再次发送',
  cancelled: '图片请求已取消',
};
const text = result => ({content: [{type: 'text', text: JSON.stringify(result)}]});

export function registerImageTool(api, service, telemetry, deliveryFactory = createQqDelivery) {
  const name = E7_IMAGE_TOOL.name;
  api.registerTool({contextVersion: 2, create: ctx => ({...E7_IMAGE_TOOL, async execute(callId, args, signal) {
    const config = () => ctx.getRuntimeConfig?.() ?? api.config;
    const check = () => {
      const actor = assertToolAccess(ctx, config(), name);
      if (!actor.owner) throw new E7Error('access_denied');
      ctx.assertInvocationCurrent();
      signal?.throwIfAborted();
      return actor;
    };
    try {
      const actor = check();
      if (typeof callId !== 'string' || !callId) throw new E7Error('invalid_query');
      const runId = telemetry.resolve(ctx, callId, name);
      if (!runId || !ctx.sessionId) throw new E7Error('image_request_required');
      const trace = {sessionKey: ctx.sessionKey, sessionId: ctx.sessionId, toolCallId: callId, runId};
      // A model may call again with a different ID or image kind. The ledger must see the same key.
      const requestKey = createHash('sha256').update(JSON.stringify([actor.id, ctx.sessionId, runId])).digest('hex');
      const {bytes, contentType} = await service.image(args, {signal, trace});
      check();
      const {channel, messageId, replayed} = await deliveryFactory(config).sendImage({
        to: 'user:' + actor.id, bytes, contentType, signal, key: 'e7:run:' + requestKey,
        text: '图片版权归《第七史诗》官方，经 E7·WIKI 获取。', assertDirectAdapterHandoff: check,
      });
      return text(replayed ? {status: 'already_sent', channel, messageId, message: '本轮已有一张图片的回执，这次没有发送新图'}
        : {status: 'sent', channel, messageId});
    } catch (error) {
      const denied = ['identity_not_enabled', 'capability_not_allowed', 'untrusted_identity_context', 'unmapped_tool'].includes(error.code);
      const code = signal?.aborted ? 'cancelled' : denied ? 'access_denied' : (error instanceof E7Error || ['qq_category_daily_limit', 'qq_receipt_unresolved'].includes(error.code)) ? error.code : 'image_delivery_failed';
      return text({status: 'unavailable', error: {code, message: MESSAGES[code] ?? '未取得图片投递回执，本轮不要再次发送'}});
    }
  }})}, {name, optional: true});
}
