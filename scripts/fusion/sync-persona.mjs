// Sync ONLY the persona/role material into the runtime workspace.
//
// Why this exists: config/README.md used to send "change the persona" at
// configure-deepseek-persona.mjs, which is a one-shot migration script that ALSO rewrites
// models.providers, the default model, deletes OPENAI_API_KEY and rewrites the runtime config.
// Using it as a routine persona command silently moved model and credential configuration as a
// side effect, and bypassed the repository's config source of truth.
//
// This script touches exactly four files under ${STATE_DIR}/workspace/ (SOUL.md, IDENTITY.md,
// AGENTS.md, USER.md). It never opens openclaw.json, never opens runtime-env.json, and never
// touches memory, reminders, chat history or state.
//
// Model and provider configuration is NOT handled here: it lives in config/runtime.config.json
// (`models`, `agents.*.model`) and is applied by sync-config.mjs.
//
// Usage:
//   node scripts/fusion/sync-persona.mjs            # check only (default)
//   node scripts/fusion/sync-persona.mjs --diff
//   node scripts/fusion/sync-persona.mjs --apply
import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR, REPO_ROOT } from './lib/legacy-source.mjs';

const PERSONA = path.join(REPO_ROOT, 'config/persona.json');
const WORKSPACE = path.join(STATE_DIR, 'workspace');
const AGENTS_TEMPLATE = path.join(REPO_ROOT, 'scripts/fusion/templates/AGENTS.md');

const argv = new Set(process.argv.slice(2));
const APPLY = argv.has('--apply');
const DIFF = argv.has('--diff') || APPLY;

if (!fs.existsSync(PERSONA)) {
  throw new Error(`Missing ${PERSONA}. It declares which role card is active, e.g. {"roleFile":"roles/小鲸鱼.md"}`);
}
const persona = JSON.parse(fs.readFileSync(PERSONA, 'utf8'));
const rolePath = path.join(REPO_ROOT, persona.roleFile);
if (!fs.existsSync(rolePath)) throw new Error(`Role card not found: ${rolePath}`);

/** Build the exact workspace file contents this persona implies. */
function desired() {
  const out = new Map();
  out.set('SOUL.md', fs.readFileSync(rolePath, 'utf8'));
  out.set(
    'IDENTITY.md',
    `# 当前角色\n\n- Name: ${persona.identityName}\n- Persona: ${persona.roleFile}，原样加载至SOUL.md\n- 所属项目: Kurumi融合助手；项目名不是当前角色名。\n`
  );
  let agents = fs.readFileSync(AGENTS_TEMPLATE, 'utf8');
  if (persona.agentsSubstitution) {
    agents = agents.replace(persona.agentsSubstitution.from, persona.agentsSubstitution.to);
  }
  out.set('AGENTS.md', agents);
  // USER.md deliberately holds no personal facts (those live in MEMORY.md); it is a fixed pointer
  // whose only persona-dependent part is how the owner is addressed.
  out.set('USER.md', persona.userFile);
  return out;
}

const want = desired();
const changes = [];
for (const [name, content] of want) {
  const file = path.join(WORKSPACE, name);
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  if (current === content) continue;
  changes.push({ name, file, reason: current === null ? 'missing' : 'differs' });
}

if (DIFF) {
  for (const c of changes) console.log(`  ${c.reason === 'missing' ? 'MISSING ' : 'DIFFERS '} ${c.name}`);
  console.log(`  role card: ${persona.roleFile}`);
  console.log('  NOT touched: openclaw.json, runtime-env.json, memory, reminders, state');
}

if (!changes.length) {
  console.log(`persona in sync with ${persona.roleFile} (${want.size} workspace file(s) match)`);
  process.exit(0);
}

if (!APPLY) {
  console.error(`\npersona DRIFT: ${changes.length} file(s) differ from ${persona.roleFile}`);
  console.error('Run with --diff to inspect, or --apply to write them.');
  process.exit(1);
}

fs.mkdirSync(WORKSPACE, { recursive: true, mode: 0o700 });
for (const c of changes) {
  fs.writeFileSync(c.file, want.get(c.name), { mode: 0o600 });
  console.log(`  wrote ${c.name}`);
}
console.log(`persona applied from ${persona.roleFile}; model and credential configuration untouched`);
