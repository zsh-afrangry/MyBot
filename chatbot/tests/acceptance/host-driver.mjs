import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

/** Test-only process. Set isolation before importing any Host or domain module. */
export async function createHostDriver() {
  const directory = mkdtempSync(join(resolve(process.env.KURUMI_ACCEPTANCE_PARENT || tmpdir()), "kurumi-acceptance-"));
  process.env.OPENCLAW_STATE_DIR = directory;
  process.env.OPENCLAW_CONFIG_PATH = join(directory, "openclaw.json");
  const workspace = join(directory, "workspace");
  mkdirSync(workspace);
  const cfg = {
    agents: { defaults: { workspace } },
    session: { store: join(directory, "sessions.json"), dmScope: "per-channel-peer" },
    channels: { qqbot: { enabled: true, allowFrom: ["acceptance-owner"], groupPolicy: "disabled" } },
    commands: { ownerAllowFrom: ["acceptance-owner"] },
    plugins: { enabled: false },
  };
  writeFileSync(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify(cfg));
  const hostRoot = resolve(process.env.OPENCLAW_HOST_ROOT || "/home/afrangry/.npm-global/lib/node_modules/openclaw");
  const load = name => import(pathToFileURL(join(hostRoot, "dist/plugin-sdk", name + ".js")).href);
  const { initializeGlobalHookRunner, resetGlobalHookRunner } = await load("hook-runtime");
  const { dispatchInboundMessageWithDispatcher } = await load("reply-runtime");
  const { default: entry } = await import("../../plugins/personal-confirmation/dist/index.js");
  const logs = [], delivered = [], trace = [];
  const registry = { hooks: [], typedHooks: [], plugins: [], trustedToolPolicies: [] };
  entry.register({
    on(hookName, handler) {
      registry.typedHooks.push({ pluginId: "personal-confirmation", hookName, handler: (event, context) => {
        trace.push("reply_dispatch");
        return handler(event, context);
      } });
    },
    logger: { info: message => logs.push(JSON.parse(message)), warn: message => logs.push(JSON.parse(message)) },
    registerService() {},
  });
  initializeGlobalHookRunner(registry);
  const toolContext = {
    messageChannel: "qqbot", senderIsOwner: true, requesterSenderId: "acceptance-owner",
    sessionKey: "agent:main:qqbot:direct:acceptance-owner",
    deliveryContext: { channel: "qqbot", to: "qqbot:c2c:acceptance-owner", accountId: "default" },
  };
  return {
    directory, cfg, logs, trace, toolContext, delivered,
    /** replyResolver substitutes cognition only; dispatch/hooks/storage remain real. */
    async dispatch(content, replyResolver, overrides = {}) {
      const ctx = {
        Body: content, BodyForAgent: content, BodyForCommands: content, RawBody: content,
        Provider: "qqbot", Surface: "qqbot", OriginatingChannel: "qqbot",
        From: "qqbot:c2c:acceptance-owner", To: "qqbot:c2c:acceptance-owner",
        OriginatingTo: "qqbot:c2c:acceptance-owner", SenderId: "acceptance-owner", AccountId: "default",
        ChatType: "direct", SessionKey: toolContext.sessionKey, MessageSid: randomUUID(), Timestamp: Date.now(),
        CommandAuthorized: true, ...overrides,
      };
      let invoked = false, result;
      await dispatchInboundMessageWithDispatcher({
        ctx, cfg,
        dispatcherOptions: { deliver: async payload => { delivered.push(payload); } },
        replyResolver: async () => {
          trace.push("resolver"); invoked = true; result = await replyResolver();
          return { text: "isolated acceptance turn completed" };
        },
      });
      return invoked ? result : { skipped: true };
    },
    close() { resetGlobalHookRunner(); },
  };
}
