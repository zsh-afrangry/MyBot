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
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { ownerAuthorized } from "../kurumi-qq/src/config.js";
import { confirmationBackendIds, registerConfirmationBackend, scopeFromToolContext } from "@kurumi/confirmation-core";
import { MailPolicyError, MailStore, normalizeAllowlist } from "./store.js";
import { sendApprovedDraft } from "./deliver.js";
import { defaultConnector, SmtpClient } from "./smtp.js";

const PLUGIN_ID = "kurumi-mail";
const BACKEND_ID = "kurumi-mail";
const CHANNEL = "kurumi-qq";

/** Environment keys, expanded from runtime-env.json by run-gateway.mjs. */
export const ENV_USER = "KURUMI_MAIL_USER";
export const ENV_AUTH_CODE = "KURUMI_MAIL_AUTH_CODE";
export const ENV_HOST = "KURUMI_MAIL_HOST";
export const ENV_PORT = "KURUMI_MAIL_PORT";
const DEFAULT_HOST = "smtp.qq.com";
const DEFAULT_PORT = 465;

export function openClawStateDirectory(env = process.env) {
  return env.OPENCLAW_STATE_DIR?.trim() ? resolve(env.OPENCLAW_STATE_DIR) : join(homedir(), ".openclaw-fusion");
}

export function mailStateDirectory(env = process.env) {
  return join(openClawStateDirectory(env), "state", "kurumi-mail");
}

/** Read configuration without ever exposing the authorization code. */
export function readMailConfig(env = process.env) {
  const user = env[ENV_USER]?.trim() ?? "";
  const authCode = env[ENV_AUTH_CODE]?.trim() ?? "";
  const host = env[ENV_HOST]?.trim() || DEFAULT_HOST;
  const parsedPort = Number(env[ENV_PORT] ?? DEFAULT_PORT);
  const port = Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort < 65_536 ? parsedPort : DEFAULT_PORT;
  return { user, authCode, host, port, configured: Boolean(user && authCode) };
}

/** Recipient policy, read from the plugin's managed config. Fail-closed when absent. */
function mailPolicy(api) {
  return normalizeAllowlist(api.pluginConfig?.allowedRecipients);
}

function json(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function ownerOnly(ctx, api) {
  const cfg = ctx.getRuntimeConfig?.() ?? api.config;
  if (!ownerAuthorized(ctx, cfg)) {
    const error = new Error("Mail tools are available in the owner's private chat only");
    error.code = "unauthorized_owner_context";
    throw error;
  }
  return cfg;
}

function requireScope(ctx) {
  const scope = scopeFromToolContext(ctx);
  if (!scope) {
    const error = new Error("Mail confirmation requires a trusted owner private-chat context");
    error.code = "untrusted_confirmation_context";
    throw error;
  }
  return scope;
}

const TOOL_METADATA = { email_status: { optional: true }, email_draft: { optional: true }, email_send: { optional: true }, email_outbox: { optional: true } };

export default {
  id: PLUGIN_ID,
  name: "Kurumi mail",
  register(api) {
    // The host routes the owner's "确认 <code>" message to registered backends only, so this
    // registration is what makes confirmation reachable at all.
    api.registerService({
      id: "kurumi-mail-confirmation-backend",
      start() {
        const unregister = registerConfirmationBackend({
          id: BACKEND_ID,
          open: () => new MailStore({ stateDirectory: mailStateDirectory(), allowedRecipients: normalizeAllowlist(api.pluginConfig?.allowedRecipients) }),
        });
        // Logged so the registration is observable in the journal. Without this line the only way to
        // know whether confirmations can reach this domain would be to send a real one.
        api.logger?.info?.(JSON.stringify({
          component: "kurumi-mail",
          event: "confirmation-backend-registered",
          backend: BACKEND_ID,
          registered: confirmationBackendIds(),
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
          ownerOnly(ctx, api);
          ctx.assertInvocationCurrent?.();
          const config = readMailConfig();
          const allowedRecipients = mailPolicy(api);
          const result = {
            ok: true,
            configured: config.configured,
            sender: config.user || null,
            host: config.host,
            port: config.port,
            allowedRecipients,
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
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["to", "subject", "text"],
          properties: {
            to: { type: "array", minItems: 1, maxItems: 20, items: { type: "string" }, description: "Recipient addresses." },
            cc: { type: "array", maxItems: 20, items: { type: "string" } },
            subject: { type: "string", maxLength: 300 },
            text: { type: "string", maxLength: 100000, description: "Plain-text body." },
          },
        },
        async execute(callId, args, signal) {
          ownerOnly(ctx, api);
          ctx.assertInvocationCurrent?.();
          signal?.throwIfAborted();
          const scope = requireScope(ctx);
          const allowedRecipients = mailPolicy(api);
          const store = new MailStore({ stateDirectory: mailStateDirectory(), allowedRecipients });
          try {
            let created;
            try {
              created = store.createDraft(
                { to: args.to, cc: args.cc ?? [], subject: args.subject, text: args.text },
                scope,
              );
            } catch (error) {
              // Policy and validation refusals are owner-facing answers, not tool crashes.
              if (error instanceof MailPolicyError) {
                return json({ ok: false, code: error.code, reason: error.message, allowedRecipients, sent: false });
              }
              return json({ ok: false, code: "invalid_draft", reason: String(error?.message ?? error).slice(0, 300), sent: false });
            }
            const config = readMailConfig();
            return json({
              ok: true,
              status: "needs_confirmation",
              draftId: created.draftId,
              confirmationInstruction: created.instruction,
              from: config.user || null,
              to: args.to,
              cc: args.cc ?? [],
              subject: args.subject,
              bodyChars: String(args.text).length,
              expiresAtUtc: created.expiresAtUtc,
              note: "Not sent. The owner must reply with the confirmation instruction before email_send can deliver it.",
            });
          } finally {
            store.close();
          }
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
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["draftId"],
          properties: { draftId: { type: "string", description: "Draft id returned by email_draft." } },
        },
        async execute(callId, args, signal) {
          ownerOnly(ctx, api);
          ctx.assertInvocationCurrent?.();
          signal?.throwIfAborted();
          const scope = requireScope(ctx);
          const store = new MailStore({ stateDirectory: mailStateDirectory(), allowedRecipients: mailPolicy(api) });
          try {
            const result = await sendApprovedDraft({
              store,
              draftId: args.draftId,
              scope,
              config: readMailConfig(),
              allowedRecipients: mailPolicy(api),
            });
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
          "List mail drafts and their status (pending/sent/failed/cancelled), read the recent audit trail, or cancel a pending draft. "
          + "Read-only except for cancel. Owner private chat only.",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["action"],
          properties: {
            action: { type: "string", enum: ["list", "audit", "cancel"] },
            draftId: { type: "string", description: "Required for cancel." },
            limit: { type: "number", minimum: 1, maximum: 50 },
          },
        },
        async execute(callId, args, signal) {
          ownerOnly(ctx, api);
          ctx.assertInvocationCurrent?.();
          signal?.throwIfAborted();
          const store = new MailStore({ stateDirectory: mailStateDirectory(), allowedRecipients: mailPolicy(api) });
          try {
            if (args.action === "list") {
              return json({ ok: true, drafts: store.listDrafts({ limit: args.limit ?? 10 }) });
            }
            if (args.action === "audit") {
              return json({ ok: true, entries: store.listAudit({ limit: args.limit ?? 10 }) });
            }
            if (!args.draftId) return json({ ok: false, code: "draft_id_required" });
            const cancelled = store.cancelDraft(args.draftId);
            return json({ ok: cancelled, cancelled, draftId: args.draftId });
          } finally {
            store.close();
          }
        },
      }),
    });
  },
};

export { TOOL_METADATA, CHANNEL };
