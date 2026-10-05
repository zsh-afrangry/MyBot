/**
 * T2 retrieval acceptance: Tavily search + extract against the live provider.
 *
 * Boundary: talks to the real Tavily API through the installed plugin's own
 * client, using the production credential. No model, no Host, no QQ, no
 * production database. Verifies that a claim can be checked against source
 * text rather than trusting a provider-synthesized answer.
 */
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import assert from "node:assert/strict";

const root = resolve(process.env.KURUMI_SOURCE_ROOT || (()=>{throw new Error('This acceptance harness reads a legacy tree. Set KURUMI_SOURCE_ROOT to an extracted legacy source (see kurumi-backups); it no longer defaults to /home/afrangry/.openclaw')})());
const env = { ...parseEnv(readFileSync(join(root, "gateway.systemd.env"), "utf8")), ...process.env };
if (!env.TAVILY_API_KEY) throw Error("TAVILY_API_KEY unavailable in gateway.systemd.env");
// The plugin resolves credentials from process.env or plugins.entries.tavily.config.
process.env.TAVILY_API_KEY = env.TAVILY_API_KEY;
const CFG = { plugins: { entries: { tavily: { config: {} } } } };

const plugin = resolve(
  process.env.KURUMI_TAVILY_PLUGIN ||
  join(root, "npm/projects/openclaw-tavily-plugin-8ad843922d/node_modules/@openclaw/tavily-plugin/dist/tavily-client-Bfvn5wPe.js"),
);
const { n: runTavilySearch, t: runTavilyExtract } = await import(pathToFileURL(plugin).href);

const directory = mkdtempSync(join(tmpdir(), "kurumi-retrieval-t2-"));
const report = {
  stage: "retrieval-t2",
  directory,
  boundary:
    "Real Tavily API via the installed plugin client with the production credential. No model, no Host, no QQ delivery, no production database write.",
  tests: [],
};

const QUERY = "SQLite latest stable release version and release date";
const OFFICIAL = "https://sqlite.org/changes.html";

async function check(name, run) {
  const started = Date.now();
  try {
    const value = await run();
    report.tests.push({ name, passed: true, tookMs: Date.now() - started, value });
    console.log(JSON.stringify({ name, passed: true, tookMs: Date.now() - started }));
  } catch (error) {
    report.tests.push({ name, passed: false, tookMs: Date.now() - started, error: error.message });
    console.log(JSON.stringify({ name, passed: false, error: error.message }));
    throw error;
  } finally {
    writeFileSync(join(directory, "t2-report.json"), JSON.stringify(report, null, 2));
  }
}

// T2.1 — search returns structured, citable sources.
await check("T2.1 tavily search returns citable sources", async () => {
  const search = await runTavilySearch({ cfg: CFG, query: QUERY, maxResults: 5 });
  assert.equal(search.provider, "tavily");
  assert.ok(search.results.length >= 1, "expected at least one result");
  for (const r of search.results) assert.ok(/^https?:\/\//u.test(r.url), `non-URL result: ${r.url}`);
  // Result ranking varies between calls; assert usable sources, not one lucky domain.
  const official = search.results.filter(r => r.url.includes("sqlite.org"));
  assert.ok(search.results.every(r => r.title.length > 0), "every result needs a title");
  assert.equal(search.externalContent?.untrusted, true, "search payload must be marked untrusted");
  return { count: search.count, tookMs: search.tookMs, urls: search.results.map(r => r.url), officialUrls: official.map(r => r.url), hadOfficialDomain: official.length > 0 };
});

// T2.2 — extract returns source text, so a claim can be checked directly.
let extracted;
await check("T2.2 tavily extract returns readable source text", async () => {
  const result = await runTavilyExtract({
    cfg: CFG,
    urls: [OFFICIAL],
    // No query: passing one makes Tavily rerank and return fragments instead of the page.
    extractDepth: "advanced",
  });
  assert.equal(result.provider, "tavily");
  assert.ok(result.results.length >= 1, "expected extraction content");
  const first = result.results[0];
  extracted = first.rawContent || first.content || "";
  assert.ok(extracted.length > 100_000, `Tavily returned a fragment, not the page: ${extracted.length} chars`);
  return { url: first.url, chars: extracted.length, tookMs: result.tookMs, failed: result.failedResults?.length ?? 0 };
});

// T2.3 — the extracted text can actually settle the version claim.
// The page lists releases newest-first, so the first dated heading is the latest one.
await check("T2.3 extracted text settles the version claim", async () => {
  const heading = extracted.match(/^#{1,4} (20\d{2}-\d{2}-\d{2}) \((3\.\d{1,2}\.\d{1,2})\)/mu);
  assert.ok(heading, "no dated release heading found; content is not the release history page");
  const [, date, version] = heading;
  const dates = [...extracted.matchAll(/20\d{2}-\d{2}-\d{2}/gu)].map(m => m[0]);
  const newestDate = dates.sort().at(-1);
  assert.equal(date, newestDate, `first heading ${date} is not the newest date ${newestDate}`);
  return { version, date, chars: extracted.length, distinctDates: new Set(dates).size };
});

report.finishedAt = new Date().toISOString();
writeFileSync(join(directory, "t2-report.json"), JSON.stringify(report, null, 2));
console.log("REPORT " + join(directory, "t2-report.json"));
