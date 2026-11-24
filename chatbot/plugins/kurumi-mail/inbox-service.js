// Owner-only IMAP inbox operations, dual-layer sender trust, and attachment staging for kurumi-mail.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { businessFeedback } from "../../packages/feedback-core/index.js";
import { ensureWorkspaceSubdir, FilesError } from "../../packages/scoped-lease/tiers.js";
import { readImapConfig } from "./application.js";
import { assertOwnerContext, requireConfirmationScope } from "./inbound.js";
import { ImapError, withImapClient } from "./imap.js";
import {
  MAIL_INBOX_DOMAIN,
  INBOX_UUID_PATTERN,
} from "./inbox-store.js";
import { parseEnvelopeFromHeaders, parseRawEmail, wrapUntrustedBody } from "./mime-parse.js";
import { normalizeAllowlist } from "./policy.js";

const MAX_LIST_LIMIT = 50;
const MAX_ATTACHMENT_SAVE_BYTES = 16 * 1024 * 1024;
const sha256 = value => createHash("sha256").update(value).digest("hex");

function resolveAccountId(account) {
  const value = String(account ?? "default").trim() || "default";
  if (value !== "default") {
    const error = new Error(`不支持的邮箱账号 ${value}；当前仅配置 default 主账号`);
    error.code = "unknown_mail_account";
    throw error;
  }
  return value;
}

function resolveTrust({ fromAddress, authFailed, allowedSenders, activeGrant }) {
  const staticTrusted = Boolean(fromAddress && allowedSenders.includes(fromAddress) && !authFailed);
  if (staticTrusted) {
    return {
      trusted: true,
      trustSource: "allowlist",
      canReadBody: true,
      canSaveAttachment: true,
      trustReason: "sender_in_allowlist",
    };
  }
  if (activeGrant?.allowReadBody) {
    return {
      trusted: true,
      trustSource: "per_email_grant",
      canReadBody: true,
      canSaveAttachment: activeGrant.allowSaveAttachment,
      trustReason: authFailed ? "approved_despite_auth_warning" : "approved_for_email",
    };
  }
  return {
    trusted: false,
    trustSource: "untrusted",
    canReadBody: false,
    canSaveAttachment: false,
    trustReason: authFailed ? "auth_failed_downgraded" : "sender_not_in_allowlist",
  };
}

function shanghaiDateString(nowMs = Date.now()) {
  return new Date(nowMs + 8 * 3600_000).toISOString().slice(0, 10);
}

function buildDestFilename(uid, digest, safeFilename) {
  const prefix = `${uid}_${digest.slice(0, 12)}_`;
  const maxBytes = 200;
  let candidate = `${prefix}${safeFilename}`;
  if (Buffer.byteLength(candidate, "utf8") <= maxBytes) return candidate;
  const ext = path.extname(safeFilename).slice(0, 20);
  const stem = safeFilename.slice(0, Math.max(1, safeFilename.length - ext.length));
  const clipped = Array.from(stem).slice(0, 48).join("");
  candidate = `${prefix}${clipped}${ext}`;
  return candidate;
}

function safeSummaryText(text, maxChars = 120) {
  return String(text ?? "").replace(/[\p{Cc}\p{Cf}]/gu, " ").trim().slice(0, maxChars) || "（无主题）";
}

function stageAttachmentFile({ filesConfig, stateRoot, folder, uidValidity, uid, attachment, store, accountId }) {
  if (!filesConfig) {
    throw new FilesError("files_not_configured");
  }
  if (attachment.sizeBytes > MAX_ATTACHMENT_SAVE_BYTES) {
    const err = new Error(`附件大小 (${attachment.sizeBytes}) 超出 16 MiB 保存上限`);
    err.code = "attachment_too_large";
    throw err;
  }
  const existing = store.findSavedAttachment({
    accountId,
    folder,
    uidValidity,
    uid,
    partId: attachment.partId,
    sha256: attachment.sha256,
  });
  if (existing && fs.existsSync(existing.savedPath)) {
    try {
      const diskBytes = fs.readFileSync(existing.savedPath);
      if (sha256(diskBytes) === attachment.sha256) {
        return {
          ok: true,
          alreadySaved: true,
          path: existing.savedPath,
          filename: attachment.filename,
          sha256: attachment.sha256,
          sizeBytes: attachment.sizeBytes,
          partId: attachment.partId,
        };
      }
    } catch { /* fall through and re-save */ }
  }

  const dayStr = shanghaiDateString();
  const { directory } = ensureWorkspaceSubdir(filesConfig, ["mail-attachments", dayStr], { stateRoot });
  const destName = buildDestFilename(uid, attachment.sha256, attachment.filename);
  const destPath = path.join(directory, destName);

  const lstat = fs.lstatSync(destPath, { throwIfNoEntry: false });
  if (lstat) {
    if (lstat.isSymbolicLink() || !lstat.isFile()) {
      throw new FilesError("files_symlink_not_allowed");
    }
    const existingBytes = fs.readFileSync(destPath);
    if (sha256(existingBytes) !== attachment.sha256) {
      const altName = `${uid}_${attachment.sha256.slice(0, 12)}_${Date.now()}${path.extname(attachment.filename).slice(0, 20)}`;
      const altPath = path.join(directory, altName);
      fs.writeFileSync(altPath, attachment.content, { flag: "wx", mode: 0o600 });
      store.recordSavedAttachment({
        accountId, folder, uidValidity, uid, partId: attachment.partId,
        filename: attachment.filename, sha256: attachment.sha256, sizeBytes: attachment.sizeBytes, savedPath: altPath,
      });
      return {
        ok: true, alreadySaved: false, path: altPath,
        filename: attachment.filename, sha256: attachment.sha256, sizeBytes: attachment.sizeBytes, partId: attachment.partId,
      };
    }
  } else {
    fs.writeFileSync(destPath, attachment.content, { flag: "wx", mode: 0o600 });
  }

  store.recordSavedAttachment({
    accountId, folder, uidValidity, uid, partId: attachment.partId,
    filename: attachment.filename, sha256: attachment.sha256, sizeBytes: attachment.sizeBytes, savedPath: destPath,
  });
  return {
    ok: true,
    alreadySaved: false,
    path: destPath,
    filename: attachment.filename,
    sha256: attachment.sha256,
    sizeBytes: attachment.sizeBytes,
    partId: attachment.partId,
  };
}

function findTrashFolderName(mailboxes) {
  const byAttr = mailboxes.find(m => m.attributes.some(a => a.toLowerCase() === "\\trash"));
  if (byAttr) return byAttr.name;
  for (const name of ["已删除", "Deleted Messages", "Trash", "垃圾箱"]) {
    const hit = mailboxes.find(m => m.name.toLowerCase() === name.toLowerCase());
    if (hit) return hit.name;
  }
  return null;
}

export async function executeInboxAction({
  args,
  ctx,
  callId,
  signal,
  runId,
  api,
  imapConnector,
  openStore,
  allowedSendersOf,
  stateRoot,
  feedbackActions,
  emitTrace,
}) {
  const action = args?.action;
  const permissionMap = {
    folders: "mail.inbox.read",
    list: "mail.inbox.read",
    search: "mail.inbox.read",
    read: "mail.inbox.read",
    status: "mail.inbox.read",
    propose_access: "mail.inbox.read",
    save_attachment: "mail.inbox.attachment",
    mark_read: "mail.inbox.manage",
    mark_unread: "mail.inbox.manage",
    propose_manage: "mail.inbox.manage",
    commit_manage: "mail.inbox.manage",
    commit_access: "mail.inbox.manage",
  };
  const expectedPermission = permissionMap[action];
  if (!expectedPermission) {
    return { ok: false, code: "invalid_action", message: `未知收件箱动作: ${String(action)}` };
  }
  const runtimeCfg = assertOwnerContext(ctx, api.config, expectedPermission);
  ctx.assertInvocationCurrent?.();
  signal?.throwIfAborted();

  const accountId = resolveAccountId(args?.account);
  const imapConfig = readImapConfig();
  const folder = String(args?.folder ?? "INBOX").trim() || "INBOX";
  const allowedSenders = normalizeAllowlist(allowedSendersOf(runtimeCfg));
  const filesConfig = runtimeCfg?.plugins?.entries?.["kurumi-files"]?.config;

  const store = openStore();
  try {
    if (action === "status") {
      if (typeof args.proposalId !== "string" || !INBOX_UUID_PATTERN.test(args.proposalId)) {
        return { ok: false, code: "invalid_proposal_id", message: "需要有效的 proposalId" };
      }
      const row = store.getProposal(args.proposalId);
      if (!row) return { ok: false, code: "unknown_inbox_proposal" };
      const fbAction = row.kind === "access" ? "mail.inbox.access" : "mail.inbox.manage";
      const fbStatus = row.state === "committed" ? "succeeded"
        : row.state === "failed" ? "failed"
          : row.state === "executing" || row.state === "unknown" ? "unknown"
            : row.state;
      return {
        ok: true,
        action: "status",
        proposalId: row.proposalId,
        kind: row.kind,
        status: row.state,
        expiresAtUtc: row.expiresAtUtc,
        ...(row.result ? { result: row.result } : {}),
        ...(row.error ? { code: row.error } : {}),
        ...(feedbackActions.has(fbAction)
          ? { feedback: businessFeedback(fbAction, fbStatus, { proposalId: row.proposalId, kind: row.kind }) }
          : {}),
      };
    }

    if (!imapConfig.configured) {
      return {
        ok: false,
        code: "imap_not_configured",
        message: "尚未配置邮箱账号与授权码（KURUMI_MAIL_USER / KURUMI_MAIL_AUTH_CODE）。",
      };
    }

    if (action === "folders") {
      const mailboxes = await withImapClient(imapConfig, { readOnly: true, folder: null, connector: imapConnector }, client =>
        client.listMailboxes(),
      );
      return {
        ok: true,
        action: "folders",
        account: accountId,
        host: imapConfig.host,
        port: imapConfig.port,
        folders: mailboxes.map(m => ({ name: m.name, selectable: m.selectable, attributes: m.attributes })),
      };
    }

    if (action === "list" || action === "search") {
      const limit = Math.min(Math.max(Number.isInteger(args.limit) ? args.limit : 20, 1), MAX_LIST_LIMIT);
      const data = await withImapClient(imapConfig, { readOnly: true, folder, connector: imapConnector }, async (client, mbox) => {
        const uids = await client.uidSearch({
          unseenOnly: args.unseenOnly === true,
          from: action === "search" ? args.from : undefined,
          subject: action === "search" ? args.subject : undefined,
          since: action === "search" ? args.since : undefined,
        });
        const selected = uids.slice(-limit).reverse();
        const headers = await client.uidFetchHeaders(selected);
        const byUid = new Map(headers.map(h => [h.uid, h]));
        return {
          uidValidity: mbox.uidValidity,
          exists: mbox.exists,
          totalMatched: uids.length,
          items: selected.map(uid => {
            const h = byUid.get(uid);
            const env = h ? parseEnvelopeFromHeaders(h.headerBuffer) : { from: { name: null, address: null }, subject: "", date: null, authFailed: false, authWarnings: [] };
            const activeGrant = store.getActiveGrant({ accountId, folder, uidValidity: mbox.uidValidity, uid });
            const trust = resolveTrust({
              fromAddress: env.from.address,
              authFailed: env.authFailed,
              allowedSenders,
              activeGrant,
            });
            return {
              uid,
              uidValidity: mbox.uidValidity,
              folder,
              seen: h?.seen ?? false,
              sizeBytes: h?.sizeBytes ?? null,
              from: env.from,
              subject: safeSummaryText(env.subject, 200),
              date: env.date,
              trusted: trust.trusted,
              trustSource: trust.trustSource,
              trustReason: trust.trustReason,
              authWarnings: env.authWarnings,
            };
          }),
        };
      });
      return { ok: true, action, account: accountId, folder, ...data };
    }

    if (action === "mark_read" || action === "mark_unread") {
      const uid = Number(args.uid);
      if (!Number.isSafeInteger(uid) || uid < 1) return { ok: false, code: "invalid_uid", message: "需要正整数 uid" };
      const res = await withImapClient(imapConfig, { readOnly: false, folder, connector: imapConnector }, async (client, mbox) => {
        if (args.uidValidity !== undefined && mbox.uidValidity !== args.uidValidity) {
          throw new ImapError("uid_validity_mismatch", "邮箱文件夹 UIDVALIDITY 已变化，请重新列出", { stage: "store" });
        }
        const meta = await client.uidFetchMeta(uid);
        if (!meta) throw new ImapError("email_not_found", `未找到 UID=${uid}`, { stage: "store" });
        await client.uidStoreSeen(uid, action === "mark_read");
        return { uidValidity: mbox.uidValidity };
      });
      store.audit(action, { folder, uid, uidValidity: res.uidValidity }, accountId);
      return { ok: true, action, account: accountId, folder, uid, uidValidity: res.uidValidity, seen: action === "mark_read" };
    }

    if (action === "read" || action === "save_attachment" || action === "propose_access") {
      const uid = Number(args.uid);
      if (!Number.isSafeInteger(uid) || uid < 1) return { ok: false, code: "invalid_uid", message: "需要正整数 uid" };
      const fetched = await withImapClient(imapConfig, { readOnly: true, folder, connector: imapConnector }, async (client, mbox) => {
        if (args.uidValidity !== undefined && mbox.uidValidity !== args.uidValidity) {
          throw new ImapError("uid_validity_mismatch", "邮箱 UIDVALIDITY 已变化，请重新查询邮件列表", { stage: "fetch" });
        }
        const raw = await client.uidFetchRaw(uid);
        return { mailbox: mbox, raw };
      });
      ctx.assertInvocationCurrent?.();
      signal?.throwIfAborted();

      const parsed = parseRawEmail(fetched.raw.rawBuffer, { includeAttachmentBytes: action === "save_attachment" });
      const uidValidity = fetched.mailbox.uidValidity ?? 0;
      const activeGrant = store.getActiveGrant({ accountId, folder, uidValidity, uid });
      const trust = resolveTrust({
        fromAddress: parsed.from.address,
        authFailed: parsed.authFailed,
        allowedSenders,
        activeGrant,
      });

      if (action === "propose_access") {
        const scope = requireConfirmationScope(ctx);
        const allowSaveAttachment = Boolean(args.allowSaveAttachment || args.partId);
        const plan = {
          accountId,
          folder,
          uidValidity,
          uid,
          messageIdHeader: parsed.messageId,
          fromAddress: parsed.from.address ?? "",
          subjectSummary: safeSummaryText(parsed.subject, 120),
          trustReason: trust.trustReason,
          allowReadBody: true,
          allowSaveAttachment,
          partId: args.partId ? String(args.partId) : null,
        };
        const proposal = store.propose(plan, "access", scope);
        const presentationFacts = [
          `收件箱放行预览 · 账号 ${accountId}`,
          `操作：单封授权读取${allowSaveAttachment ? "并保存附件" : "正文内容"}`,
          `发件人：${plan.fromAddress || "未知发件人"}（${trust.trustReason}）`,
          `邮件位置：${folder} / UID ${uid} / UIDVALIDITY ${uidValidity}`,
          `主题摘要：${plan.subjectSummary}`,
          "范围：仅当前这封邮件在 24 小时内有效，不修改长期发件人白名单",
        ];
        return {
          ok: true,
          status: "needs_confirmation",
          domain: MAIL_INBOX_DOMAIN,
          proposalId: proposal.proposalId,
          payloadHash: proposal.payloadHash,
          expiresAtUtc: proposal.expiresAtUtc,
          previewText: presentationFacts.join("\n"),
          presentationFacts,
          trustReason: trust.trustReason,
          authWarnings: parsed.authWarnings,
        };
      }

      if (action === "read") {
        if (!trust.canReadBody) {
          return {
            ok: true,
            action: "read",
            account: accountId,
            folder,
            uid,
            uidValidity,
            seen: fetched.raw.flags.some(f => f.toLowerCase() === "\\seen"),
            sizeBytes: fetched.raw.sizeBytes,
            from: parsed.from,
            to: parsed.to,
            cc: parsed.cc,
            subject: safeSummaryText(parsed.subject, 200),
            date: parsed.date,
            trusted: false,
            trustSource: trust.trustSource,
            trustReason: trust.trustReason,
            authWarnings: parsed.authWarnings,
            requiresAccessApproval: true,
            attachments: parsed.attachments.map(a => ({
              partId: a.partId,
              extension: a.safeExtension,
              sizeBytes: a.sizeBytes,
              contentType: a.contentType,
            })),
          };
        }
        return {
          ok: true,
          action: "read",
          account: accountId,
          folder,
          uid,
          uidValidity,
          seen: fetched.raw.flags.some(f => f.toLowerCase() === "\\seen"),
          sizeBytes: fetched.raw.sizeBytes,
          from: parsed.from,
          to: parsed.to,
          cc: parsed.cc,
          subject: safeSummaryText(parsed.subject, 200),
          date: parsed.date,
          trusted: true,
          trustSource: trust.trustSource,
          trustReason: trust.trustReason,
          authWarnings: parsed.authWarnings,
          bodyTruncated: parsed.bodyTruncated,
          bodyText: trust.trustSource === "allowlist" ? parsed.textBody : wrapUntrustedBody(parsed.textBody),
          attachments: parsed.attachments.map(a => ({
            partId: a.partId,
            filename: a.filename,
            extension: a.safeExtension,
            sizeBytes: a.sizeBytes,
            sha256: a.sha256,
            contentType: a.contentType,
          })),
        };
      }

      // action === "save_attachment"
      if (!trust.canSaveAttachment) {
        return {
          ok: false,
          code: trust.canReadBody ? "attachment_approval_required" : "sender_not_trusted",
          requiresAccessApproval: true,
          account: accountId,
          folder,
          uid,
          uidValidity,
          trustReason: trust.trustReason,
        };
      }
      if (!parsed.attachments.length) {
        return { ok: false, code: "no_attachments", message: "该邮件不含可保存的附件" };
      }
      const targetPartId = args.partId ? String(args.partId) : null;
      const targetAttachment = targetPartId
        ? parsed.attachments.find(a => a.partId === targetPartId)
        : parsed.attachments.length === 1
          ? parsed.attachments[0]
          : null;
      if (!targetAttachment) {
        return {
          ok: false,
          code: targetPartId ? "attachment_not_found" : "attachment_part_required",
          message: targetPartId ? `未找到 partId=${targetPartId} 的附件` : "邮件含多个附件，请指定 partId",
          attachments: parsed.attachments.map(a => ({ partId: a.partId, filename: a.filename, sizeBytes: a.sizeBytes })),
        };
      }

      const saved = stageAttachmentFile({
        filesConfig,
        stateRoot,
        folder,
        uidValidity,
        uid,
        attachment: targetAttachment,
        store,
        accountId,
      });
      try {
        emitTrace?.({
          source: "trace-events",
          kind: "mail.inbox.attachment_saved",
          correlation: { sessionId: ctx.sessionId, sessionKey: ctx.sessionKey, toolCallId: callId, ...(runId ? { runId } : {}) },
          data: {
            accountId,
            folder,
            uidValidity,
            uid,
            partId: saved.partId,
            sha256: saved.sha256,
            sizeBytes: saved.sizeBytes,
            alreadySaved: saved.alreadySaved,
          },
        });
      } catch { /* Non-fatal telemetry failure */ }
      return { ok: true, action: "save_attachment", account: accountId, folder, uid, uidValidity, ...saved };
    }

    if (action === "commit_access") {
      const proposal = store.getProposal(args.proposalId);
      if (!proposal) return { ok: false, code: "unknown_inbox_proposal" };
      if (proposal.plan.allowSaveAttachment || proposal.plan.partId) {
        assertOwnerContext(ctx, runtimeCfg, "mail.inbox.attachment");
      }
      const scope = requireConfirmationScope(ctx);
      const claimed = store.claimProposal(args.proposalId, "access", scope);
      if (!claimed.ok) return { ok: false, code: claimed.code, proposalId: args.proposalId };

      const plan = claimed.plan;
      let outcome;
      try {
        const fetched = await withImapClient(imapConfig, { readOnly: true, folder: plan.folder, connector: imapConnector }, async (client, mbox) => {
          if (Number(mbox.uidValidity ?? 0) !== Number(plan.uidValidity)) {
            throw new ImapError("uid_validity_mismatch", "邮箱 UIDVALIDITY 已变化，提案失效", { stage: "fetch" });
          }
          const raw = await client.uidFetchRaw(plan.uid);
          return { mailbox: mbox, raw };
        });
        const parsed = parseRawEmail(fetched.raw.rawBuffer, { includeAttachmentBytes: Boolean(plan.partId) });
        const grant = store.grantInboxAccess({
          accountId: plan.accountId,
          folder: plan.folder,
          uidValidity: plan.uidValidity,
          uid: plan.uid,
          messageIdHeader: parsed.messageId ?? plan.messageIdHeader,
          fromAddress: parsed.from.address ?? plan.fromAddress,
          allowReadBody: true,
          allowSaveAttachment: plan.allowSaveAttachment,
          proposalId: args.proposalId,
        });
        let savedAttachment = null;
        if (plan.partId) {
          const att = parsed.attachments.find(a => a.partId === String(plan.partId));
          if (!att) {
            throw new ImapError("attachment_not_found", `未找到 partId=${plan.partId} 的附件`, { stage: "attachment" });
          }
          savedAttachment = stageAttachmentFile({
            filesConfig,
            stateRoot,
            folder: plan.folder,
            uidValidity: plan.uidValidity,
            uid: plan.uid,
            attachment: att,
            store,
            accountId: plan.accountId,
          });
        }
        outcome = {
          grantId: grant.grantId,
          expiresAtUtc: grant.expiresAtUtc,
          allowSaveAttachment: plan.allowSaveAttachment,
          savedAttachmentPath: savedAttachment?.path ?? null,
        };
        store.finishProposal(args.proposalId, { state: "committed", result: outcome });
        try {
          emitTrace?.({
            source: "trace-events",
            kind: "mail.inbox.access_commit",
            correlation: {
              sessionId: ctx.sessionId, sessionKey: ctx.sessionKey, toolCallId: callId,
              ...(runId ? { runId } : {}), proposalId: args.proposalId,
            },
            data: {
              accountId: plan.accountId,
              folder: plan.folder,
              uidValidity: plan.uidValidity,
              uid: plan.uid,
              allowSaveAttachment: plan.allowSaveAttachment,
              ...(savedAttachment ? { savedSha256: savedAttachment.sha256, savedBytes: savedAttachment.sizeBytes } : {}),
            },
          });
        } catch { /* Non-fatal telemetry failure */ }
        return {
          ok: true,
          action: "commit_access",
          proposalId: args.proposalId,
          account: plan.accountId,
          folder: plan.folder,
          uid: plan.uid,
          uidValidity: plan.uidValidity,
          grant,
          bodyTruncated: parsed.bodyTruncated,
          bodyText: wrapUntrustedBody(parsed.textBody),
          attachments: parsed.attachments.map(a => ({
            partId: a.partId,
            filename: a.filename,
            extension: a.safeExtension,
            sizeBytes: a.sizeBytes,
            sha256: a.sha256,
            contentType: a.contentType,
          })),
          ...(savedAttachment ? { savedAttachment } : {}),
          ...(feedbackActions.has("mail.inbox.access")
            ? { feedback: businessFeedback("mail.inbox.access", "succeeded", { proposalId: args.proposalId, folder: plan.folder, uid: plan.uid }) }
            : {}),
        };
      } catch (error) {
        const code = error?.code ?? "inbox_access_failed";
        store.finishProposal(args.proposalId, { state: "failed", error: code });
        return { ok: false, action: "commit_access", proposalId: args.proposalId, code, message: String(error?.message ?? code).slice(0, 200) };
      }
    }

    if (action === "propose_manage") {
      const uid = Number(args.uid);
      if (!Number.isSafeInteger(uid) || uid < 1) return { ok: false, code: "invalid_uid", message: "需要正整数 uid" };
      const op = args.op;
      if (op !== "move" && op !== "trash") return { ok: false, code: "invalid_manage_op", message: "op 仅支持 move 或 trash" };
      if (op === "move" && (!args.targetFolder || typeof args.targetFolder !== "string" || !args.targetFolder.trim())) {
        return { ok: false, code: "target_folder_required", message: "op=move 必须提供 targetFolder" };
      }

      const info = await withImapClient(imapConfig, { readOnly: true, folder: null, connector: imapConnector }, async client => {
        const mailboxes = await client.listMailboxes();
        const resolvedTarget = op === "trash" ? findTrashFolderName(mailboxes) : String(args.targetFolder).trim();
        if (!resolvedTarget || !mailboxes.some(m => m.name === resolvedTarget && m.selectable)) {
          throw new ImapError("target_folder_unavailable", `目标文件夹不可用: ${resolvedTarget ?? "trash"}`, { stage: "manage" });
        }
        if (resolvedTarget === folder) {
          throw new ImapError("same_mailbox_move", "源文件夹与目标文件夹相同", { stage: "manage" });
        }
        const mbox = await client.selectMailbox(folder, { readOnly: true });
        if (args.uidValidity !== undefined && mbox.uidValidity !== args.uidValidity) {
          throw new ImapError("uid_validity_mismatch", "邮箱 UIDVALIDITY 已变化，请重新列出", { stage: "manage" });
        }
        const headers = await client.uidFetchHeaders([uid]);
        if (!headers.length) throw new ImapError("email_not_found", `未找到 UID=${uid}`, { stage: "manage" });
        const env = parseEnvelopeFromHeaders(headers[0].headerBuffer);
        return { uidValidity: mbox.uidValidity ?? 0, resolvedTarget, env };
      });
      ctx.assertInvocationCurrent?.();
      signal?.throwIfAborted();

      const scope = requireConfirmationScope(ctx);
      const plan = {
        accountId,
        op,
        folder,
        uidValidity: info.uidValidity,
        uid,
        targetFolder: info.resolvedTarget,
        fromAddress: info.env.from.address ?? "",
        subjectSummary: safeSummaryText(info.env.subject, 120),
      };
      const proposal = store.propose(plan, "manage", scope);
      const presentationFacts = [
        `收件箱整理预览 · 账号 ${accountId}`,
        `操作：${op === "trash" ? `移入已删除箱（${plan.targetFolder}）` : `移动到文件夹「${plan.targetFolder}」`}`,
        `原邮件：${folder} / UID ${uid} / UIDVALIDITY ${info.uidValidity}`,
        `发件人与主题：${plan.fromAddress || "未知发件人"} · ${plan.subjectSummary}`,
        "安全边界：仅复制并标记 \\Deleted，不执行物理 EXPUNGE",
      ];
      return {
        ok: true,
        status: "needs_confirmation",
        domain: MAIL_INBOX_DOMAIN,
        proposalId: proposal.proposalId,
        payloadHash: proposal.payloadHash,
        expiresAtUtc: proposal.expiresAtUtc,
        previewText: presentationFacts.join("\n"),
        presentationFacts,
      };
    }

    // action === "commit_manage"
    const proposal = store.getProposal(args.proposalId);
    if (!proposal) return { ok: false, code: "unknown_inbox_proposal" };
    if (proposal.kind !== "manage") return { ok: false, code: "inbox_proposal_kind_mismatch" };
    const scope = requireConfirmationScope(ctx);

    // Pre-verify mailbox UIDVALIDITY & UID existence before consuming confirmation grant.
    await withImapClient(imapConfig, { readOnly: true, folder: proposal.plan.folder, connector: imapConnector }, async (client, mbox) => {
      if (Number(mbox.uidValidity ?? 0) !== Number(proposal.plan.uidValidity)) {
        throw new ImapError("uid_validity_mismatch", "邮箱 UIDVALIDITY 已变化，请重新生成整理预览", { stage: "manage" });
      }
      const meta = await client.uidFetchMeta(proposal.plan.uid);
      if (!meta) throw new ImapError("email_not_found", `未找到 UID=${proposal.plan.uid}`, { stage: "manage" });
    });

    const claimed = store.claimProposal(args.proposalId, "manage", scope);
    if (!claimed.ok) return { ok: false, code: claimed.code, proposalId: args.proposalId };

    const plan = claimed.plan;
    try {
      await withImapClient(imapConfig, { readOnly: false, folder: plan.folder, connector: imapConnector }, async (client, mbox) => {
        if (Number(mbox.uidValidity ?? 0) !== Number(plan.uidValidity)) {
          throw new ImapError("uid_validity_mismatch", "邮箱 UIDVALIDITY 在提交前变化", { stage: "manage" });
        }
        await client.uidCopyAndMarkDeleted(plan.uid, plan.targetFolder);
      });
      const result = {
        op: plan.op,
        folder: plan.folder,
        uid: plan.uid,
        uidValidity: plan.uidValidity,
        targetFolder: plan.targetFolder,
        expunged: false,
      };
      store.finishProposal(args.proposalId, { state: "committed", result });
      store.audit(`manage_${plan.op}`, result, plan.accountId);
      try {
        emitTrace?.({
          source: "trace-events",
          kind: "mail.inbox.manage_commit",
          correlation: {
            sessionId: ctx.sessionId, sessionKey: ctx.sessionKey, toolCallId: callId,
            ...(runId ? { runId } : {}), proposalId: args.proposalId,
          },
          data: {
            accountId: plan.accountId,
            op: plan.op,
            folder: plan.folder,
            uidValidity: plan.uidValidity,
            uid: plan.uid,
            targetFolder: plan.targetFolder,
            expunged: false,
          },
        });
      } catch { /* Non-fatal telemetry failure */ }
      return {
        ok: true,
        action: "commit_manage",
        proposalId: args.proposalId,
        ...result,
        ...(feedbackActions.has("mail.inbox.manage")
          ? { feedback: businessFeedback("mail.inbox.manage", "succeeded", { proposalId: args.proposalId, ...result }) }
          : {}),
      };
    } catch (error) {
      const code = error?.code ?? "inbox_manage_failed";
      const uncertain = code === "imap_connection_closed" || code === "imap_timeout";
      store.finishProposal(args.proposalId, { state: uncertain ? "unknown" : "failed", error: code });
      return {
        ok: false,
        action: "commit_manage",
        proposalId: args.proposalId,
        code,
        message: String(error?.message ?? code).slice(0, 200),
        ...(feedbackActions.has("mail.inbox.manage")
          ? { feedback: businessFeedback("mail.inbox.manage", uncertain ? "unknown" : "failed", { proposalId: args.proposalId, code }) }
          : {}),
      };
    }
  } finally {
    store.close();
  }
}
