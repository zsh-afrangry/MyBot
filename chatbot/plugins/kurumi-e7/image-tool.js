import {createHash} from 'node:crypto';
import {assertToolAccess} from '../../packages/access-control/index.js';
import {createQqDelivery} from '../../packages/qq-delivery/index.js';
import {businessFeedback, notificationFeedback, observeFeedback} from '../../packages/feedback-core/index.js';
import {createTrustedOwnerRequest} from '../../packages/trusted-inbound/index.js';
import {IMAGE_KINDS} from './images.js';
import {E7Error} from './policy.js';
import {BUILD_FILTER_FIELDS} from './query.js';

export const E7_IMAGE_TOOL = {
  name: 'e7_image', label: '发送第七史诗图片',
  description: '仅在主人本轮明确要图时调用一次，只发所指定的一种。先用e7_data搜索真实heroCode。英雄资料卡/技能倍率图用hero_card；要配装面板图用build_card，count为样本数（1到10，十套也只发一张合辑），套装/属性限制用filters，样本不足以coverage.shown为准。要头像只用avatar；detail为半身详情图（不是完整立绘）、cover为封面、skill为技能图（附槽位）、effect为已关联效果图（附真实effectId）。发到当前本人QQ。收到sent或already_sent就结束发图；回执不明时不要再次调用。',
  parameters: {type: 'object', additionalProperties: false, required: ['heroCode', 'kind'], properties: {
    heroCode: {type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,79}$'},
    kind: {type: 'string', enum: IMAGE_KINDS},
    skill: {type: 'integer', minimum: 1, maximum: 3, description: '仅技能图必填'},
    effectId: {type: 'string', pattern: '^[A-Za-z0-9_-]{1,80}$', description: '仅效果图必填'},
    count: {type: 'integer', minimum: 1, maximum: 10, description: '仅build_card，默认1；所有样本合成一张图'},
    filters: {type: 'object', additionalProperties: false, minProperties: 1, properties: BUILD_FILTER_FIELDS, description: '仅build_card，筛选套装和属性下限'},
  }},
};

const MESSAGES = {
  access_denied: '当前身份没有发送E7图片的权限',
  unknown_hero: '角色代码未找到，请先用资料查询确认角色',
  image_unavailable: '来源没有登记该角色对应的图片',
  invalid_query: '请核对图片类型及所需参数；只有配装图接受样本数和筛选条件',
  invalid_response: '图片格式与来源声明不符',
  no_build_samples: 'E7·WIKI 没有符合条件的社区配装样本，未发图',
  image_render_failed: '资料卡生成失败，未发图',
  image_busy: '资料卡生成忙，请稍后再试',
  image_request_required: '无法核对本次主人私聊回合，未尝试投递',
  response_too_large: '来源图片超过大小上限',
  qq_category_daily_limit: '已达到过去24小时的图片投递上限',
  qq_receipt_unresolved: '本轮已尝试投递，仍无可确认的回执，未再次发送',
  cancelled: '图片请求已取消',
};
const text = result => ({content: [{type: 'text', text: JSON.stringify(result)}]});
const action = 'e7.image';
const noResults = new Set(['no_build_samples', 'unknown_hero', 'image_unavailable']);

export function registerImageTool(api, service, telemetry, deliveryFactory = createQqDelivery) {
  const name = E7_IMAGE_TOOL.name;
  const inbound = createTrustedOwnerRequest(api.config.channels?.['kurumi-qq']?.ownerId);
  if (api.registrationMode === 'full' || api.registrationMode === undefined) {
    api.on('reply_dispatch', inbound.receive);
    api.on('session_end', inbound.end);
    api.on('before_reset', inbound.end);
  }
  api.registerTool({contextVersion: 2, create: ctx => {
    const request = inbound.current();
    return {...E7_IMAGE_TOOL, async execute(callId, args, signal) {
      const config = () => ctx.getRuntimeConfig?.() ?? api.config;
      const check = () => {
        const actor = assertToolAccess(ctx, config(), name);
        if (!actor.owner) throw new E7Error('access_denied');
        ctx.assertInvocationCurrent();
        signal?.throwIfAborted();
        return actor;
      };
      let binding, recordFailure, imageReady = false;
      try {
        const actor = check();
        if (typeof callId !== 'string' || !callId) throw new E7Error('invalid_query');
        const runId = telemetry.resolve(ctx, callId, name);
        if (!runId || !ctx.sessionId) throw new E7Error('image_request_required');
        const trace = {sessionKey: ctx.sessionKey, sessionId: ctx.sessionId, toolCallId: callId, runId};
        // Different tool calls in the same run share the original send reservation.
        const key = 'e7:run:' + createHash('sha256').update(JSON.stringify([actor.id, ctx.sessionId, runId])).digest('hex');
        const to = 'user:' + actor.id;
        const delivery = deliveryFactory(config);
        if (request) observeFeedback(action, api.logger, () => {
          const {messageId: sourceMessageId} = inbound.require(request, ctx, config());
          binding = {action, sourceMessageId, runId};
          recordFailure = (imageStatus, code) => observeFeedback(action, api.logger, () => {
            check();
            delivery.recordImageFeedback?.({to, key, ...binding, imageStatus,
              evidence: {code, ...(imageStatus === 'no_results' && {matched: 0})}});
          });
        });
        const {bytes, contentType, caption, coverage} = await service.image(args, {signal, trace});
        check();
        imageReady = true;
        const evidence = {heroCode: args.heroCode, kind: args.kind, ...(coverage && {coverage})};
        const {channel, messageId, replayed} = await delivery.sendImage({
          to, bytes, contentType, signal, key,
          text: caption ?? '图片版权归《第七史诗》官方，经 E7·WIKI 获取。', assertDirectAdapterHandoff: check,
          ...(binding && {feedback: {...binding, evidence, log: api.logger}}),
        });
        const result = replayed ? {status: 'already_sent', channel, messageId, message: '本轮已有一张图片的回执，这次没有发送新图'}
          : {status: 'sent', channel, messageId, ...(coverage && {coverage})};
        return text(binding ? {...result, sourceMessageId: binding.sourceMessageId,
          feedback: businessFeedback(action, 'succeeded', replayed ? {} : evidence),
          notification: notificationFeedback({action: 'qq.image', platformStatus: 'accepted'}),
        } : result);
      } catch (error) {
        const denied = ['identity_not_enabled', 'capability_not_allowed', 'untrusted_identity_context', 'unmapped_tool'].includes(error.code);
        const code = signal?.aborted ? 'cancelled' : denied ? 'access_denied' : (error instanceof E7Error || ['qq_category_daily_limit', 'qq_receipt_unresolved'].includes(error.code)) ? error.code : 'image_delivery_failed';
        const empty = noResults.has(code);
        if (!imageReady && !denied) recordFailure?.(empty ? 'no_results' : 'failed', code);
        return text({status: 'unavailable', error: {code, message: MESSAGES[code] ?? '未取得图片投递回执，本轮不要再次发送'},
          ...(binding && !denied && !signal?.aborted && {
            sourceMessageId: binding.sourceMessageId,
            feedback: businessFeedback(action, imageReady ? 'succeeded' : empty ? 'skipped' : 'failed', {code}),
            notification: notificationFeedback({action: 'qq.image', platformStatus: error.rejected ? 'rejected' : imageReady && code !== 'qq_category_daily_limit' ? 'unknown' : 'not_attempted'}),
          }),
        });
      }
    }};
  }}, {name, optional: true});
}
