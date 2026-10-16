// kurumi-mail: owner-only email drafting and delivery for the fusion assistant.
//
// Shape follows the other JavaScript plugins in this repository (api.registerTool with
// contextVersion 2). Design notes that matter:
//
//   * Every tool is owner-private-chat only, enforced in execute() via ownerAuthorized(), not by
//     prompt wording. A non-owner context gets a hard error.
//   * Sending requires an approval grant issued through @kurumi/confirmation-core. The grant is
//     created by the host's inbound router when the owner replies with the confirmation code, so the
//     model cannot approve its own draft. This is why the plugin registers a confirmation backend
//     instead of comparing a token itself.
//   * Credentials come from the runtime environment (runtime-env.json is expanded by run-gateway.mjs
//     into the gateway process). They are never returned by any tool, never written to the audit
//     table, and never included in error messages.
import { confirmationBackendIds, registerConfirmationBackend } from "@kurumi/confirmation-core";
import { assertOwnerContext, requireConfirmationScope } from "./inbound.js";
import { ENV_AUTH_CODE, ENV_USER, createMailApplication, mailStateDirectory, readMailConfig } from "./application.js";
import { normalizeAllowlist } from "./policy.js";
import { defaultConnector, SmtpClient } from "./smtp.js";
import {Documents, documentRoot} from '../../packages/documents/index.js';

const PLUGIN_ID = "kurumi-mail";
const BACKEND_ID = "kurumi-mail";
const CHANNEL = "kurumi-qq";

/** Recipient allowlist from the plugin's managed config. Passed to the store and to policy checks. */
function allowlistOf(api) {
  return normalizeAllowlist(api.pluginConfig?.allowedRecipients);
}

function json(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

export function createMailPlugin({ registry } = {}) {
  const plugin = {
  id: PLUGIN_ID,
  name: "Kurumi mail",
  register(api) {
    // Resolve the policy and store this instance runs with. `registry` lets a test or an embedding
    // host supply its own implementations; pluginConfig can select an implementation by id.
    const application = createMailApplication({
      registry,
      policyAdapter: api.pluginConfig?.policyAdapter,
      storeAdapter: api.pluginConfig?.storeAdapter,
      resolveAttachment: id => new Documents(documentRoot(api.config)).get(id),
    });
    const storeOptions = () => ({ stateDirectory: mailStateDirectory(), allowedRecipients: allowlistOf(api) });
    /** Open the selected store for one operation. Nothing here constructs a concrete store. */
    const withStore = (work) => {
      const store = application.openStore(storeOptions());
      try { return work(store); } finally { store.close(); }
    };

    // The host routes the owner's "确认 <code>" message to registered backends only, so this
    // registration is what makes confirmation reachable at all. The backend opens the SELECTED store,
    // so a replacement store is picked up here without editing this file.
    api.registerService({
      id: "kurumi-mail-confirmation-backend",
      start() {
        const unregister = registerConfirmationBackend({
          id: BACKEND_ID,
          open: () => application.openStore(storeOptions()),
        });
        // Logged so the registration is observable in the journal. Without this line the only way to
        // know whether confirmations can reach this domain would be to send a real one.
        api.logger?.info?.(JSON.stringify({
          component: "kurumi-mail",
          event: "confirmation-backend-registered",
          backend: BACKEND_ID,
          registered: confirmationBackendIds(),
          policyAdapter: application.policyId,
          storeAdapter: application.storeId,
        }));
        return () => unregister();
      },
    });

    api.registerTool({
      contextVersion: 2,
      create: (ctx) => ({
        name: "email_status",
        label: "Mail configuration status",
        description:
          "Report whether email sending is configured (sender account, SMTP host/port) without revealing the authorization code. "
          + "Set probe=true to additionally open a real TLS connection and authenticate, which verifies the authorization code works; "
          + "no message is sent. Owner private chat only.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: { probe: { type: "boolean", description: "Also connect and authenticate to the SMTP server." } },
        },
        async execute(callId, args, signal) {
          assertOwnerContext(ctx);
          ctx.assertInvocationCurrent?.();
          const config = readMailConfig();
          const allowedRecipients = allowlistOf(api);
          const result = {
            ok: true,
            configured: config.configured,
            sender: config.user || null,
            host: config.host,
            port: config.port,
            allowedRecipients,
            policyAdapter: application.policyId,
            storeAdapter: application.storeId,
            confirmationBackendRegistered: confirmationBackendIds().includes(BACKEND_ID),
            recipientPolicy: allowedRecipients.length === 0
              ? "closed: the allowlist is empty, so no recipient is permitted"
              : "allowlist",
            secretsExposed: false,
          };
          if (!config.configured) {
            result.hint = `Set ${ENV_USER} and ${ENV_AUTH_CODE} in the runtime environment (QQ Mail: Settings -> Account -> enable SMTP -> generate an authorization code; it is not the QQ password).`;
            return json(result);
          }
          if (args?.probe === true) {
            signal?.throwIfAborted();
            try {
              const socket = await defaultConnector({ host: config.host, port: config.port, secure: true, timeoutMs: 15_000 });
              const client = new SmtpClient(socket, { timeoutMs: 15_000 });
              await client.greeting();
              await client.ehlo("kurumi-fusion");
              await client.authLogin(config.user, config.authCode);
              await client.quit();
              result.smtp = "authenticated";
            } catch (error) {
              result.ok = false;
              result.smtp = "failed";
              result.code = error?.code ?? "error";
              // Message text is built without credentials by smtp.js; keep it short anyway.
              result.reason = String(error?.message ?? error).slice(0, 200);
            }
          }
          return json(result);
        },
      }),
    });

    api.registerTool({
      contextVersion: 2,
      create: (ctx) => ({
        name: "email_draft",
        label: "Draft an email",
        description:
          "Create a pending email draft and return the confirmation instruction the owner must read back verbatim. "
          + "Recipients must appear in the configured allowlist; a recipient outside it is refused with recipient_not_allowed. "
          + "Nothing is sent by this tool. Show the preview (sender, recipients, subject, body excerpt) and the confirmation "
          + "instruction on its own line, then wait for the owner's own message. Owner private chat only.",
        // Shape is intentionally permissive; content is validated at runtime.
        //
        // A schema rejection never reaches this plugin: the model only sees "Invalid arguments" and
        // must spend another turn recovering — and a model that retries a few times can emit a
        // malformed tool call and fail the whole run. A real round trip failed exactly that way,
        // because a single recipient was passed as a string and the body as "body". Both are
        // accepted now, and anything still wrong comes back as a structured, fixable message.
        parameters: {
          type: "object",
          additionalProperties: true,
          properties: {
            to: {
              anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
              description: "Recipients. One address as a plain string is fine; an array or a comma-separated string also works.",
            },
            cc: {
              anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
              description: "Optional carbon-copy recipients, same shapes as 'to'.",
            },
            subject: { type: "string", maxLength: 300, description: "Subject line." },
            text: { type: "string", maxLength: 100000, description: "Plain-text body." },
            body: { type: "string", maxLength: 100000, description: "Alias for 'text'." },
            attachments: {type: 'array', maxItems: 10, items: {type: 'object', additionalProperties: false, required: ['documentId'], properties: {documentId: {type: 'string'}}}, description: 'Managed PDF IDs from kurumi_document or a completed kurumi_translate job. Only references, no paths or base64. The draft freezes exact bytes and shows filenames/hashes for confirmation.'},
          },
        },
        async execute(callId, args, signal) {
          assertOwnerContext(ctx);
          ctx.assertInvocationCurrent?.();
          signal?.throwIfAborted();
          const scope = requireConfirmationScope(ctx);
          const result = withStore((store) => application.directives.createDraft(store, args, scope, allowlistOf(api)));
          if (result.ok) result.from = readMailConfig().user || null;
          return json(result);
        },
      }),
    });

    api.registerTool({
      contextVersion: 2,
      create: (ctx) => ({
        name: "email_send",
        label: "Send an approved email",
        description:
          "Deliver a draft that the owner has already approved. Requires the draft id from email_draft plus the approval the host "
          + "recorded when the owner replied with the confirmation code. Without that approval this returns approval_required and "
          + "sends nothing; repeated sends are refused. Owner private chat only.",
        // Same reasoning as email_draft: shape stays permissive, content is checked at runtime.
        // Models tend to echo the confirmation line back as an extra field; rejecting the call over
        // that key would cost a turn without adding any safety, because approval is never taken from
        // an argument — it is the grant the host recorded from the owner's own message.
        parameters: {
          type: "object",
          additionalProperties: true,
          properties: {
            draftId: { type: "string", description: "Draft id returned by email_draft." },
          },
        },
        async execute(callId, args, signal) {
          assertOwnerContext(ctx);
          ctx.assertInvocationCurrent?.();
          signal?.throwIfAborted();
          const scope = requireConfirmationScope(ctx);
          const store = application.openStore(storeOptions());
          try {
            return json(await application.directives.sendDraft(store, args, {
              scope,
              config: readMailConfig(),
              allowedRecipients: allowlistOf(api),
            }));
          } finally {
            store.close();
          }
        },
      }),
    });

    api.registerTool({
      contextVersion: 2,
      create: (ctx) => ({
        name: "email_outbox",
        label: "Mail drafts and audit",
        description:
          "List mail drafts and their status (pending/sent/failed/cancelled), read the recent audit trail, or cancel a pending draft. "
          + "Read-only except for cancel. Owner private chat only.",
        parameters: {
          type: "object",
          additionalProperties: true,
          properties: {
            action: { type: "string", enum: ["list", "audit", "cancel"], description: "Defaults to list." },
            draftId: { type: "string", description: "Required for cancel." },
            limit: { type: "number", minimum: 1, maximum: 50 },
          },
        },
        async execute(callId, args, signal) {
          assertOwnerContext(ctx);
          ctx.assertInvocationCurrent?.();
          signal?.throwIfAborted();
          return json(withStore((store) => {
            const input = application.policy.normalizeOutbox(args);
            if (input.problem) return { ok: false, code: "invalid_action", reason: input.problem };
            if (input.action === "list") return { ok: true, action: "list", drafts: store.listDrafts({ limit: input.limit ?? 10 }) };
            if (input.action === "audit") return { ok: true, action: "audit", entries: store.listAudit({ limit: input.limit ?? 10 }) };
            const cancelled = store.cancelDraft(input.draftId);
            return { ok: cancelled, cancelled, action: "cancel", draftId: input.draftId };
          }));
        },
      }),
    });
  },
  };
  return plugin;
}

export default createMailPlugin();
export { CHANNEL };
