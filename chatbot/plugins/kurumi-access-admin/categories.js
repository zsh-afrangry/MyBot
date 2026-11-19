import {AccessError, validatePolicy} from '../../packages/access-control/index.js';
import {assertQq, buildMemberChange, memberPreview, memberView, recipientKey,
  stringListChange, stringListPreview, stringListView} from './policy.js';

const owner = policy => policy.subjects.find(row => row.role === 'owner');
const members = policy => policy.subjects.filter(row => row.kind === 'user' && row.role === 'member').map(memberView);

const categories = {
  member: {
    target: 'access',
    arg: 'qq',
    parseKey(qq) { assertQq(qq); return qq; },
    key: row => row.qq,
    list: members,
    live: members,
    build: buildMemberChange,
    preview: ({change, before, after}, revision) => memberPreview(change, before, after, revision),
  },
  mail_recipient: {
    target: 'access',
    arg: 'key',
    parseKey: recipientKey,
    key: entry => entry,
    list: policy => stringListView(owner(policy).mailRecipients),
    live: (_policy, cfg) => {
      const values = cfg.plugins?.entries?.['kurumi-mail']?.config?.allowedRecipients;
      return Array.isArray(values) ? stringListView(values) : [];
    },
    build(policy, change) {
      const next = validatePolicy(policy);
      const row = owner(next);
      const changeRow = stringListChange(row.mailRecipients, change, recipientKey);
      row.mailRecipients = changeRow.entries;
      next.revision += 1;
      validatePolicy(next);
      return {...changeRow, next};
    },
    preview: ({before, after}, revision) => stringListPreview('邮件收件人', before, after,
      '同步后收件人与抄送均按新名单校验；本次变更不发送邮件。', revision),
  },
};

export const CATEGORY_NAMES = Object.freeze(Object.keys(categories));
export function getCategory(category, config) {
  if (typeof category !== 'string' || !Object.hasOwn(categories, category)) throw new AccessError('unknown_access_category');
  const enabled = config.plugins?.entries?.['kurumi-access-admin']?.config?.enabledCategories;
  if (category !== 'member' && (!Array.isArray(enabled) || !enabled.includes(category))) {
    throw new AccessError('access_category_not_enabled');
  }
  return categories[category];
}
