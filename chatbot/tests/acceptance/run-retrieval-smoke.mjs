/** A6 smoke test: isolated Host load with the new production config, no model calls. */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import { retrievalConfig, installRetrievalPlugins } from "./retrieval-config.mjs";

const root = resolve(process.env.KURUMI_SOURCE_ROOT || "/home/afrangry/.openclaw");
const host = process.env.OPENCLAW_HOST_ROOT || "/home/afrangry/.npm-global/lib/node_modules/openclaw";
const directory = mkdtempSync(join(tmpdir(), "kurumi-a6-smoke-"));
const env = parseEnv(readFileSync(join(root, "gateway.systemd.env"), "utf8"));
for (const k of ["TAVILY_API_KEY", "OPENAI_API_KEY", "QWEATHER_API_KEY", "QWEATHER_API_HOST"]) {
  assert(env[k], `Missing ${k}`); process.env[k] = env[k];
}
for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "NO_PROXY", "no_proxy"]) {
  const v = process.env[k] ?? env[k];
  if (v) process.env[k] = v;
}
process.env.OPENCLAW_STATE_DIR = directory;
process.env.OPENCLAW_CONFIG_PATH = join(directory, "openclaw.json");
process.env.OPENCLAW_AGENT_DIR = join(directory, "agents/main/agent");
const workspace = join(directory, "workspace"); mkdirSync(workspace);
const source = JSON.parse(readFileSync(join(root, "openclaw.json"), "utf8"));
const cfg = retrievalConfig(source);
cfg.agents.defaults.workspace = workspace;
cfg.session = { store: join(directory, "sessions.json"), dmScope: "per-channel-peer" };
cfg.gateway = { mode: "local", port: 19790, bind: "loopback" };
cfg.channels.qqbot = { ...cfg.channels.qqbot, enabled: true, appId: "acceptance", clientSecret: "not-a-real-secret", allowFrom: ["acceptance-owner"], groupAllowFrom: [] };
cfg.commands = { ownerAllowFrom: ["acceptance-owner"] };
cfg.models.providers = { naiccc: cfg.models.providers.naiccc };
installRetrievalPlugins(cfg, root);
cfg.plugins.entries["personal-weather"].config.apiHost = env.QWEATHER_API_HOST;
writeFileSync(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
writeFileSync(join(workspace, "AGENTS.md"), cfg.channels.qqbot.systemPrompt);
writeFileSync(join(workspace, "TOOLS.md"), "Use only the runtime tools. This is isolated acceptance; do not send messages.");

// 2026.9.7 ships content-hashed .mjs bundles (old builds used runtime-*.js / loader-*.js),
// so scan every dist chunk and match on the export table rather than on the file name.
async function hostExport(_prefix, name) {
  const dir = join(host, "dist");
  for (const file of readdirSync(dir).filter(x => /\.(mjs|js)$/.test(x))) {
    const full = join(dir, file);
    let body; try { body = readFileSync(full, "utf8"); } catch { continue; }
    if (!body.includes(name)) continue;
    const exports = [...body.matchAll(/export \{([^}]+)\}/g)].map(m => m[1]).join(",");
    const match = exports.split(",").map(x => x.trim()).find(x => x === name || x.startsWith(name + " as "));
    if (match) return (await import(pathToFileURL(full).href))[match.split(" as ")[1] || name];
  }
  throw Error(`Host export not found: ${name}`);
}
const prepare = await hostExport("runtime-", "prepareSecretsRuntimeSnapshot");
const activate = await hostExport("runtime-", "activateSecretsRuntimeSnapshot");
const snapshot = await prepare({ config: cfg, env: process.env, includeAuthStoreRefs: false });
activate(snapshot);
const resolved = snapshot.config;
assert.equal(typeof resolved.plugins.entries.tavily.config.webSearch.apiKey, "string");
const loadPlugins = await hostExport("loader-", "loadOpenClawPlugins");
// Registration only: no Gateway/channel services are started; credentials are synthetic.
const registry = loadPlugins({ config: resolved, workspaceDir: workspace });
assert(registry.plugins.some(p => p.id === "openclaw-qqbot" && p.status === "loaded"), "Tencent QQ plugin not loaded");
const errored = registry.plugins.filter(p => p.status === "error");
assert(!errored.length, "Plugin load failure: " + JSON.stringify(errored));
const { createOpenClawCodingTools } = await import(pathToFileURL(join(host, "dist/plugin-sdk/agent-harness.js")).href);
const options = { config: resolved, workspaceDir: workspace, agentDir: process.env.OPENCLAW_AGENT_DIR,
  agentId: "main", sessionKey: "agent:main:qqbot:direct:acceptance-owner", messageProvider: "qqbot",
  messageChannel: "qqbot", senderId: "acceptance-owner", senderIsOwner: true,
  modelProvider: "naiccc", modelId: "gpt-5.6-terra", modelApi: "openai-completions", modelHasVision: true };
const allTools = createOpenClawCodingTools(options);
const names = allTools.map(t => t.name);
for (const name of ["web_search", "web_fetch", "personal_weather_get_brief"]) assert(names.includes(name), `Missing ${name}`);
for (const name of ["personal_web_search", "tavily_search", "tavily_extract", "exec", "browser", "write"]) assert(!names.includes(name), `Unexpected ${name}`);
const groupTools = createOpenClawCodingTools({ ...options, sessionKey: "agent:main:qqbot:group:acceptance-group", groupId: "acceptance-group", chatType: "group" });
for (const name of ["web_search", "web_fetch", "personal_weather_get_brief"]) assert(!groupTools.some(t => t.name === name), `Group exposes ${name}`);
// R1: the old personal-search pipeline rejected a concurrent second search as QUOTA_EXCEEDED.
// Host-native web_search has no such gate; verify two parallel calls both succeed.
let concurrency = null;
if (process.env.KURUMI_SMOKE_CONCURRENCY === "1") {
  const tools = new Map(allTools.map(t => [t.name, t]));
  const decode = result => result.details ?? JSON.parse(result.content.find(c => c.type === "text").text);
  const queries = ["SQLite latest stable release official", "SQLite release history official"];
  const results = await Promise.all(queries.map((query, i) =>
    tools.get("web_search").execute("parallel-" + i, { query, count: 5 })
      .then(r => { const d = decode(r); return { ok: true, provider: d.provider, count: d.results?.length ?? 0, untrusted: d.externalContent?.untrusted, keys: Object.keys(d) }; })
      .catch(e => ({ ok: false, error: e.message }))));
  concurrency = results;
  assert(results.every(r => r.ok), "Concurrent web_search failed: " + JSON.stringify(results));
}
console.log(JSON.stringify({
  smoke: "A6", ok: true, directory,
  plugins: registry.plugins.map(p => ({ id: p.id, status: p.status })),
  toolNames: names, groupToolNames: groupTools.map(t => t.name),
  fetchConfig: resolved.tools.web.fetch, proxyEnvPresent: Boolean(process.env.HTTPS_PROXY),
  concurrency,
}, null, 2));
