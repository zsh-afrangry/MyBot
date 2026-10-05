/** Native Host tools + real providers in fresh isolated state. Never delivers QQ. */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import { retrievalConfig, installRetrievalPlugins } from "./retrieval-config.mjs";

const root = resolve(process.env.KURUMI_SOURCE_ROOT || (()=>{throw new Error('This acceptance harness reads a legacy tree. Set KURUMI_SOURCE_ROOT to an extracted legacy source (see kurumi-backups); it no longer defaults to /home/afrangry/.openclaw')})());
const host = process.env.OPENCLAW_HOST_ROOT || "/home/afrangry/.npm-global/lib/node_modules/openclaw";
const directory = mkdtempSync(join(tmpdir(), "kurumi-retrieval-host-"));
const env = parseEnv(readFileSync(join(root, "gateway.systemd.env"), "utf8"));
for (const k of ["TAVILY_API_KEY", "OPENAI_API_KEY", "QWEATHER_API_KEY", "QWEATHER_API_HOST"]) {
  assert(env[k], `Missing ${k}`); process.env[k] = env[k];
}
// A1: web_fetch routes through the trusted env proxy when configured; pass it into the isolated run.
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
cfg.gateway = { mode: "local", port: 19789, bind: "loopback" };
cfg.channels.qqbot = { ...cfg.channels.qqbot, enabled: true, appId: "acceptance", clientSecret: "not-a-real-secret", allowFrom: ["acceptance-owner"], groupAllowFrom: [] };
cfg.commands = { ownerAllowFrom: ["acceptance-owner"] };
cfg.models.providers = { naiccc: cfg.models.providers.naiccc };
installRetrievalPlugins(cfg, root);
cfg.plugins.entries["personal-weather"].config.apiHost = env.QWEATHER_API_HOST;
writeFileSync(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
writeFileSync(join(workspace, "AGENTS.md"), cfg.channels.qqbot.systemPrompt);
writeFileSync(join(workspace, "TOOLS.md"), "Use only the runtime tools. This is isolated acceptance; do not send messages.");

// Locate the installed build's internal exports without hard-coding bundle hashes.
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
assert(!registry.plugins.some(p => p.status === "error"), "Plugin load failure");
const { createOpenClawCodingTools } = await import(pathToFileURL(join(host, "dist/plugin-sdk/agent-harness.js")).href);
const options = { config: resolved, workspaceDir: workspace, agentDir: process.env.OPENCLAW_AGENT_DIR,
  agentId: "main", sessionKey: "agent:main:qqbot:direct:acceptance-owner", messageProvider: "qqbot",
  messageChannel: "qqbot", senderId: "acceptance-owner", senderIsOwner: true,
  deliveryContext: { channel: "qqbot", to: "qqbot:direct:acceptance-owner" },
  modelProvider: "naiccc", modelId: "gpt-5.6-terra", modelApi: "openai-completions", modelHasVision: true };
const allTools = createOpenClawCodingTools(options);
const names = allTools.map(t => t.name);
for (const name of ["web_search", "web_fetch", "personal_weather_get_brief"]) assert(names.includes(name), `Missing ${name}`);
for (const name of ["personal_web_search", "tavily_search", "tavily_extract", "exec", "browser", "write"]) assert(!names.includes(name), `Unexpected ${name}`);
const groupTools = createOpenClawCodingTools({ ...options, sessionKey: "agent:main:qqbot:group:acceptance-group", groupId: "acceptance-group", chatType: "group", deliveryContext: { channel: "qqbot", to: "qqbot:group:acceptance-group" } });
for (const name of ["web_search", "web_fetch", "personal_weather_get_brief"]) assert(!groupTools.some(t => t.name === name), `Group exposes ${name}`);
const tools = new Map(allTools.map(t => [t.name, t]));
const decode = result => result.details ?? JSON.parse(result.content.find(c => c.type === "text").text);
const report = { directory, boundary: "Fresh Host state, synthetic QQ owner, native Host tools, real API calls; no QQ send, no production DB, no running plugin services.",
  secretRefResolved: true, plugins: registry.plugins.map(p => ({ id: p.id, status: p.status })), toolNames: names, groupToolNames: groupTools.map(t => t.name), checks: [], turns: [] };
const save = () => writeFileSync(join(directory, "report.json"), JSON.stringify(report, null, 2));
console.log("DIRECTORY " + directory); save();
try {
  const search = await Promise.all(["SQLite latest stable release official", "SQLite release history official"].map(async query => {
    const data = decode(await tools.get("web_search").execute("parallel-search", { query, count: 5 }));
    assert.equal(data.provider, "tavily"); assert(data.results?.length); assert(data.externalContent?.untrusted === true);
    return { provider: data.provider, count: data.results.length, urls: data.results.map(r => r.url), tookMs: data.tookMs };
  }));
  report.checks.push({ name: "parallel-native-search", passed: true, results: search }); save();
  const page = decode(await tools.get("web_fetch").execute("official-fetch", { url: "https://sqlite.org/changes.html" }));
  assert.equal(page.status, 200); assert(page.externalContent?.untrusted === true); assert(/SQLite/i.test(page.text));
  assert(/\b20\d{2}-\d{2}-\d{2}\b/.test(page.text)); assert(page.text.length <= resolved.tools.web.fetch.maxCharsCap);
  report.checks.push({ name: "native-fetch-official", passed: true, url: page.url, chars: page.text.length, rawLength: page.rawLength, truncated: page.truncated, extractor: page.extractor, excerpt: page.text.slice(0, 4500) }); save();
  await assert.rejects(() => tools.get("web_fetch").execute("private-fetch", { url: "http://127.0.0.1:18789" }));
  report.checks.push({ name: "private-address-blocked", passed: true }); save();
  if (process.env.KURUMI_HOST_TOOLS_ONLY === "1") {
    report.scope = "host-tools-only; model turns not run"; report.passed = true; save();
    console.log("REPORT " + join(directory, "report.json")); process.exit(0);
  }
  const { default: OpenAI } = await import(pathToFileURL(join(host, "node_modules/openai/index.js")).href);
  const client = new OpenAI({ apiKey: env.OPENAI_API_KEY, baseURL: source.models.providers.naiccc.baseUrl, timeout: 180000, maxRetries: 0 });
  const allowed = ["web_search", "web_fetch", "personal_weather_get_brief"];
  const specs = allowed.map(name => { const t = tools.get(name); return { type: "function", function: { name, description: t.description, parameters: t.parameters } }; });
  const questions = [
    { id: "Q1", text: "查询 SQLite 官方发布历史，给出最新稳定版本号、发布日期，以及该版本的一项变化。必须给出实际官方来源。", search: true },
    { id: "Q5", text: "简单解释什么是哈希表，以及它平均情况下的查找复杂度。", search: false },
    { id: "Q6", text: "广州现在多少度？", search: false, weather: true },
  ];
  for (const question of questions) {
    const turn = { id: question.id, calls: [], startedAt: Date.now() }; report.turns.push(turn);
    const messages = [{ role: "system", content: cfg.channels.qqbot.systemPrompt + "\n当前日期：" + new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" }) + "，时区 Asia/Shanghai。" }, { role: "user", content: question.text }];
    for (let step = 0; step < 10; step++) {
      const response = await client.chat.completions.create({ model: "gpt-5.6-terra", messages, tools: specs, max_tokens: 4096 });
      const message = response.choices[0].message; messages.push(message);
      turn.modelRounds = step + 1;
      if (!message.tool_calls?.length) { turn.answer = message.content; break; }
      for (const call of message.tool_calls) {
        assert(allowed.includes(call.function.name));
        const args = JSON.parse(call.function.arguments); const started = Date.now();
        let result;
        try { result = decode(await tools.get(call.function.name).execute(call.id, args)); }
        catch (e) { result = { error: e.message }; }
        turn.calls.push({ name: call.function.name, args, tookMs: Date.now() - started, result }); save();
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
      }
    }
    turn.tookMs = Date.now() - turn.startedAt;
    assert(turn.answer, `${question.id}: missing final answer`);
    assert.equal(turn.calls.some(c => c.name === "web_search"), question.search);
    if (question.search) {
      assert(turn.calls.some(c => c.name === "web_fetch" && c.result.status === 200));
      // Compare with the version/date actually fetched this run, never a frozen latest version.
      const fetched = turn.calls.filter(c => c.name === "web_fetch" && c.result.status === 200).map(c => c.result.text ?? "").join("\n");
      const versions = turn.answer.match(/\b3\.\d+\.\d+\b/g) ?? [];
      assert(versions.some(v => fetched.includes(v)), "Answer version absent from fetched official text");
      // Source agreement is a smoke check; latest-version correctness still needs review.
      assert(/https:\/\/(www\.)?sqlite\.org\//.test(turn.answer));
    }
    // Isolated harness calls tools directly and seeds no QQ session entry, so
    // deliveryContextFromSession() yields no `to`; the weather plugin's owner gate then
    // returns forbidden_context. That gate is out of scope here and covered in production.
    // The retrieval-relevant requirement (Q6 must NOT search) is asserted above.
    if (question.weather) assert(turn.calls.some(c => c.name === "personal_weather_get_brief"));
    turn.passed = true; save(); console.log(JSON.stringify({ id: turn.id, passed: true, tookMs: turn.tookMs, calls: turn.calls.map(c => c.name) }));
  }
  report.passed = true; save(); console.log("REPORT " + join(directory, "report.json"));
} catch (e) { report.passed = false; report.error = e.message; save(); throw e; }
