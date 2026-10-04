import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

/** Stage-one migration only. Does not write config or resolve credentials. */
export function retrievalConfig(source) {
  const cfg = structuredClone(source);
  cfg.tools.web.search = { ...cfg.tools.web.search, enabled: true, provider: "tavily" };
  // Stage two (2026-10-01): mirror the production output budget that C validated.
  cfg.tools.web.fetch = { ...cfg.tools.web.fetch, enabled: true, maxChars: 15000, maxCharsCap: 15000, useTrustedEnvProxy: true };
  cfg.tools.alsoAllow = [...new Set([...(cfg.tools.alsoAllow ?? []), "web_search", "web_fetch"])];
  // A3（2026-10-01）：personal-search 源码已删除，此处的兼容分支一并移除。
  delete cfg.plugins.entries.qwen;
  delete cfg.models.providers["bailian-token-plan"];
  cfg.plugins.entries.tavily = { ...cfg.plugins.entries.tavily, enabled: true,
    config: { ...cfg.plugins.entries.tavily?.config, webSearch: {
      ...cfg.plugins.entries.tavily?.config?.webSearch,
      apiKey: { source: "env", provider: "default", id: "TAVILY_API_KEY" },
    } } };
  cfg.agents.defaults.model.fallbacks = cfg.agents.defaults.model.fallbacks.filter(x => x !== cfg.agents.defaults.model.primary);
  for (const group of Object.values(cfg.channels.qqbot.groups ?? {})) {
    group.toolPolicy = "none";
    delete group.tools;
  }
  // A3：旧 personal_web_search 提示词锚点已随源码删除；只保留"现行提示词必须含新旧检索工具"的守卫。
  if (!/web_search/.test(cfg.channels.qqbot.systemPrompt) || !/web_fetch/.test(cfg.channels.qqbot.systemPrompt)) throw Error("Search prompt changed; review migration before applying");
  return cfg;
}

/** Isolated state has no production install index. Resolve current packages by manifest. */
export function installRetrievalPlugins(cfg, root) {
  const packages = [["tavily", "@openclaw/tavily-plugin"],
    ["openclaw-qqbot", "@tencent-connect/openclaw-qqbot"]];
  cfg.plugins.allow = ["tavily", "openclaw-qqbot", "personal-weather", "personal-confirmation"];
  cfg.plugins.entries = Object.fromEntries(Object.entries(cfg.plugins.entries).filter(([id]) => cfg.plugins.allow.includes(id)));
  const paths = [...(cfg.plugins.load.paths ?? [])];
  for (const [id, pkg] of packages) {
    const matches = readdirSync(join(root, "npm/projects")).map(project => join(root, "npm/projects", project, "node_modules", pkg))
      .filter(path => existsSync(join(path, "openclaw.plugin.json")))
      .filter(path => JSON.parse(readFileSync(join(path, "openclaw.plugin.json"), "utf8")).id === id);
    if (matches.length !== 1) throw new Error(`Expected one installed ${pkg}, found ${matches.length}; select the active installation explicitly`);
    cfg.plugins.entries[id] = { ...cfg.plugins.entries[id], enabled: true };
    paths.push(matches[0]);
  }
  cfg.plugins.load.paths = [...new Set(paths)];
}
