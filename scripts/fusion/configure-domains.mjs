// Enable the owner-bound domain plugins (weather / Profile / planning / reminders) in the isolated
// runtime. Credentials come from the runtime env, which already holds every migrated value; the
// legacy tree is only consulted for the original plugin config block on a genuine first run.
//
// NOTE: this is the acceptance-time variant and it turns `testIngress` ON. Run
// configure-production.mjs afterwards to close the test entry point again.
import fs from 'node:fs';
import { REPO_ROOT, STATE_DIR, credential, runtimeConfig, runtimeEnv, legacySource } from './lib/legacy-source.mjs';

/** Original plugin entry block, only needed when the isolated runtime has none yet. */
function legacyEntry(id, cfg) {
  if (cfg.plugins.entries?.[id]) return cfg.plugins.entries[id];
  const legacyConfig = `${legacySource()}/openclaw.json`;
  const source = JSON.parse(fs.readFileSync(legacyConfig, 'utf8'));
  return source.plugins?.entries?.[id] ?? {};
}

const cfg = runtimeConfig();
const env = runtimeEnv();

for (const key of ['QWEATHER_API_KEY', 'QWEATHER_API_HOST']) env[key] = credential(key, { env });

for (const id of ['personal-confirmation', 'personal-weather']) {
  cfg.plugins.allow = [...new Set([...cfg.plugins.allow, id])];
  cfg.plugins.load.paths = [...new Set([...cfg.plugins.load.paths, `${REPO_ROOT}/chatbot/plugins/${id}`])];
  cfg.plugins.entries[id] = { ...legacyEntry(id, cfg), enabled: true };
}

cfg.plugins.entries['personal-weather'].config = {
  ...cfg.plugins.entries['personal-weather'].config,
  scheduledOwnerId: cfg.channels['kurumi-qq'].ownerId,
  reminderBackend: 'native-service',
  reminderRunnerRoot: `${REPO_ROOT}/chatbot/plugins/personal-weather`
};

const domainTools = [
  'personal_weather_get_brief',
  'personal_profile_state_get',
  'personal_profile_change_propose',
  'personal_profile_change_commit',
  'personal_planning_state_get',
  'personal_planning_change_propose',
  'personal_planning_change_commit',
  'personal_reminder_state_get',
  'personal_reminder_propose',
  'personal_reminder_commit',
  'personal_reminder_change_propose',
  'personal_reminder_change_commit',
  'personal_reminder_cancel_propose',
  'personal_reminder_cancel_commit'
];
cfg.agents.entries.main.tools.alsoAllow = [...new Set([...cfg.agents.entries.main.tools.alsoAllow, ...domainTools])];
cfg.channels['kurumi-qq'].testIngress = true;

fs.writeFileSync(`${STATE_DIR}/openclaw.json`, JSON.stringify(cfg, null, 2), { mode: 0o600 });
fs.writeFileSync(`${STATE_DIR}/runtime-env.json`, JSON.stringify(env, null, 2), { mode: 0o600 });
console.log(
  JSON.stringify({
    domains: ['personal-confirmation', 'personal-weather'],
    tools: domainTools.length,
    testIngress: true,
    reminderBackend: cfg.plugins.entries['personal-weather'].config.reminderBackend,
    credentialsNotPrinted: true
  })
);
