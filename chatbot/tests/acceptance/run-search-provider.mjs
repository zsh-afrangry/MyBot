import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import assert from "node:assert/strict";

const root = process.env.KURUMI_SOURCE_ROOT || "/home/afrangry/.openclaw";
const parent = process.env.KURUMI_ACCEPTANCE_PARENT || join(root, "state/acceptance");
mkdirSync(parent, { recursive: true });
const directory = mkdtempSync(join(parent, "search-provider-"));
process.env.OPENCLAW_STATE_DIR = directory;
process.env.OPENCLAW_CONFIG_PATH = join(directory, "openclaw.json");
const original = JSON.parse(readFileSync(join(root, "openclaw.json"), "utf8"));
const provider = structuredClone(original.models.providers["deepseek-search"]);
assert.equal(provider.apiKey?.source, "env");
const keyId = provider.apiKey.id;
const env = parseEnv(readFileSync(join(root, "gateway.systemd.env"), "utf8"));
const apiKey = env[keyId] || process.env[keyId];
assert.ok(apiKey, "Search environment credential unavailable");
provider.apiKey = apiKey; // Memory only; no runtime config with credentials is written.
const config = { models: { providers: { "deepseek-search": provider } } };
const host = process.env.OPENCLAW_HOST_ROOT || "/home/afrangry/.npm-global/lib/node_modules/openclaw";
const { withTrustedWebSearchEndpoint, readResponseText } = await import(pathToFileURL(join(host, "dist/plugin-sdk/provider-web-search.js")));
const { createDeepSeekWebSearchProvider } = await import("../../plugins/personal-search/dist/provider.js");
const report = { directory, query: "SQLite 官方文档如何解释事务的原子性？请给出官方文档来源。", boundary: "Actual configured DeepSeek provider/parser/quota; test transport observer uses same trusted endpoint SDK. Public query only; no Host agent or QQ delivery.", audit: [], requests: [] };
const searchProvider = createDeepSeekWebSearchProvider({
  onAudit: event => report.audit.push(event),
  request: async options => {
    const trace = { endpoint: options.url, model: options.body.model }; report.requests.push(trace);
    return await withTrustedWebSearchEndpoint({ url: options.url, timeoutSeconds: options.timeoutSeconds,
      init: { method: "POST", headers: { Accept: "application/json", Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify(options.body) },
    }, async response => {
      trace.httpStatus = response.status;
      const detail = await readResponseText(response, { maxBytes: options.maxResponseBytes });
      trace.bytes = Buffer.byteLength(detail.text); trace.truncated = detail.truncated;
      if (!response.ok || detail.truncated) throw Error(`Diagnostic transport rejected HTTP ${response.status}; truncated=${detail.truncated}`);
      const payload = JSON.parse(detail.text);
      trace.shape = { status: payload.status, incomplete_details: payload.incomplete_details,
        output: Array.isArray(payload.output) ? payload.output.map(item => ({ type: item.type, status: item.status,
          actionType: item.action?.type, content: item.content?.map(part => ({ type: part.type, textLength: part.text?.length })) })) : null };
      return payload;
    });
  },
});
try {
  report.result = await searchProvider.createTool({ config }).execute({ query: report.query, count: 5 });
  assert.equal(report.result.kind, "answer");
  assert.ok(report.result.citations.length > 0 && report.result.citations.length <= 5);
  assert.equal(report.result.source_verification, "provider_reported");
  assert.equal(report.requests.length, 1);
  report.status = "passed";
} catch (error) {
  report.status = "failed"; report.code = error.code;
  report.error = String(error.message).replaceAll(apiKey, "[redacted]"); process.exitCode = 1;
} finally {
  writeFileSync(join(directory, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ directory, status: report.status, code: report.code, error: report.error, requests: report.requests, citations: report.result?.citations }));
}
process.exit(process.exitCode || 0);
