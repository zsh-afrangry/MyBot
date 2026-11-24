// kurumi-mail: owner-only email drafting and delivery for the fusion assistant.
//
// Shape follows the other JavaScript plugins in this repository (api.registerTool with
// contextVersion 2). Design notes that matter:
//
//   * Every tool is owner-private-chat only, enforced in execute() via ownerAuthorized(), not by
//     prompt wording. A non-owner context gets a hard error.
//   * Sending requires an approval grant issued through @kurumi/confirmation-core. The grant is
//     created by the shared tool from a bound current owner message, so the
//     model cannot approve its own draft. This is why the plugin registers a confirmation backend
//     instead of comparing a token itself.
//   * Credentials come from the runtime environment (runtime-env.json is expanded by run-gateway.mjs
//     into the gateway process). They are never returned by any tool, never written to the audit
//     table, and never included in error messages.
import path from "node:path";
import { confirmationBackendIds, registerConfirmationBackend } from "@kurumi/confirmation-core";
import { assertOwnerContext, requireConfirmationScope } from "./inbound.js";
import { ENV_AUTH_CODE, ENV_USER, createMailApplication, mailStateDirectory, openClawStateDirectory, readImapConfig, readMailConfig } from "./application.js";
import { executeInboxAction } from "./inbox-service.js";
import { InboxStore, MAIL_INBOX_BACKEND_ID } from "./inbox-store.js";
import { defaultImapConnector, withImapClient } from "./imap.js";
import { normalizeAllowlist } from "./policy.js";
import { defaultConnector, SmtpClient } from "./smtp.js";
import {Documents, documentRoot} from '../../packages/documents/index.js';
import { createRuntimeTraceSink } from "../../packages/observability/index.js";
import { createToolTrace } from "../../packages/observability/tool-trace.js";
import {mailDraftFeedback, mailFeedbackActions, mailReceiptFeedback, mailSendFeedback} from "./feedback.js";

const PLUGIN_ID = "kurumi-mail";
const BACKEND_ID = "kurumi-mail";
const CHANNEL = "kurumi-qq";
const ALL_MAIL_FEEDBACK_ACTIONS = [...mailFeedbackActions, "mail.inbox.access", "mail.inbox.manage"];

function allowlistOf(api, cfg) {
  return normalizeAllowlist((cfg ?? api.config)?.plugins?.entries?.[PLUGIN_ID]?.config?.allowedRecipients ?? api.pluginConfig?.allowedRecipients);
}

function allowedSendersOf(api, cfg) {
  return normalizeAllowlist((cfg ?? api.config)?.plugins?.entries?.[PLUGIN_ID]?.config?.allowedSenders ?? api.pluginConfig?.allowedSenders);
}

function json(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

export function createMailPlugin({ registry, connector, imapConnector = defaultImapConnector, stateRoot: overrideStateRoot, trace: overrideTrace } = {}) {
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
    const feedbackActions = new Set(api.pluginConfig?.feedbackActions ?? ALL_MAIL_FEEDBACK_ACTIONS);
    const effectiveStateRoot = () => overrideStateRoot ?? api.runtime?.state?.resolveStateDir?.() ?? openClawStateDirectory();
    const effectiveMailDir = () => overrideStateRoot ? path.join(overrideStateRoot, "state", "kurumi-mail") : mailStateDirectory();
    const storeOptions = () => ({ stateDirectory: effectiveMailDir(), allowedRecipients: allowlistOf(api) });
    const openInboxStore = () => new InboxStore({ stateDirectory: effectiveMailDir() });
    const emitTrace = event => {
      if (overrideTrace) return overrideTrace(event);
      return createRuntimeTraceSink("trace-events.jsonl", { stateRoot: effectiveStateRoot() }).emit(event);
    };
    const inboxTrace = createToolTrace(["email_inbox"]);
    if (typeof api.on === "function") inboxTrace.attach(api);
    /** Open the selected store for one operation. Nothing here constructs a concrete store. */
    const withStore = (work) => {
      const store = application.openStore(storeOptions());
      try { return work(store); } finally { store.close(); }
    };

    // The shared confirmation tool and legacy coded ingress use registered backends, so this
    // registration is what makes confirmation reachable at all. The backend opens the SELECTED store,
    // so a replacement store is picked up here without editing this file.
    let unregisterBackend;
    api.registerService({
      id: "kurumi-mail-confirmation-backend",
      start() {
        unregisterBackend = registerConfirmationBackend({
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
      },
      stop() {
        const unregister = unregisterBackend;
        unregisterBackend = undefined;
        unregister?.();
      },
    });

    let unregisterInboxBackend;
    api.registerService({
      id: "kurumi-mail-inbox-backend",
      start() {
        unregisterInboxBackend = registerConfirmationBackend({
          id: MAIL_INBOX_BACKEND_ID,
          open: () => {
            const store = openInboxStore();
            return {
              natural: store.natural,
              listInboundConfirmationCandidates: () => [],
              recordInboundConfirmation: () => false,
              close: () => store.close(),
            };
          },
        });
        api.logger?.info?.(JSON.stringify({
          component: "kurumi-mail",
          event: "inbox-confirmation-backend-registered",
          backend: MAIL_INBOX_BACKEND_ID,
          registered: confirmationBackendIds(),
        }));
      },
      stop() {
        const unregister = unregisterInboxBackend;
        unregisterInboxBackend = undefined;
        unregister?.();
      },
    });

    api.registerTool({
      contextVersion: 2,
      create: (ctx) => ({
        name: "email_status",
        label: "Mail configuration status",
        description:
          "Report whether email sending and IMAP inbox access are configured (account, SMTP/IMAP host/port) without revealing the authorization code. "
          + "Set probe=true to additionally open TLS connections and authenticate, verifying the authorization code; "
          + "no message is sent. Owner private chat only.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: { probe: { type: "boolean", description: "Also connect and authenticate to SMTP and IMAP servers." } },
        },
        async execute(callId, args, signal) {
          const resolvedCfg = assertOwnerContext(ctx, api.config, "mail.status");
          ctx.assertInvocationCurrent?.();
          const config = readMailConfig();
          const imapConfig = readImapConfig();
          const allowedRecipients = allowlistOf(api, resolvedCfg);
          const allowedSenders = allowedSendersOf(api, resolvedCfg);
          const result = {
            ok: true,
            configured: config.configured,
            sender: config.user || null,
            host: config.host,
            port: config.port,
            imapHost: imapConfig.host,
            imapPort: imapConfig.port,
            allowedRecipients,
            allowedSenders,
            policyAdapter: application.policyId,
            storeAdapter: application.storeId,
            confirmationBackendRegistered: confirmationBackendIds().includes(BACKEND_ID),
            inboxConfirmationBackendRegistered: confirmationBackendIds().includes(MAIL_INBOX_BACKEND_ID),
            recipientPolicy: allowedRecipients.length === 0
              ? "closed: the allowlist is empty, so no recipient is permitted"
              : "allowlist",
            secretsExposed: false,
          };
          if (!config.configured) {
            result.hint = `Set ${ENV_USER} and ${ENV_AUTH_CODE} in the runtime environment (QQ Mail: Settings -> Account -> enable SMTP/IMAP -> generate an authorization code; it is not the QQ password).`;
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
              result.reason = String(error?.message ?? error).slice(0, 200);
            }
            try {
              await withImapClient(imapConfig, { readOnly: true, folder: null, connector: imapConnector }, async () => true);
              result.imap = "authenticated";
            } catch (error) {
              result.ok = false;
              result.imap = "failed";
              result.imapCode = error?.code ?? "error";
              result.imapReason = String(error?.message ?? error).slice(0, 200);
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
          "Create a pending email draft and return its frozen preview. The owner can confirm in natural language. "
          + "Recipients must appear in the configured allowlist; a recipient outside it is refused with recipient_not_allowed. "
          + "Nothing is sent by this tool. Show the frozen recipients, subject, full body and attachments using "
          + "previewText verbatim, then wait for a later owner message. Resolve it with personal_confirmation before email_send. Owner private chat only.",
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
          const resolvedCfg = assertOwnerContext(ctx, api.config, "mail.draft");
          ctx.assertInvocationCurrent?.();
          signal?.throwIfAborted();
          const scope = requireConfirmationScope(ctx);
          const result = withStore((store) => application.directives.createDraft(store, args, scope, allowlistOf(api, resolvedCfg)));
          if (result.ok) {
            result.from = readMailConfig().user || null;
            if (feedbackActions.has("mail.draft")) result.feedback = mailDraftFeedback(result);
          }
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
          + "recorded via personal_confirmation from the current owner reply. Without that approval this returns approval_required and "
          + "sends nothing; repeated sends are refused. For an unknown SMTP result, use email_outbox receipt to check the original draft. Owner private chat only.",
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
          const resolvedCfg = assertOwnerContext(ctx, api.config, "mail.send");
          ctx.assertInvocationCurrent?.();
          signal?.throwIfAborted();
          const scope = requireConfirmationScope(ctx);
          const store = application.openStore(storeOptions());
          try {
            const result = await application.directives.sendDraft(store, args, {
              scope,
              config: readMailConfig(),
              allowedRecipients: allowlistOf(api, resolvedCfg),
              connector,
              logger: api.logger,
            });
            if (result.status && feedbackActions.has("mail.send")) result.feedback = mailSendFeedback(result);
            return json(result);
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
          "List drafts, read their audit trail, query the receipt for a specific draft, or cancel a pending draft. "
          + "Use action=receipt with draftId to check confirmation and SMTP status. SMTP acceptance records server acceptance. "
          + "Inbox delivery and read status require separate evidence. Read-only except for cancel. Owner private chat only.",
        parameters: {
          type: "object",
          additionalProperties: true,
          properties: {
            action: { type: "string", enum: ["list", "audit", "receipt", "cancel"], description: "Defaults to list." },
            draftId: { type: "string", description: "Required for receipt or cancel." },
            limit: { type: "number", minimum: 1, maximum: 50 },
          },
        },
        async execute(callId, args, signal) {
          assertOwnerContext(ctx, api.config, "mail.history");
          ctx.assertInvocationCurrent?.();
          signal?.throwIfAborted();
          return json(withStore((store) => {
            const input = application.policy.normalizeOutbox(args);
            if (input.problem) return { ok: false, code: "invalid_action", reason: input.problem };
            if (input.action === "list") return { ok: true, action: "list", drafts: store.listDrafts({ limit: input.limit ?? 10 }) };
            if (input.action === "audit") return { ok: true, action: "audit", entries: store.listAudit({ limit: input.limit ?? 10 }) };
            if (input.action === "receipt") {
              if (!feedbackActions.size) return {ok: false, code: "feedback_disabled"};
              const receipt = store.getReceipt(input.draftId);
              if (!receipt) return {ok: false, code: "unknown_draft"};
              return {ok: true, action: "receipt", draftId: receipt.draftId, feedback: mailReceiptFeedback(receipt, store.nowUtc(), feedbackActions)};
            }
            const cancelled = store.cancelDraft(input.draftId);
            return { ok: cancelled, cancelled, action: "cancel", draftId: input.draftId };
          }));
        },
      }),
    });

    api.registerTool({
      contextVersion: 2,
      create: (ctx) => ({
        name: "email_inbox",
        label: "Manage IMAP inbox & untrusted sender access",
        description:
          "Owner private chat only. Browse folders, list/search headers, read emails, save attachments to workspace mail-attachments/, "
          + "mark read/unread, and move/trash emails without physical EXPUNGE. "
          + "Senders outside allowedSenders or failing SPF/DKIM only expose safe metadata; use propose_access -> personal_confirmation(domain=\"mail_inbox\") -> commit_access "
          + "to unlock one email for 24h (or propose 长期信任 via kurumi_access category=mail_sender). move/trash require propose_manage -> personal_confirmation(domain=\"mail_inbox\") -> commit_manage.",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["action"],
          properties: {
            action: {
              type: "string",
              enum: [
                "folders", "list", "search", "read", "save_attachment",
                "propose_access", "commit_access",
                "mark_read", "mark_unread",
                "propose_manage", "commit_manage", "status",
              ],
            },
            account: { type: "string", maxLength: 64, description: "Account id; defaults to 'default'." },
            folder: { type: "string", maxLength: 128, description: "Mailbox folder name; defaults to 'INBOX'." },
            uid: { type: "integer", minimum: 1 },
            uidValidity: { type: "integer", minimum: 1 },
            limit: { type: "integer", minimum: 1, maximum: 50 },
            unseenOnly: { type: "boolean" },
            from: { type: "string", maxLength: 200 },
            subject: { type: "string", maxLength: 200 },
            since: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
            partId: { type: "string", maxLength: 32 },
            allowSaveAttachment: { type: "boolean" },
            op: { type: "string", enum: ["move", "trash"] },
            targetFolder: { type: "string", maxLength: 128 },
            proposalId: { type: "string", pattern: "^[a-fA-F0-9-]{36}$" },
          },
        },
        async execute(callId, args = {}, signal) {
          assertOwnerContext(ctx, api.config);
          try {
            const runId = inboxTrace.resolve(ctx, callId, "email_inbox");
            const res = await executeInboxAction({
              args,
              ctx,
              callId,
              signal,
              runId,
              api,
              imapConnector,
              openStore: openInboxStore,
              allowedSendersOf: cfg => allowedSendersOf(api, cfg),
              stateRoot: effectiveStateRoot(),
              feedbackActions,
              emitTrace,
            });
            return json(res);
          } catch (error) {
            signal?.throwIfAborted();
            if (error?.code === "unauthorized_owner_context" || error?.code === "untrusted_confirmation_context") {
              throw error;
            }
            if (typeof error?.code === "string") {
              return json({ ok: false, code: error.code, message: String(error.message ?? error.code).slice(0, 200) });
            }
            api.logger?.warn?.("Inbox operation failed");
            return json({ ok: false, code: "inbox_operation_failed", message: "收件箱操作失败" });
          }
        },
      }),
    }, { name: "email_inbox", optional: true });
  },
  };
  return plugin;
}

export default createMailPlugin();
export { CHANNEL };
