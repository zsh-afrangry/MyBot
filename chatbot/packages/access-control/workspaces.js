// Project shared persona and scoped relationship files; never copy memory or private history.
import fs from 'node:fs';
import path from 'node:path';
import {compileAccessConfig} from './config.js';
import {agentFor} from './index.js';

function readRole(repo, relative) {
  if (typeof relative !== 'string' || !relative.startsWith('roles/') ||
      !relative.endsWith('.md') || relative.includes('\\') || relative.includes('\0') ||
      relative.split('/').some(part => !part || part === '.' || part === '..')) {
    throw Error('invalid_persona_role_path');
  }
  const file = path.resolve(repo, relative);
  if (fs.realpathSync(file) !== file || !fs.statSync(file).isFile()) {
    throw Error('persona_role_symlink_rejected');
  }
  const text = fs.readFileSync(file, 'utf8');
  if (!text.trim() || /\{\{[^}]*\}\}/u.test(text)) throw Error('invalid_persona_role_content');
  return text;
}

function relationshipFiles(repo, value) {
  // Legacy persona configs have no relationship layer. A configured layer must be complete.
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'member,owner') {
    throw Error('invalid_persona_relationship_files');
  }
  return {owner: readRole(repo, value.owner), member: readRole(repo, value.member)};
}

function withRelationship(user, relationship) {
  return relationship ? `${user.trimEnd()}\n\n${relationship.trimEnd()}\n` : user;
}

export function personaFiles(repo, state) {
  const persona = JSON.parse(fs.readFileSync(path.join(repo, 'config/persona.json'), 'utf8'));
  if (typeof persona.identityName !== 'string' || !persona.identityName.trim() ||
      persona.identityName.length > 60 || /[\r\n]|\{\{/u.test(persona.identityName) ||
      typeof persona.userFile !== 'string' || /\{\{[^}]*\}\}/u.test(persona.userFile)) {
    throw Error('invalid_persona_identity');
  }
  const policy = JSON.parse(fs.readFileSync(path.join(repo, 'config/access-control.json'), 'utf8'));
  const cfg = compileAccessConfig(JSON.parse(fs.readFileSync(path.join(repo, 'config/runtime.config.json'), 'utf8')), policy);
  const soul = readRole(repo, persona.roleFile);
  const relationships = relationshipFiles(repo, persona.relationshipFiles);
  const identity = `# 当前角色\n\n- Name: ${persona.identityName}\n- Persona: ${persona.roleFile}，原样加载至SOUL.md\n- 所属项目: Kurumi融合助手；项目名不是当前角色名。\n`;
  let agents = fs.readFileSync(path.join(repo, 'scripts/fusion/templates/AGENTS.md'), 'utf8');
  if (persona.agentsSubstitution) {
    const {from, to} = persona.agentsSubstitution;
    if (typeof from !== 'string' || !from || typeof to !== 'string' ||
        agents.split(from).length !== 2) throw Error('persona_agents_substitution_mismatch');
    agents = agents.replace(from, () => to);
  }
  const out = new Map();
  const add = (workspace, files) => {
    for (const [name, text] of Object.entries(files)) out.set(path.join(workspace, name), text);
  };
  add(path.join(state, 'workspace'), {
    'SOUL.md': soul, 'IDENTITY.md': identity, 'AGENTS.md': agents,
    'USER.md': withRelationship(persona.userFile, relationships.owner),
  });
  for (const row of policy.subjects) {
    if (row.role === 'owner' || !row.enabled || !row.permissions['chat.use'] || row.kind !== 'user') continue;
    const workspace = path.join(state, 'users', row.qq, 'workspace');
    if (!cfg.agents.entries[agentFor(row)]) throw Error('missing_member_agent');
    add(workspace, {
      'SOUL.md': soul, 'IDENTITY.md': identity,
      'AGENTS.md': fs.readFileSync(path.join(repo, 'scripts/fusion/templates/MEMBER_AGENTS.md'), 'utf8'),
      'USER.md': withRelationship('# 当前私聊用户\n\n这是独立身份，默认中文与Asia/Shanghai时区。没有主人资料，不共享其他QQ的记忆、文件、任务或会话。\n', relationships.member),
    });
  }
  return {files: out, roleFile: persona.roleFile};
}

export function applyPersonaFile(file, content) {
  fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
  if (fs.realpathSync(path.dirname(file)) !== path.dirname(file)) throw Error('workspace_symlink_rejected');
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw Error('persona_symlink_rejected');
  const temp = file + '.tmp.' + process.pid;
  try {
    fs.writeFileSync(temp, content, {mode: 0o600, flag: 'wx'});
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, {force: true});
  }
}
