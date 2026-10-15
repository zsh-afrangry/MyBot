// Confirmation wording is a bounded protocol, not a domain intent classifier.
import { createHash } from "node:crypto";

const MAX_CONFIRMATION_CONTENT_LENGTH = 2000;
/**
 * Owner confirmations arrive as natural language, so the identifiers must be
 * extracted from within a sentence rather than matched against the whole
 * message. Both patterns use token boundaries instead of string anchors so a
 * longer hex run or an adjacent identifier can never yield a partial match.
 */
const UUID_IN_TEXT_PATTERN =
  /(?<![0-9a-f-])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f-])/iu;
const HASH_IN_TEXT_PATTERN = /(?<![a-f0-9])[a-f0-9]{64}(?![a-f0-9])/iu;

/**
 * Extract the confirmed proposal identity from an owner message.
 *
 * Both `proposalId` and `payloadHash` are required. A bare "确认" is therefore
 * never a valid confirmation: it cannot identify which proposal it approves,
 * and multiple pending proposals across domains is the normal case rather than
 * the exception. Both identifiers remain bound, either in full or via the short code.
 * Bare agreement never identifies a proposal; matching must be unique.
 */
export function parseConfirmationText(content: string): { proposalId: string; payloadHash: string } | { shortCode: string } | undefined {
  const normalized = normalizedContent(content);
  if (!normalized || normalized.length > MAX_CONFIRMATION_CONTENT_LENGTH) return undefined;
  if (/(?:不确认|不要确认|取消确认|拒绝|不要提交)/u.test(normalized)) return undefined;
  // The affirmative marker only needs to open the message. Requiring a
  // separator after it rejected legitimate phrasings such as "我确认变更 …",
  // where the verb is followed directly by its object.
  if (!/^(?:我\s*)?(?:确认|同意|批准|可以|执行|提交|yes|ok|好的?)/iu.test(normalized)) {
    return undefined;
  }
  const short = normalized.match(/^确认\s+([a-f0-9]{12})$/iu);
  if (short?.[1]) return { shortCode: short[1].toLowerCase() };
  const ids = [...normalized.matchAll(new RegExp(UUID_IN_TEXT_PATTERN.source, "giu"))];
  const hashes = [...normalized.matchAll(new RegExp(HASH_IN_TEXT_PATTERN.source, "giu"))];
  if (ids.length !== 1 || hashes.length !== 1) return undefined;
  const proposalId = ids[0]?.[0]?.toLowerCase();
  const payloadHash = hashes[0]?.[0]?.toLowerCase();
  if (proposalId === undefined || payloadHash === undefined) return undefined;
  return { proposalId, payloadHash };
}

/**
 * The one confirmation wording the parser is guaranteed to accept.
 *
 * Both the proposal preview and the `approval_required` failure message render
 * this, so the format the owner is shown can never drift from the format the
 * parser accepts. Nothing else may define a confirmation protocol: LIVE-07-A
 * failed because the model invented its own wording, which the parser rejected.
 */
export function buildConfirmationInstruction(proposalId: string, payloadHash: string): string {
  return `确认 ${confirmationCode(proposalId, payloadHash)}`;
}

export function confirmationCode(proposalId: string, payloadHash: string): string {
  return createHash("sha256").update(proposalId.toLowerCase() + ":" + payloadHash.toLowerCase()).digest("hex").slice(0, 12);
}

export function normalizedContent(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").replace(/\s+/gu, " ").trim();
}
