/**
 * fallback 真实故障切换验证（隔离运行，绝不触碰生产 provider / key / 投递）
 *
 * 做法：把主模型指向一个必然连接失败的本机地址（127.0.0.1:9，立即 ECONNREFUSED），
 * fallback 保留真实的 deepseek-search/deepseek-v4-flash，然后跑一个不需要工具的
 * 简单问题，断言 fallbackUsed === true 且确实产出了回答。
 *
 * 为什么不用"把生产 key 改坏"的办法：生产 key 是共享的，破坏它会影响 QQ 上的真实使用。
 * 隔离配置写在临时目录，进程结束即丢弃，生产 openclaw.json 全程只读。
 *
 * 用法：node chatbot/tests/acceptance/run-fallback-failover.mjs
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { parseEnv } from "node:util";

const root = resolve(process.env.KURUMI_SOURCE_ROOT || "/home/afrangry/.openclaw");
const host = process.env.OPENCLAW_HOST_ROOT || "/home/afrangry/.npm-global/lib/node_modules/openclaw";

// 只读取需要的凭据，不打印任何值。
const envFile = parseEnv(readFileSync(join(root, "gateway.systemd.env"), "utf8"));
for (const k of ["DEEPSEEK_API_KEY", "OPENAI_API_KEY", "TAVILY_API_KEY"]) {
  const v = envFile[k] ?? process.env[k];
  assert(v, `缺少 ${k}`);
  process.env[k] = v;
}

const directory = mkdtempSync(join(tmpdir(), "kurumi-fallback-"));
const cfg = JSON.parse(readFileSync(join(root, "openclaw.json"), "utf8"));

// 1) 主模型替换为一个必然失败的本机地址；fallback 保留真实 deepseek。
cfg.models.providers = {
  ...cfg.models.providers,
  "fallback-probe-broken": {
    baseUrl: "http://127.0.0.1:9/v1",
    apiKey: "not-a-real-key",
    api: "openai-completions",
    authHeader: true,
    models: [{ id: "unreachable-probe", name: "Unreachable Probe", input: ["text"] }],
  },
};
cfg.agents.defaults.model = {
  primary: "fallback-probe-broken/unreachable-probe",
  fallbacks: ["deepseek-search/deepseek-v4-flash"],
};

// 2) 隔离运行：断开 QQ 渠道、状态写临时目录；插件保持生产加载方式，
//    否则 config validate 会因 "unknown channel id / provider not available" 直接拒绝。
cfg.channels = { ...cfg.channels, qqbot: { ...cfg.channels.qqbot, enabled: false } };
cfg.session = { store: join(directory, "sessions.sqlite"), dmScope: "per-channel-peer" };
cfg.gateway = { mode: "local", port: 19791, bind: "loopback" };

const cfgPath = join(directory, "openclaw.json");
writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), { mode: 0o600 });

const message = "用一句话说明什么是哈希表。";
const run = spawnSync(process.execPath, [
  join(host, "dist/index.js"), "agent",
  "--session-key", "agent:main:fallback-probe",
  "--session-id", "fbprobe01",
  "--message", message,
  "--json",
  "--local",
], {
  encoding: "utf8",
  timeout: 300_000,
  env: {
    ...process.env,
    HOME: process.env.HOME || "/home/afrangry",
    OPENCLAW_STATE_DIR: directory,
    OPENCLAW_CONFIG_PATH: cfgPath,
    OPENCLAW_AGENT_DIR: join(directory, "agents/main/agent"),
  },
});

const raw = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
if (process.env.KURUMI_FALLBACK_DUMP) writeFileSync(process.env.KURUMI_FALLBACK_DUMP, run.stdout ?? "");
let parsed;
try { parsed = JSON.parse(run.stdout); } catch { /* 结构化失败时下面统一报错 */ }

if (!parsed) {
  console.error("无法解析 agent 输出，原始尾部：");
  console.error(raw.slice(-1200));
  process.exit(1);
}

// 2026.9.7 的 --json 结果是 { payloads: [...投递负载], meta: {...运行结果} }：
// 运行结果（含 executionTrace）在 meta 里，回复文本在 meta.finalAssistantVisibleText
// 或 payloads[0].text。旧版是扁平字段；统一兼容。
const list = Array.isArray(parsed.payloads)
  ? parsed.payloads
  : (parsed.payloads && typeof parsed.payloads === "object" ? Object.values(parsed.payloads) : []);
const firstPayload = list[0] ?? {};
const meta = parsed.meta ?? parsed;
const trace = meta.executionTrace ?? parsed.executionTrace ?? {};

const result = {
  winnerProvider: trace.winnerProvider ?? null,
  winnerModel: trace.winnerModel ?? parsed.winnerModel ?? null,
  fallbackUsed: trace.fallbackUsed ?? parsed.fallbackUsed ?? null,
  attempts: (trace.attempts ?? parsed.attempts ?? []).map(a => `${a.provider}/${a.model}:${a.result}`),
  answer: String(meta.finalAssistantVisibleText ?? parsed.finalAssistantVisibleText ?? firstPayload.text ?? "").slice(0, 160),
};

console.log(JSON.stringify(result, null, 2));
if (result.fallbackUsed === null) {
  console.error("\n=== JSON 顶层字段 ===");
  console.error(Object.keys(parsed).join(", "));
  console.error("=== meta 字段 ===");
  console.error(Object.keys(meta).join(", "));
}

assert.equal(result.fallbackUsed, true, "未触发 fallback —— 主模型失败后没有切换");
assert.match(String(result.winnerModel), /deepseek/i, "切换后的模型不是 deepseek");
assert(result.answer.length > 0, "fallback 后没有产出回答");

console.log("\nFALLBACK FAILOVER VERIFIED");
console.log(`隔离目录（可删）：${directory}`);
