import type { DatabaseSync } from 'node:sqlite';
import type { ConfirmationInboundEvent, ConfirmationPreview, NaturalConfirmationBackend, NaturalConfirmationSelection } from './types.js';
import { listPendingConfirmationProposals, issueApprovalGrant } from './store.js';
import { scopeFromInboundEvent, scopesMatch } from './scope.js';
import { ensureConfirmationGateSchema } from './schema.js';

/** The owning domain supplies the DB and transaction; no business tables are read here. */
export function createNaturalConfirmationBackend(db: DatabaseSync, options: {
  subjectId: string; domains: readonly string[]; now?: () => number;
}): NaturalConfirmationBackend {
  const now = () => Math.floor(options.now?.() ?? Date.now() / 1000);
  const selected = (row: ConfirmationPreview, choice: NaturalConfirmationSelection) => row.domain === choice.domain
    && row.proposalId === choice.proposalId && row.payloadHash === choice.payloadHash;
  const list = (event: ConfirmationInboundEvent): ConfirmationPreview[] => {
    const scope = scopeFromInboundEvent(event);
    if (!scope) return [];
    return listPendingConfirmationProposals(db, {subjectId: options.subjectId, scope, nowUtc: now()})
      .filter(p => options.domains.includes(p.domain)).map(p => {
        const preview = db.prepare('SELECT * FROM confirmation_previews WHERE proposal_id = ? AND payload_hash = ?')
          .get(p.proposalId, p.payloadHash) as {preview_text: string; source_message_id: string;
            presented_at_utc: number | null; presentation_message_id: string | null} | undefined;
        return {...p, previewText: preview?.preview_text ?? null, sourceMessageId: preview?.source_message_id ?? null,
          presentedAtUtc: preview?.presented_at_utc ?? null, presentationMessageId: preview?.presentation_message_id ?? null};
      });
  };
  ensureConfirmationGateSchema(db);
  return {
    list,
    used(event) {
      const scope = scopeFromInboundEvent(event);
      if (!scope || !event.messageId) return [];
      return (db.prepare(`SELECT proposal_id, payload_hash, domain, scope_json FROM approval_grants
        WHERE subject_id = ? AND confirmation_message_id = ?`).all(options.subjectId, event.messageId) as Array<{
          proposal_id: string; payload_hash: string; domain: string; scope_json: string;
        }>).filter(r => options.domains.includes(r.domain) && scopesMatch(JSON.parse(r.scope_json), scope))
        .map(r => ({proposalId: r.proposal_id, payloadHash: r.payload_hash, domain: r.domain}));
    },
    savePreview(event, choice, text) {
      if (!event.messageId || typeof text !== 'string' || !text.trim() || text.length > 120000
        || !list(event).some(p => selected(p, choice))) return false;
      db.prepare(`INSERT INTO confirmation_previews (proposal_id, payload_hash, preview_text, source_message_id)
        VALUES (?, ?, ?, ?) ON CONFLICT(proposal_id) DO UPDATE SET payload_hash = excluded.payload_hash,
        preview_text = excluded.preview_text, source_message_id = excluded.source_message_id,
        presented_at_utc = NULL, presentation_message_id = NULL`).run(choice.proposalId, choice.payloadHash, text, event.messageId);
      return true;
    },
    presented(event, choice, messageId) {
      if (!messageId || !list(event).some(p => selected(p, choice) && p.sourceMessageId === event.messageId)) return false;
      return Number(db.prepare(`UPDATE confirmation_previews SET presented_at_utc = ?, presentation_message_id = ?
        WHERE proposal_id = ? AND payload_hash = ? AND source_message_id = ?`)
        .run(now(), messageId, choice.proposalId, choice.payloadHash, event.messageId!).changes) === 1;
    },
    confirm(event, choice) {
      const scope = scopeFromInboundEvent(event);
      if (!scope || !event.messageId || !Number.isFinite(event.timestamp)) return false;
      const messageTime = Math.floor(event.timestamp! > 10000000000 ? event.timestamp! / 1000 : event.timestamp!);
      db.exec('BEGIN IMMEDIATE');
      try {
        const proposal = list(event).find(p => selected(p, choice));
        if (!proposal || proposal.presentedAtUtc === null || proposal.presentedAtUtc > messageTime
          || proposal.sourceMessageId === event.messageId) { db.exec('COMMIT'); return false; }
        const result = issueApprovalGrant(db, {proposal, confirmationMessageId: event.messageId,
          confirmationContent: event.content, scope, nowUtc: now()});
        if (result.ok) db.prepare(`INSERT OR IGNORE INTO natural_confirmation_grants
          (grant_id, confirmation_message_id) VALUES (?, ?)`).run(result.grantId, event.messageId);
        db.exec('COMMIT');
        return result.ok;
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
  };
}

/** Profile and planning share a historical DB, but never own each other's proposals. */
export function narrowNaturalConfirmationBackend(backend: NaturalConfirmationBackend, domain: string): NaturalConfirmationBackend {
  return {
    list: event => backend.list(event).filter(p => p.domain === domain),
    used: event => backend.used(event).filter(p => p.domain === domain),
    savePreview: (event, choice, text) => choice.domain === domain && backend.savePreview(event, choice, text),
    presented: (event, choice, id) => choice.domain === domain && backend.presented(event, choice, id),
    confirm: (event, choice) => choice.domain === domain && backend.confirm(event, choice),
  };
}
