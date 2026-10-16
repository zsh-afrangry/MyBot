// Adapter-layer tests for kurumi-mail.
//
// The point of these is injectability, and the case that matters most is the confirmation path: the
// host's inbound router must reach whatever store the composition selected, not a store this plugin
// constructed privately. Before the adapter migration the backend called `new MailStore(...)` itself,
// so no test could observe which implementation confirmations actually landed in.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAdapterRegistry } from "../../../packages/domain-adapters/index.js";
import { confirmationBackendIds, recordRegisteredConfirmation } from "@kurumi/confirmation-core";
import { createMailApplication } from "../application.js";
import { createMailRegistry } from "../adapters.js";
import { createMailPlugin } from "../index.js";
import { defaultMailPolicy } from "../policy.js";

const OWNER = "365999865";
const SESSION = `agent:main:kurumi-qq:direct:${OWNER}`;
const ALLOWED = "365999865@qq.com";

/**
 * A deliberately independent store: every method is recorded, and the two confirmation methods
 * answer in a way SQLite never would, so a caller that secretly used the real store cannot pass.
 */
function fakeStore({ closeCounter } = {}) {
  const calls = [];
  const drafts = new Map();
  let sequence = 0;
  const record = (name) => { calls.push(name); };
  return {
    calls,
    closed: closeCounter,
    nowUtc: () => 1_800_000_000,
    close() { record("close"); if (closeCounter) closeCounter.count += 1; },
    createDraft(input, scope) {
      record("createDraft");
      assert.ok(scope?.primary, "the scope must be forwarded to the store");
      const draftId = `1111111${sequence}-2222-3333-4444-55555555555${sequence}`;
      sequence += 1;
      drafts.set(draftId, { draftId, to: input.to, cc: input.cc ?? [], subject: input.subject, text: input.text, status: "pending" });
      return { draftId, payloadHash: "a".repeat(64), instruction: `确认 ${String(sequence).padStart(12, "0")}`, expiresAtUtc: 1_800_086_400 };
    },
    getDraft(draftId) { record("getDraft"); return drafts.get(draftId); },
    listDrafts() { record("listDrafts"); return [...drafts.values()]; },
    listAudit() { record("listAudit"); return [{ atUtc: 1, action: "fake", detail: {} }]; },
    consumeApproval() { record("consumeApproval"); return { ok: true, grantId: "fake-grant" }; },
    markSent() { record("markSent"); },
    markFailed() { record("markFailed"); },
    cancelDraft() { record("cancelDraft"); return true; },
    listInboundConfirmationCandidates() {
      record("listInboundConfirmationCandidates");
      // Answer with a proposal only this fake produces.
      return [{ proposalId: "99999999-8888-4777-8666-555555555555", domain: "mail", payloadHash: "b".repeat(64) }];
    },
    recordInboundConfirmation() { record("recordInboundConfirmation"); return true; },
  };
}

// Registered under the SHIPPED ids by default: replacing an implementation must not require editing
// the plugin, so the plugin keeps resolving "default"/"sqlite" and gets whatever was registered.
function registryWith(store, policy = defaultMailPolicy, { policyId = "default", storeId = "sqlite" } = {}) {
  const registry = createAdapterRegistry({
    domain: "mail-test",
    policyMethods: ["normalizeDraft", "normalizeSend", "normalizeOutbox", "assertRecipientsAllowed"],
    storeMethods: ["nowUtc", "close", "createDraft", "getDraft", "listDrafts", "listAudit", "consumeApproval",
      "markSent", "markFailed", "cancelDraft", "listInboundConfirmationCandidates", "recordInboundConfirmation"],
  });
  registry.registerPolicy(policyId, policy);
  registry.registerStore(storeId, () => store);
  return registry;
}

function harness({ store = fakeStore(), policy = defaultMailPolicy, pluginConfig = { allowedRecipients: [ALLOWED] } } = {}) {
  const registry = registryWith(store, policy);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kurumi-mail-adapters-"));
  process.env.OPENCLAW_STATE_DIR = dir;
  const tools = new Map();
  const unregisters = [];
  const api = {
    config: { channels: { "kurumi-qq": { ownerId: OWNER } } },
    pluginConfig,
    logger: { info() {}, warn() {}, error() {} },
    registerService(service) { const stop = service.start?.(); if (typeof stop === "function") unregisters.push(stop); return () => {}; },
    registerTool(definition) { const tool = definition.create(ownerContext()); tools.set(tool.name, tool); return () => {}; },
  };
  createMailPlugin({ registry }).register(api);
  return {
    store, tools, registry,
    cleanup() { for (const unregister of unregisters) unregister(); fs.rmSync(dir, { recursive: true, force: true }); },
    run: async (name, args) => JSON.parse((await tools.get(name).execute("call", args, undefined)).content[0].text),
  };
}

function ownerContext(overrides = {}) {
  return {
    messageChannel: "kurumi-qq",
    deliveryContext: { channel: "kurumi-qq", to: `user:${OWNER}`, accountId: "default" },
    requesterSenderId: OWNER,
    senderIsOwner: true,
    sessionKey: SESSION,
    getRuntimeConfig: () => ({ channels: { "kurumi-qq": { ownerId: OWNER } } }),
    assertInvocationCurrent() {},
    ...overrides,
  };
}

test("the host's inbound router reaches the SELECTED store, not a privately built one", (t) => {
  const closeCounter = { count: 0 };
  const store = fakeStore({ closeCounter });
  const harnessed = harness({ store });
  t.after(() => harnessed.cleanup());
  assert.ok(confirmationBackendIds().includes("kurumi-mail"), "the service must register the backend");

  const outcomes = [];
  const outcome = recordRegisteredConfirmation({
    channel: "kurumi-qq", accountId: "default", conversationId: `user:${OWNER}`, senderId: OWNER,
    sessionKey: SESSION, messageId: "adapter-1", content: "确认 000000000000", isGroup: false, senderIsOwner: true,
  }, (diagnostic) => outcomes.push(diagnostic));

  assert.equal(outcome, "recorded", JSON.stringify(outcomes));
  assert.deepEqual(outcomes[0].backend, "kurumi-mail");
  // Both confirmation methods ran on the injected store, and the router closed it afterwards.
  assert.ok(store.calls.includes("listInboundConfirmationCandidates"));
  assert.ok(store.calls.includes("recordInboundConfirmation"));
  assert.ok(store.calls.includes("close"));
  assert.equal(closeCounter.count, 1);
});

test("the tools operate on the selected store too", async (t) => {
  const store = fakeStore();
  const harnessed = harness({ store });
  t.after(() => harnessed.cleanup());

  const draft = await harnessed.run("email_draft", { to: ALLOWED, subject: "s", text: "t" });
  assert.equal(draft.ok, true, JSON.stringify(draft));
  assert.ok(store.calls.includes("createDraft"), "the tool must create the draft through the selected store");

  const outbox = await harnessed.run("email_outbox", {});
  assert.equal(outbox.ok, true);
  assert.ok(store.calls.includes("listDrafts"));
  assert.deepEqual(outbox.drafts.map((entry) => entry.draftId), [draft.draftId]);

  const status = await harnessed.run("email_status", {});
  assert.equal(status.policyAdapter, "default");
  assert.equal(status.storeAdapter, "sqlite");
});

test("a replacement policy changes admission but cannot mint owner identity", async (t) => {
  // A policy that admits nothing: the tool must report its refusal, not silently fall back.
  const refusing = Object.freeze({
    ...defaultMailPolicy,
    normalizeDraft: () => ({ problem: "refused by replacement policy" }),
  });
  const harnessed = harness({ policy: refusing });
  t.after(() => harnessed.cleanup());

  const result = await harnessed.run("email_draft", { to: ALLOWED, subject: "s", text: "t" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "invalid_draft");
  assert.equal(result.reason, "refused by replacement policy");
  assert.equal(harnessed.store.calls.includes("createDraft"), false, "a refused draft must never reach the store");

  // Identity is established in inbound.js, before any policy runs, so a permissive policy cannot
  // turn a non-owner context into an owner one.
  const tools = new Map();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kurumi-mail-adapters-nonowner-"));
  process.env.OPENCLAW_STATE_DIR = dir;
  const permissive = Object.freeze({ ...defaultMailPolicy, normalizeDraft: (args) => ({ to: args.to, cc: [], subject: "s", text: "t" }) });
  createMailPlugin({ registry: registryWith(fakeStore(), permissive) }).register({
    config: { channels: { "kurumi-qq": { ownerId: OWNER } } },
    pluginConfig: { allowedRecipients: [ALLOWED] },
    registerService() { return () => {}; },
    registerTool(definition) { const tool = definition.create(ownerContext({ senderIsOwner: false })); tools.set(tool.name, tool); return () => {}; },
  });
  await assert.rejects(() => tools.get("email_draft").execute("call", { to: ALLOWED, subject: "s", text: "t" }, undefined), /owner's private chat only/u);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an unknown adapter id fails loudly instead of falling back", () => {
  // The registry refuses to guess: an unresolvable selection throws rather than quietly using SQLite.
  assert.throws(() => createMailApplication({ storeAdapter: "does-not-exist" }), /Unavailable mail adapter selection/u);
  assert.throws(() => createMailApplication({ policyAdapter: "does-not-exist" }), /Unavailable mail adapter selection/u);
});

test("pluginConfig can select an implementation by id", async (t) => {
  const store = fakeStore();
  // Register the same fake under a non-default id, then select it through pluginConfig.
  const registry = registryWith(store, defaultMailPolicy, { policyId: "alt", storeId: "alt" });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kurumi-mail-adapters-config-"));
  process.env.OPENCLAW_STATE_DIR = dir;
  const tools = new Map();
  createMailPlugin({ registry }).register({
    config: { channels: { "kurumi-qq": { ownerId: OWNER } } },
    pluginConfig: { allowedRecipients: [ALLOWED], policyAdapter: "alt", storeAdapter: "alt" },
    registerService() { return () => {}; },
    registerTool(definition) { const tool = definition.create(ownerContext()); tools.set(tool.name, tool); return () => {}; },
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const result = JSON.parse((await tools.get("email_draft").execute("call", { to: ALLOWED, subject: "s", text: "t" }, undefined)).content[0].text);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(store.calls.includes("createDraft"), "the id selected through pluginConfig must be the one used");
});

test("the shipped registry registers exactly one default policy and one sqlite store", () => {
  const registry = createMailRegistry();
  assert.deepEqual(registry.ids(), { policies: ["default"], stores: ["sqlite"] });
  const selected = registry.resolve({ policy: "default", store: "sqlite" });
  assert.equal(selected.policyId, "default");
  assert.equal(selected.storeId, "sqlite");
  // The registry wraps registered methods to fix the method table, so this is a behavioural check
  // rather than a reference comparison.
  assert.deepEqual(selected.policy.normalizeDraft({ to: ALLOWED, subject: "s", text: "t" }), defaultMailPolicy.normalizeDraft({ to: ALLOWED, subject: "s", text: "t" }));
  assert.throws(() => selected.policy.assertRecipientsAllowed([ALLOWED], []), /allowlist is empty/u);
});

test("registries are per-composition, so two hosts do not share selections", () => {
  const first = registryWith(fakeStore());
  const second = registryWith(fakeStore());
  assert.notEqual(first.resolve({ policy: "default", store: "sqlite" }), second.resolve({ policy: "default", store: "sqlite" }));
  assert.deepEqual(second.ids(), { policies: ["default"], stores: ["sqlite"] });
});
