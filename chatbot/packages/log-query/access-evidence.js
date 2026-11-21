import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';

export function readAccessEvidence(runtimeRoot, peer) {
  const file = join(runtimeRoot,'state','access-admin','changes.sqlite');
  const source = {source:'access-admin'};
  if (!existsSync(file)) return {source:{...source,status:'missing'}, proposals:[], grants:[]};
  let db;
  try {
    db = new DatabaseSync(file,{readOnly:true});
    db.exec('PRAGMA busy_timeout=2000; BEGIN');
    const proposals = db.prepare(`
      SELECT c.id, c.state, c.error, c.updated_at, p.created_at_utc, p.action_kind,
        v.source_message_id, v.presentation_message_id, v.presented_at_utc,
        json_extract(c.plan, '$.baseRevision') AS base_revision
      FROM access_changes c JOIN confirmation_proposals p ON p.proposal_id=c.id
      LEFT JOIN confirmation_previews v ON v.proposal_id=c.id AND v.payload_hash=p.payload_hash
      WHERE c.owner_qq=? AND p.domain='access' AND p.subject_id='owner'
        AND coalesce(json_extract(c.plan, '$.category'),'member')='member'
    `).all(peer);
    const grants = db.prepare(`
      SELECT g.grant_id, g.proposal_id, g.confirmation_message_id, g.issued_at_utc, g.status, g.consumed_at_utc
      FROM approval_grants g JOIN confirmation_proposals p
        ON p.proposal_id=g.proposal_id AND p.payload_hash=g.payload_hash
      JOIN access_changes c ON c.id=g.proposal_id
      WHERE c.owner_qq=? AND g.domain='access' AND g.subject_id='owner'
      ORDER BY g.issued_at_utc, g.grant_id
    `).all(peer);
    db.exec('COMMIT');
    return {source:{...source,status:'available'}, proposals, grants};
  } catch {
    return {source:{...source,status:'read_failed'}, proposals:[], grants:[]};
  } finally { db?.close(); }
}

export function accessLedgerStages(proposal, grants) {
  const preview = {
    at:new Date(1000*(proposal.presented_at_utc ?? proposal.created_at_utc)).toISOString(),
    status:proposal.presented_at_utc == null ? 'registered' : 'presented',
    ...(proposal.source_message_id && {sourceMessageId:proposal.source_message_id}),
    ...(proposal.presentation_message_id && {messageId:proposal.presentation_message_id}),
    sourceRef:{source:'access-admin',table:proposal.source_message_id ? 'confirmation_previews' : 'confirmation_proposals',id:proposal.id},
  };
  const confirmations = grants.map(grant => ({
    at:new Date(1000*grant.issued_at_utc).toISOString(), status:grant.status,
    sourceMessageId:grant.confirmation_message_id,
    ...(grant.consumed_at_utc != null && {consumedAt:new Date(1000*grant.consumed_at_utc).toISOString()}),
    sourceRef:{source:'access-admin',table:'approval_grants',id:grant.grant_id},
  }));
  const write = {
    at:new Date(1000*proposal.updated_at).toISOString(), status:proposal.state==='writing' ? 'unknown' : proposal.state,
    ...(proposal.state==='written' && Number.isSafeInteger(proposal.base_revision) && {sourceRevision:proposal.base_revision+1}),
    ...(proposal.error && {code:proposal.error}),
    sourceRef:{source:'access-admin',table:'access_changes',id:proposal.id},
  };
  return {preview, confirmations, write};
}
