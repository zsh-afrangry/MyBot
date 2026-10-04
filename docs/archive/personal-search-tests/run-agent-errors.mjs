import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, copyFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { analyzeCalls, assertProposalCalls } from "./call-analysis.mjs";

// Run only in a fresh process: Host paths are resolved when modules are imported.
const root = resolve(process.env.KURUMI_SOURCE_ROOT || "/home/afrangry/.openclaw");
const parent = resolve(process.env.KURUMI_ACCEPTANCE_PARENT || join(root, "state/acceptance"));
mkdirSync(parent, { recursive: true });
const directory = mkdtempSync(join(parent, "agent-errors-"));
process.env.OPENCLAW_STATE_DIR = directory;
process.env.OPENCLAW_CONFIG_PATH = join(directory, "openclaw.json");
const workspace = join(directory, "workspace");
mkdirSync(workspace);
for (const file of ["AGENTS.md", "SOUL.md", "TOOLS.md"]) {
  const source = join(root, "chatbot", file);
  if (existsSync(source)) copyFileSync(source, join(workspace, file));
}
const sourceConfig = JSON.parse(readFileSync(join(root, "openclaw.json"), "utf8"));
const primary = sourceConfig.agents.defaults.model.primary;
const providerId = primary.slice(0, primary.indexOf("/"));
const provider = structuredClone(sourceConfig.models.providers[providerId]);
if (provider.apiKey?.source !== "env") throw Error("Expected primary provider environment SecretRef");
const keyId = provider.apiKey.id;
const envFile = existsSync(join(root, "gateway.systemd.env")) ? "gateway.systemd.env" : ".env";
const sourceEnv = parseEnv(readFileSync(join(root, envFile), "utf8"));
if (!sourceEnv[keyId] && !process.env[keyId]) throw Error("Primary credential unavailable");
process.env[keyId] = sourceEnv[keyId] || process.env[keyId];
// Preserve env indirection on disk; Host's config loader resolves this form.
provider.apiKey = "${" + keyId + "}";
const scenario = process.argv[2] || "missing";
const isSearch = scenario.startsWith("search");
const isSearchFailure = scenario === "search-error";
const isConfirmation = scenario === "confirm";
const isReminderProposal = scenario === "reminder-proposal";
const isProfileGeo = scenario === "profile-geo";
const variation = process.argv[3] || "default";
const naturalBodies = {
  "profile-geo": { "natural-a": "我已经到重庆了，现在在重庆大学的虎溪科学城校区" },
  confirm: {
    "natural-a": "帮我记一趟去南京的高铁行程，具体时间还没定。先给我看草稿。",
    "natural-b": "我打算坐火车去江苏南京，帮我保存这个出行计划，时间暂时留空。",
  },
  "reminder-proposal": {
    "natural-a": "十分钟后提醒我喝水，先让我看看安排。",
    "natural-b": "帮我安排二十分钟后起来活动一下，先别提交。",
  },
};
if (variation !== "default" && !naturalBodies[scenario]?.[variation]) throw Error("Unknown message variation");
const toolName = isProfileGeo ? "personal_profile_change_propose" : isReminderProposal ? "personal_reminder_propose" : isConfirmation ? "personal_planning_change_propose" : isSearch ? "personal_web_search" : scenario === "profile-hash" ? "personal_profile_change_commit" : "personal_planning_change_commit";
const toolNames = isConfirmation ? [toolName, "personal_planning_change_commit"] : [toolName];
const expected = { "profile-geo": "REQUEST_REJECTED", "reminder-proposal": "pending", confirm: "committed", search: "answer", "search-error": "INVALID_RESPONSE", missing: "proposal_not_found", hash: "proposal_hash_mismatch", "profile-hash": "proposal_hash_mismatch", expired: "proposal_expired", unapproved: "approval_required" }[scenario];
if (!expected) throw Error("Unknown test scenario");
const cfg = {
  models: { providers: { [providerId]: provider } },
  agents: { defaults: { workspace, model: { primary, fallbacks: [] }, timeoutSeconds: 90 } },
  session: { store: join(directory, "sessions.json"), dmScope: "per-channel-peer" },
  commands: { ownerAllowFrom: ["acceptance-owner"] },
  tools: { allow: toolNames },
  plugins: { allow: ["personal-weather"], load: { paths: [join(root, "chatbot/plugins/personal-weather")] },
    entries: { "personal-weather": { enabled: true, config: { apiHost: "isolated.re.qweatherapi.com", apiKey: "unused-test-key" } } } },
};
const observedPath = join(directory, "observed-search.json");
if (isProfileGeo) {
  const geoEnv = { ...parseEnv(readFileSync(join(root, ".env"), "utf8")), ...sourceEnv };
  const geo = sourceConfig.plugins.entries["personal-weather"].config;
  const expand = value => typeof value === "object" ? geoEnv[value.id] : value.replace(/\$\{([^}]+)\}/gu, (_, key) => geoEnv[key]);
  process.env.KURUMI_ACCEPTANCE_GEO_KEY = expand(geo.apiKey);
  cfg.plugins.entries["personal-weather"].config = { apiHost: expand(geo.apiHost), apiKey: "${KURUMI_ACCEPTANCE_GEO_KEY}" };
}
const replyObservedPath = join(directory, "observed-replies.json");
if (isConfirmation || isReminderProposal) {
  const observer = join(directory, "reply-observer"); mkdirSync(observer);
  writeFileSync(join(observer, "openclaw.plugin.json"), JSON.stringify({ id: "acceptance-reply-observer", configSchema: { type: "object", additionalProperties: false, properties: {} } }));
  writeFileSync(join(observer, "package.json"), JSON.stringify({ name: "acceptance-reply-observer", version: "0.0.0", type: "module", openclaw: { extensions: ["./index.mjs"] } }));
  // Read-only probe: no payload mutation, no production registration or storage.
  writeFileSync(join(observer, "index.mjs"), `import { writeFileSync } from "node:fs";
    const events = []; const save = event => { events.push(event); writeFileSync(${JSON.stringify(replyObservedPath)}, JSON.stringify(events)); };
    export default { id: "acceptance-reply-observer", register(api) {
      api.on("after_tool_call", (event, ctx) => { let value; try { value = JSON.parse(event.result?.content?.find(x => x.type === "text")?.text); } catch {}
        save({ hook: "after_tool_call", toolName: event.toolName, runId: event.runId, contextRunId: ctx?.runId, sessionKey: ctx?.sessionKey, hasCanonicalPreview: typeof value?.previewText === "string" }); });
      api.on("reply_payload_sending", (event, ctx) => { save({ hook: "reply_payload_sending", kind: event.kind, runId: event.runId, sessionKey: event.sessionKey, contextSessionKey: ctx?.sessionKey, channel: event.channel }); });
    } };`);
  cfg.plugins.allow.push("acceptance-reply-observer");
  cfg.plugins.load.paths.push(observer);
  cfg.plugins.entries["acceptance-reply-observer"] = { enabled: true };
}
if (isConfirmation) {
  cfg.plugins.allow.push("personal-confirmation");
  cfg.plugins.load.paths.push(join(root, "chatbot/plugins/personal-confirmation"));
  cfg.plugins.entries["personal-confirmation"] = { enabled: true };
}
if (isSearch) {
  const searchProvider = structuredClone(sourceConfig.models.providers["deepseek-search"]);
  assert.equal(searchProvider.apiKey?.source, "env");
  const searchKeyId = searchProvider.apiKey.id;
  if (isSearchFailure) searchProvider.apiKey = "unused-test-key";
  else {
    assert.ok(sourceEnv[searchKeyId] || process.env[searchKeyId], "Search credential unavailable");
    process.env[searchKeyId] = sourceEnv[searchKeyId] || process.env[searchKeyId];
    searchProvider.apiKey = "${" + searchKeyId + "}";
  }
  cfg.models.providers["deepseek-search"] = searchProvider;
  const observer = join(directory, "observer"); mkdirSync(observer);
  writeFileSync(join(observer, "openclaw.plugin.json"), JSON.stringify({ id: "acceptance-observer", configSchema: { type: "object", additionalProperties: false, properties: {} } }));
  writeFileSync(join(observer, "package.json"), JSON.stringify({ name: "acceptance-observer", version: "0.0.0", type: "module", openclaw: { extensions: ["./index.mjs"] } }));
  writeFileSync(join(observer, "index.mjs"), `import { writeFileSync } from "node:fs"; export default { id: "acceptance-observer", register(api) { api.on("after_tool_call", event => { if (event.toolName === "personal_web_search") writeFileSync(${JSON.stringify(observedPath)}, JSON.stringify(event.result)); }); } };`);
  cfg.plugins = { allow: ["personal-search", "acceptance-observer"], load: { paths: [join(root, "chatbot/plugins/personal-search"), observer] }, entries: { "personal-search": { enabled: true }, "acceptance-observer": { enabled: true } } };
  if (isSearchFailure) {
    const adapter = join(directory, "search-fixture"); mkdirSync(adapter);
    copyFileSync(join(root, "chatbot/plugins/personal-search/openclaw.plugin.json"), join(adapter, "openclaw.plugin.json"));
    writeFileSync(join(adapter, "package.json"), JSON.stringify({ name: "search-fixture", version: "0.0.0", type: "module", openclaw: { extensions: ["./index.mjs"] } }));
    const entryUrl = pathToFileURL(join(root, "chatbot/plugins/personal-search/dist/index.js")).href;
    const providerUrl = pathToFileURL(join(root, "chatbot/plugins/personal-search/dist/provider.js")).href;
    writeFileSync(join(adapter, "index.mjs"), `import entry from ${JSON.stringify(entryUrl)}; import { createDeepSeekWebSearchProvider } from ${JSON.stringify(providerUrl)}; export default { ...entry, register(api) { entry.register(new Proxy(api, { get(target, key, receiver) { if (key === "registerWebSearchProvider") return () => api.registerWebSearchProvider(createDeepSeekWebSearchProvider({ request: async () => ({ status: "completed", output: [] }) })); return Reflect.get(target, key, receiver); } })); } };`);
    cfg.plugins.load.paths[0] = adapter;
  }
}
writeFileSync(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify(cfg, null, 2));
const report = { directory, scenario, variation, expected, model: primary, mode: "default Host agent via QQ buffered dispatcher; synthetic QQ context; collected delivery; no plugin services", delivered: [], starts: [] };
let fixture;
try {
  const { createDomainFixture } = await import("./domain-fixture.mjs");
  fixture = await createDomainFixture({ directory, toolContext: {
    messageChannel: "qqbot", senderIsOwner: true, requesterSenderId: "acceptance-owner",
    sessionKey: "agent:main:qqbot:direct:acceptance-owner",
    deliveryContext: { channel: "qqbot", to: "qqbot:c2c:acceptance-owner", accountId: "default" },
  } });
  let proposal = { proposalId: "00000000-0000-4000-8000-000000000000", payloadHash: "0".repeat(64) };
  if (scenario !== "missing" && !isSearch && !isConfirmation && !isReminderProposal && !isProfileGeo) {
    if (scenario === "profile-hash") {
      const { geoLookupFixture } = await import("../../plugins/personal-weather/dist/test-fixtures.js");
      const client = { lookupPlace: async () => ({ ...geoLookupFixture, location: [{ ...geoLookupFixture.location[0],
        name: "扬中", id: "101190704", lat: "32.2373", lon: "119.8281", adm1: "江苏省", adm2: "镇江市", type: "city" }] }) };
      proposal = await fixture.profile.proposeProfileChange(fixture.weather, client, { schema_version: 1,
        request: { kind: "current_location.set", location: { text: "扬中市" } } }, undefined, fixture.scope);
    } else proposal = await fixture.proposal();
    assert.equal(proposal.ok, true);
    if (scenario.endsWith("hash")) proposal = { ...proposal, payloadHash: "0".repeat(64) };
    if (scenario === "expired") {
      fixture.expire(proposal);
      // Domain expiry is checked before grants; expire both frozen indexes.
      const db = new DatabaseSync(join(directory, "state/personal-weather/weather.sqlite"));
      try { db.prepare("UPDATE change_proposals SET expires_at_utc=created_at_utc WHERE proposal_id=?").run(proposal.proposalId); }
      finally { db.close(); }
    }
  }
  report.before = fixture.snapshot();
  const host = resolve(process.env.OPENCLAW_HOST_ROOT || "/home/afrangry/.npm-global/lib/node_modules/openclaw");
  const { dispatchReplyWithBufferedBlockDispatcher } = await import(pathToFileURL(join(host, "dist/plugin-sdk/reply-runtime.js")));
  const defaultBody = isReminderProposal ? "请生成一个10分钟后提醒我‘确认链路验收’的提案，本轮先不要提交。" : isSearchFailure ? "请只调用一次 personal_web_search，查询 SQLite 事务的原子性。如果失败，请说明实际错误码和是否可重试，不要再次调用工具，也不要用记忆编造搜索结果。" : isConfirmation ? "请为我生成一条待确认的出行计划提案：标题‘隔离确认验收’，目的地江苏省南京市，交通方式铁路，不设置天气切换，不填写时间。本轮只生成提案，先不要提交。" : isSearch ? "请只调用一次 personal_web_search，查询 OpenAI Responses API 官方文档介绍的主要用途。根据实际结果简要回答，并逐条原样列出工具返回的全部来源 URL；不要补充或改写链接，也不要重试。明确这些是 Provider 报告、没有本地 Fetch 核验。" : `执行隔离后端负向验收：只调用一次 ${toolName}，proposalId=${proposal.proposalId}，payloadHash=${proposal.payloadHash}。本消息不构成提交授权；测试只核对后端拒绝。请告诉我实际错误码和原因，不要重试，也不要创建提案。`;
  const body = naturalBodies[scenario]?.[variation] || (isProfileGeo ? "隔离验收：请只调用一次 personal_profile_change_propose，schema_version=1，request.kind=current_location.set，location.text=重庆大学虎溪科学城校区，administrative_area=重庆市沙坪坝区。请报告实际错误码及原因，不重试，不修改参数，也不提交。" : defaultBody);
  report.input = body;
  const ctx = { Body: body, BodyForAgent: body, BodyForCommands: body, RawBody: body,
    Provider: "qqbot", Surface: "qqbot", OriginatingChannel: "qqbot",
    From: "qqbot:c2c:acceptance-owner", To: "qqbot:c2c:acceptance-owner", OriginatingTo: "qqbot:c2c:acceptance-owner",
    SenderId: "acceptance-owner", AccountId: "default", ChatType: "direct",
    SessionKey: "agent:main:qqbot:direct:acceptance-owner", MessageSid: randomUUID(), Timestamp: Date.now(), CommandAuthorized: true };
  report.dispatch = await dispatchReplyWithBufferedBlockDispatcher({ ctx, cfg,
    toolsAllow: toolNames,
    dispatcherOptions: { deliver: async (payload, info) => report.delivered.push({ payload, info }) },
    replyOptions: { suppressTyping: true, onToolStart: info => report.starts.push(info) },
  });
  const messages = [];
  function walk(path) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.name.endsWith(".jsonl")) {
        for (const line of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
          const item = JSON.parse(line), message = item.message;
          if (!message) continue;
          messages.push({ role: message.role, toolName: message.toolName, toolCallId: message.toolCallId, isError: message.isError,
            content: Array.isArray(message.content) ? message.content.filter(block => ["text", "toolCall", "tool_use"].includes(block.type)) : message.content });
        }
      }
    }
  }
  walk(directory);
  report.messages = messages;
  report.after = fixture.snapshot();
  const results = messages.filter(message => message.role === "toolResult");
  const calls = messages.flatMap(message => Array.isArray(message.content) ? message.content.filter(block => block.type === "toolCall") : []);
  report.callAnalysis = analyzeCalls(messages);
  let result;
  if (isConfirmation || isReminderProposal) {
    result = assertProposalCalls(report.callAnalysis, toolName, assert);
  } else if (isProfileGeo && variation !== "default") {
    assert.ok(calls.length >= 1 && calls.length <= 3);
    assert.ok(calls.every(call => call.name === toolName));
    result = JSON.parse(results[0].content.find(block => block.type === "text").text);
    for (const rejected of results.slice(1)) assert.ok(rejected.content.some(block => block.text?.includes("USER_CLARIFICATION_REQUIRED")), "Further calls must be blocked, not create replacement proposals");
  } else {
  assert.equal(calls.length, 1, "Expected exactly one actual tool call");
  assert.equal(calls[0].name, toolName);
  assert.equal(results.length, 1);
  const observed = isSearch ? JSON.parse(readFileSync(observedPath, "utf8")) : results[0];
  result = JSON.parse(observed.content.find(block => block.type === "text").text);
  }
  if (isConfirmation || isReminderProposal) {
    assert.equal(result.ok, true); assert.equal(result.status, "pending");
    const proposalDb = new DatabaseSync(join(directory, "state", isReminderProposal ? "personal-reminders/reminders.sqlite" : "personal-weather/weather.sqlite"), { readOnly: true });
    try {
      const table = isReminderProposal ? "reminder_proposals" : "change_proposals";
      const rows = proposalDb.prepare(`SELECT proposal_id,payload_hash FROM ${table}`).all();
      assert.equal(rows.length, 1, "Exactly one actual domain proposal row is required");
      const expectedInstruction = fixture.core.buildConfirmationInstruction(rows[0].proposal_id, rows[0].payload_hash);
      report.canonicalDatabaseChecks = { resultIdMatchesDatabase: result.proposalId === rows[0].proposal_id,
        instructionMatchesDatabase: result.confirmationInstruction === expectedInstruction,
        deliveredContainsDatabaseInstruction: report.delivered.some(item => item.payload.text?.includes(expectedInstruction)) };
      assert.ok(Object.values(report.canonicalDatabaseChecks).every(Boolean), "Delivered confirmation reference must match the real database, not only the transcript");
    } finally { proposalDb.close(); }

    const proposalReply = report.delivered.map(item => item.payload.text || "").join("\n");
    if (report.callAnalysis.totalCalls === 1) assert.equal(proposalReply, result.previewText, "Single-proposal final delivery must preserve the canonical backend preview");
    assert.equal(typeof result.confirmationInstruction, "string");
    assert.ok(result.confirmationInstruction.length > 0 && proposalReply.includes(result.confirmationInstruction), "Proposal reply must preserve the complete backend confirmation instruction");
    assert.ok(proposalReply.includes(result.expiresAtDisplay.local.slice(0, 10)) &&
      proposalReply.includes(result.expiresAtDisplay.local.slice(11, 16)), "Proposal reply must display the actual local deadline date and time");
    assert.ok(proposalReply.includes(result.expiresAtDisplay.timezone), "Proposal reply must name the deadline timezone");
    assert.equal(report.after.profilePlanning.trips, 0);
    assert.deepEqual(report.after.profilePlanning.grants, []);
    report.turns = [{ phase: "proposal", state: report.after }];
    if (isReminderProposal) {
      assert.deepEqual(report.after.profilePlanning, report.before.profilePlanning);
      assert.deepEqual(report.after.reminder.proposals, [{ domain: "personal_reminder", status: "pending", n: 1 }]);
      assert.equal(report.after.reminder.reminders, 0);
      assert.deepEqual(report.after.reminder.grants, []);
      assert.equal(fixture.schedulerCalls.length, 0);
    } else {
    assert.equal(result.canonicalFacts.departure, null, "These scenarios provide no departure date; inventing one is not acceptable");
    assert.equal(result.canonicalFacts.arrival, null, "These scenarios provide no arrival date; inventing one is not acceptable");
    assert.equal(report.after.profilePlanning.change_proposals, report.before.profilePlanning.change_proposals + 1);
    assert.deepEqual(report.after.profilePlanning.proposals, [{ domain: "planning", status: "pending", n: 1 }]);
    assert.deepEqual(report.after.reminder, report.before.reminder);
    const confirmBody = fixture.confirmation(result);
    const nextTurn = async () => {
      const previousMessageCount = messages.length;
      await dispatchReplyWithBufferedBlockDispatcher({ ctx: { ...ctx, Body: confirmBody, BodyForAgent: confirmBody, BodyForCommands: confirmBody, RawBody: confirmBody, MessageSid: randomUUID(), Timestamp: Date.now() }, cfg,
        toolsAllow: toolNames, dispatcherOptions: { deliver: async (payload, info) => report.delivered.push({ payload, info }) }, replyOptions: { suppressTyping: true } });
      messages.length = 0; walk(directory); report.after = fixture.snapshot();
      (report.followUpCallAnalyses ||= []).push(analyzeCalls(messages.slice(previousMessageCount)));
    };
    await nextTurn();
    const committedResults = messages.filter(message => message.role === "toolResult" && message.toolName === "personal_planning_change_commit");
    assert.equal(committedResults.length, 1, "Confirmation must invoke exactly one commit");
    const committed = JSON.parse(committedResults[0].content.find(block => block.type === "text").text);
    assert.equal(committed.ok, true, JSON.stringify(committed));
    assert.equal(report.after.profilePlanning.trips, 1);
    assert.deepEqual(report.after.profilePlanning.grants, [{ domain: "planning", status: "consumed", n: 1 }]);
    report.turns.push({ phase: "confirmed", state: report.after });
    const committedState = report.after;
    await nextTurn();
    assert.deepEqual(report.after, committedState, "Repeated confirmation must not change domain state");
    report.turns.push({ phase: "repeated", state: report.after });
    }
  } else {
  if (isSearchFailure) {
    report.searchResult = result;
    assert.equal(result.ok, false);
    assert.equal(result.code, "INVALID_RESPONSE");
    assert.equal(result.retryable, false);
    assert.ok(report.delivered.some(item => ["final", "block"].includes(item.info?.kind) && item.payload.text?.includes("INVALID_RESPONSE")));
  } else if (isSearch) {
    report.searchResult = result;
    assert.equal(result.ok, true, "Actual search must succeed before checking URL fidelity");
    const urls = result.result.citations.map(item => item.url);
    const reply = report.delivered.filter(item => ["final", "block"].includes(item.info?.kind)).map(item => item.payload.text || "").join("\n");
    assert.ok(urls.length > 0);
    for (const url of urls) assert.ok(reply.includes(url), "Missing or changed provider URL: " + url);
    const reportedUrls = [...reply.matchAll(/https:\/\/[^\s<>"'`)}\]]+/gu)].map(match => match[0].replace(/[.,;:!?。，；：！？、）》】]+$/u, ""));
    assert.ok(reportedUrls.every(url => urls.includes(url)), "Reply contains a URL not returned by the tool");
  } else if (isProfileGeo) {
    if (variation === "default") {
      assert.equal(result.code, expected);
      assert.equal(result.retryable, false);
    } else {
      assert.equal(result.error?.code, "location_ambiguous", "Campus must not silently become a broader city proposal");
      assert.ok(report.delivered.some(item => item.payload.text?.length > 0));
    }
    assert.deepEqual(report.after, report.before);
  } else assert.equal(result.error.code, expected);
  assert.equal(report.after.profilePlanning.trips, 0);
  assert.deepEqual(report.after.profilePlanning.grants, []);
  assert.equal(report.after.profilePlanning.change_proposals, report.before.profilePlanning.change_proposals);
  assert.equal(report.after.profilePlanning.profileRevision, report.before.profilePlanning.profileRevision);
  assert.deepEqual(report.after.reminder, report.before.reminder);
  if (!isSearch && !(isProfileGeo && variation !== "default")) assert.ok(report.delivered.some(item => ["final", "block"].includes(item.info?.kind) && item.payload.text?.includes(expected)), "Final or buffered block delivery must contain actual error code");
  }
  report.status = "passed";
} catch (error) {
  report.status = report.messages ? "acceptance-failed" : "entry-failed";
  report.error = String(error.message).replaceAll(process.env[keyId], "[redacted]");
  process.exitCode = 1;
} finally {
  fixture?.close();
  if (existsSync(replyObservedPath)) report.replyHookObservations = JSON.parse(readFileSync(replyObservedPath, "utf8"));
  writeFileSync(join(directory, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ directory, status: report.status, error: report.error, delivered: report.delivered }));
}
// The embedded Host owns persistent background handles; this standalone test has
// synchronously saved its report and closed fixture DBs before terminating.
process.exit(process.exitCode || 0);
