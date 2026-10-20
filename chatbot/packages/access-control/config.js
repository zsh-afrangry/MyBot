// Compile one editable permission matrix into the existing atomic runtime configuration plane.
import path from 'node:path';
import {validatePolicy, agentFor, MEMBER_TOOLS} from './index.js';
export function compileAccessConfig(input, value) {
  const cfg = structuredClone(input), policy = validatePolicy(value), owner = policy.subjects.find(r => r.role === 'owner');
  cfg.channels['kurumi-qq'].ownerId = owner.qq;
  cfg.channels['kurumi-qq'].accessControl = policy;
  cfg.commands = {...cfg.commands, ownerAllowFrom: [`kurumi-qq:${owner.qq}`]};
  const weather = cfg.plugins?.entries?.['personal-weather']?.config;
  if (weather) weather.scheduledOwnerId = owner.qq;
  const mail = cfg.plugins?.entries?.['kurumi-mail'];
  if (mail) mail.config = {...mail.config, allowedRecipients: [...owner.mailRecipients]};
  const entries = cfg.agents.entries;
  for (const key of Object.keys(entries)) if (/^qq-user-\d+$/.test(key)) delete entries[key];
  cfg.bindings = (cfg.bindings ?? []).filter(b => !/^qq-user-\d+$/.test(b.agentId));
  for (const row of policy.subjects) {
    if (row.kind !== 'user' || row.role === 'owner' || !row.enabled || !row.permissions['chat.use']) continue;
    const agentId = agentFor(row);
    entries[agentId] = {workspace: path.join(path.dirname(entries.main.workspace), 'users', row.qq, 'workspace'),
      model: structuredClone(entries.main.model), tools: {profile: 'full', allow: [...MEMBER_TOOLS],
        deny: ['read','write','edit','apply_patch','exec','process','message','sessions_spawn','sessions_list','sessions_history','automations','kurumi_memory']}};
    cfg.bindings.unshift({agentId, match: {channel: 'kurumi-qq', accountId: 'default', peer: {kind: 'direct', id: row.qq}}});
  }
  return cfg;
}
