// Configure the isolated runtime's web search/fetch path.
//
// Two hard requirements this file used to violate:
//   1. The native Tavily provider must come from the CONTROLLED plugin install
//      (/home/afrangry/.openclaw-fusion/plugins), not from a scan of the legacy
//      .openclaw/npm/projects tree.
//   2. Credentials and proxy settings must come from the isolated runtime env, which already
//      holds every migrated value. The legacy tree is only consulted on a genuine first run
//      (see lib/legacy-source.mjs), so this script is dependency-free on a live host.
import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR, runtimeConfig, runtimeEnv, credential } from './lib/legacy-source.mjs';

const PLUGIN_ROOT = path.join(STATE_DIR, 'plugins/node_modules/@openclaw/tavily-plugin');
const PLUGIN_MANIFEST = path.join(PLUGIN_ROOT, 'openclaw.plugin.json');
const EXPECTED_VERSION = '2026.9.7';
const PROXY_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'];

if (!fs.existsSync(PLUGIN_MANIFEST)) {
  throw new Error(`Tavily provider is not installed at ${PLUGIN_ROOT}. Run: node scripts/fusion/install-plugins.mjs`);
}
const pluginVersion = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'package.json'), 'utf8')).version;
if (pluginVersion !== EXPECTED_VERSION) {
  throw new Error(`Expected @openclaw/tavily-plugin ${EXPECTED_VERSION}, found ${pluginVersion}; re-run contract acceptance before upgrading`);
}

const cfg = runtimeConfig();
const env = runtimeEnv();

// Credential + proxy plane. Already-migrated values win; the legacy tree is only a first-run fallback.
env.TAVILY_API_KEY = credential('TAVILY_API_KEY', { env });
for (const key of PROXY_KEYS) {
  if (env[key]) continue;
  const legacy = credential(key, { env: {} });
  if (legacy) env[key] = legacy;
}

cfg.tools.web.search = { ...cfg.tools.web.search, enabled: true, provider: 'tavily' };
cfg.tools.web.fetch = { ...cfg.tools.web.fetch, enabled: true, maxChars: 15000, maxCharsCap: 15000 };
cfg.plugins.entries.tavily = { ...cfg.plugins.entries.tavily, enabled: true };
cfg.plugins.allow = [...new Set([...cfg.plugins.allow, 'tavily'])];
cfg.plugins.load.paths = [...new Set([...cfg.plugins.load.paths, PLUGIN_ROOT])];
cfg.agents.entries.main.tools.alsoAllow = [...new Set([...cfg.agents.entries.main.tools.alsoAllow, 'web_search', 'web_fetch'])];

fs.writeFileSync(`${STATE_DIR}/openclaw.json`, JSON.stringify(cfg, null, 2), { mode: 0o600 });
fs.writeFileSync(`${STATE_DIR}/runtime-env.json`, JSON.stringify(env, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ searchProvider: cfg.tools.web.search.provider, plugin: PLUGIN_ROOT, pluginVersion, credentialsNotPrinted: true }));
