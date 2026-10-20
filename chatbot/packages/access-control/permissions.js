// Explicit capability vocabulary and tool mapping. Contract: docs/24.
// A new tool/operation needs a mapping; an owner's role never grants future capabilities.
export const SHARED_PERMISSIONS = Object.freeze([
  'chat.use', 'commands.basic', 'search.use', 'qq.reply', 'qq.file.reply', 'qq.notify',
  'papers.import', 'papers.read', 'papers.translate', 'papers.cancel',
]);
export const OWNER_PERMISSIONS = Object.freeze([
  'commands.admin', 'access.manage', 'stickers.use', 'mail.status', 'mail.draft', 'mail.send', 'mail.history',
  'weather.read', 'profile.read', 'profile.manage', 'planning.read', 'planning.manage',
  'reminders.read', 'reminders.manage', 'reminder-list.read', 'reminder-list.manage', 'reminder-list.schedule',
  'memory.read', 'memory.manage', 'bills.read', 'bills.manage', 'tasks.code', 'tasks.research', 'tasks.read',
  'automations.read', 'automations.manage', 'sessions.read',
]);
export const PERMISSIONS = Object.freeze([...SHARED_PERMISSIONS, ...OWNER_PERMISSIONS]);
export const MEMBER_TOOLS = Object.freeze(['session_status', 'web_search', 'web_fetch', 'kurumi_document', 'kurumi_translate', 'kurumi_document_send']);

export function toolPermission(name, args = {}) {
  const direct = {
    tool_search: 'chat.use', tool_describe:'chat.use', tool_call:'chat.use', session_status: 'chat.use', web_search: 'search.use', web_fetch: 'search.use',
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
  };
  if (direct[name]) return direct[name];
  if (name === 'personal_reminder_list_manage') return ['schedule', 'pause', 'resume'].includes(args.action) ? 'reminder-list.schedule' : 'reminder-list.manage';
  if (name === 'kurumi_memory') return ['list', 'search'].includes(args.action) ? 'memory.read' : 'memory.manage';
  if (name === 'kurumi_task') return args.action === 'start' ? args.kind === 'research' ? 'tasks.research' : 'tasks.code' : 'tasks.read';
  if (name === 'automations') return ['list', 'get', 'status', 'runs'].includes(args.action) ? 'automations.read' : 'automations.manage';
  if (name === 'kurumi_document') return args.action==='fetch'?'papers.import':['list','get'].includes(args.action)?'papers.read':undefined;
  if (name === 'kurumi_translate') return ({start: 'papers.translate', status: 'papers.read', list: 'papers.read', cancel: 'papers.cancel'})[args.action];
  if (name === 'kurumi_document_send') return 'qq.file.reply';
  return undefined;
}
