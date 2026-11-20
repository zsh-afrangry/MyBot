// Explicit capability vocabulary and tool mapping. Contract: docs/24.
// A new tool/operation needs a mapping; an owner's role never grants future capabilities.
export const SHARED_PERMISSIONS = Object.freeze([
  'chat.use', 'commands.basic', 'search.use', 'qq.reply', 'qq.file.reply', 'qq.notify',
  'papers.import', 'papers.read', 'papers.translate', 'papers.cancel',
]);
export const OWNER_PERMISSIONS = Object.freeze([
  'papers.rename',
  'commands.admin', 'access.manage', 'stickers.use', 'mail.status', 'mail.draft', 'mail.send', 'mail.history',
  'weather.read', 'profile.read', 'profile.manage', 'planning.read', 'planning.manage',
  'reminders.read', 'reminders.manage', 'reminder-list.read', 'reminder-list.manage', 'reminder-list.schedule',
  'memory.read', 'memory.manage', 'memory.raw.read', 'memory.organize', 'bills.read', 'bills.manage', 'tasks.code', 'tasks.research', 'tasks.read',
  'automations.read', 'automations.manage', 'sessions.read', 'e7.read', 'e7.image', 'host.exec', 'logs.read',
  'proactive.read', 'proactive.manage', 'proactive.use', 'proactive.notify',
]);
export const PERMISSIONS = Object.freeze([...SHARED_PERMISSIONS, ...OWNER_PERMISSIONS, 'sightings.read']);
export const MEMBER_TOOLS = Object.freeze(['session_status', 'web_search', 'web_fetch', 'kurumi_document', 'kurumi_translate', 'kurumi_document_send']);

const DIRECT = {
  kurumi_sightings: 'sightings.read',
  kurumi_logs:'logs.read', dispatch_action:'chat.use', tool_search: 'chat.use', tool_describe:'chat.use', tool_call:'chat.use', session_status: 'chat.use', web_search: 'search.use', web_fetch: 'search.use', exec: 'host.exec', e7_image: 'e7.image',
  personal_weather_get_brief: 'weather.read', personal_profile_state_get: 'profile.read',
  personal_profile_change_propose: 'profile.manage', personal_profile_change_commit: 'profile.manage',
  personal_planning_state_get: 'planning.read', personal_planning_change_propose: 'planning.manage', personal_planning_change_commit: 'planning.manage',
  personal_reminder_state_get: 'reminders.read', personal_reminder_propose: 'reminders.manage', personal_reminder_commit: 'reminders.manage',
  personal_reminder_change_propose: 'reminders.manage', personal_reminder_change_commit: 'reminders.manage',
  personal_reminder_cancel_propose: 'reminders.manage', personal_reminder_cancel_commit: 'reminders.manage',
  personal_reminder_list_get: 'reminder-list.read',
  kurumi_sticker: 'stickers.use', email_status: 'mail.status', email_draft: 'mail.draft', email_send: 'mail.send', email_outbox: 'mail.history',
  knowledge_bills_get: 'bills.read', knowledge_bill_add: 'bills.manage', knowledge_bill_manage: 'bills.manage',
  sessions_list: 'sessions.read', sessions_history: 'sessions.read',
  kurumi_document_send: 'qq.file.reply',
};
const CONFIRMATION = {
  personal_reminder: ['reminders.read', 'reminders.manage'], personal_profile: ['profile.read', 'profile.manage'],
  planning: ['planning.read', 'planning.manage'], mail: ['mail.history', 'mail.send'], coding: ['tasks.read', 'tasks.code'],
  access: ['access.manage', 'access.manage'],
};

function actions(groups, fallback) {
  const byAction = new Map(Object.entries(groups).flatMap(([permission, names]) => names.map(name => [name, permission])));
  return {
    resolve: args => byAction.get(args.action) ?? fallback,
    permissions: [...new Set([...byAction.values(), ...(fallback ? [fallback] : [])])],
  };
}

const POLICIES = {
  personal_confirmation: {
    resolve: args => ['list', 'preview', 'confirm'].includes(args.action) && Object.hasOwn(CONFIRMATION, args.domain)
      ? CONFIRMATION[args.domain][args.action === 'confirm' ? 1 : 0] : undefined,
    permissions: [...new Set(Object.values(CONFIRMATION).flat())],
  },
  kurumi_access: actions({'access.manage': ['list', 'get', 'propose', 'commit', 'status']}),
  kurumi_proactive: actions({'proactive.read': ['status', 'records'], 'proactive.manage': ['pause', 'resume', 'record_put', 'record_remove'],
    'proactive.use': ['query', 'remember', 'forget', 'sources'], 'proactive.notify': ['notify']}),
  e7_data: actions({'e7.read': ['search', 'hero', 'artifact', 'dictionary', 'codes', 'news', 'builds', 'reviews', 'rankings', 'content', 'gvg', 'fates', 'packs']}),
  personal_reminder_list_manage: actions({'reminder-list.schedule': ['schedule', 'pause', 'resume']}, 'reminder-list.manage'),
  kurumi_memory: actions({'memory.read': ['list', 'search']}, 'memory.manage'),
  kurumi_memory_records: actions({'memory.read': ['search', 'get', 'history'],
    'memory.manage': ['write', 'revise', 'supersede', 'retract', 'forget']}),
  kurumi_memory_raw: actions({'memory.raw.read': ['around', 'search']}),
  kurumi_code: actions({'tasks.read': ['list', 'status', 'result', 'diff'],
    'tasks.code': ['start', 'continue', 'cancel', 'rollback', 'reconcile', 'preview', 'merge']}),
  kurumi_task: {
    resolve: args => args.action === 'start' ? args.kind === 'research' ? 'tasks.research' : 'tasks.code' : 'tasks.read',
    permissions: ['tasks.read', 'tasks.research', 'tasks.code'],
  },
  automations: actions({'automations.read': ['list', 'get', 'status', 'runs']}, 'automations.manage'),
  kurumi_document: actions({'papers.rename': ['rename'], 'papers.import': ['fetch'], 'papers.read': ['list', 'get', 'find']}),
  kurumi_translate: actions({'papers.translate': ['start'], 'papers.read': ['status', 'list'], 'papers.cancel': ['cancel']}),
};

export function toolPermission(name, args = {}) {
  if (Object.hasOwn(DIRECT, name)) return DIRECT[name];
  return Object.hasOwn(POLICIES, name) ? POLICIES[name].resolve(args) : undefined;
}

// Catalog view only. Execution still checks the one permission selected by actual arguments.
export function toolPermissions(name) {
  if (Object.hasOwn(DIRECT, name)) return [DIRECT[name]];
  return Object.hasOwn(POLICIES, name) ? [...POLICIES[name].permissions] : [];
}
