/**
 * Synchronous domain contracts for kurumi-mail.
 *
 * The adapter registry requires synchronous methods on both sides, which is why delivery (an async
 * SMTP conversation) lives in the service layer and never appears here: the Store only stores and
 * records, and every method below returns a value rather than a Promise.
 *
 * Transport identity is NOT part of Policy. Whether the caller is the owner in a private chat is
 * decided in inbound.js before a policy is consulted, so a replacement policy cannot mint identity.
 */

/** Everything a draft would put on the wire; the payload hash covers exactly this. */
export interface DraftInput {
  to: string[];
  cc?: string[];
  subject: string;
  text: string;
  attachments?: Array<{filename: string; content: string | Uint8Array; contentType?: string}>;
}

/** Draft arguments as they arrive from a tool call, before normalisation. */
export interface DraftCommand {
  to?: unknown;
  cc?: unknown;
  subject?: unknown;
  text?: unknown;
  /** Accepted alias for `text`; models reach for it at least as often. */
  body?: unknown;
}

/**
 * `problem` is set instead of throwing so a tool can answer with a fixable message.
 * A schema rejection never reaches this layer and costs the model an entire turn.
 */
export interface NormalizedDraft {
  to?: string[];
  cc?: string[];
  subject?: string;
  text?: string;
  problem?: string;
}

export interface NormalizedSend {
  draftId?: string;
  problem?: string;
}

export interface NormalizedOutbox {
  action?: 'list' | 'audit' | 'cancel';
  draftId?: string;
  limit?: number;
  problem?: string;
}

export interface Policy {
  normalizeDraft(args: DraftCommand): NormalizedDraft;
  normalizeSend(args: object): NormalizedSend;
  normalizeOutbox(args: object): NormalizedOutbox;
  /** Throws MailPolicyError when a recipient is outside the allowlist, or the allowlist is empty. */
  assertRecipientsAllowed(recipients: string[], allowlist: string[]): void;
}

export interface StoreOptions {
  stateDirectory: string;
  /** Fail-closed: an empty list permits no recipient at all. */
  allowedRecipients?: string[];
}

export interface Draft {
  draftId: string;
  payloadHash: string;
  to: string[];
  cc: string[];
  subject: string;
  text: string;
  attachments: Array<{filename: string; contentType: string}>;
  status: 'pending' | 'sent' | 'failed' | 'cancelled';
  createdAtUtc: number;
  expiresAtUtc: number;
  sentAtUtc?: number;
  messageId?: string;
  lastError?: string;
}

export interface AuditEntry {
  atUtc: number;
  action: string;
  draftId?: string;
  detail: object;
}

export type GrantCheck =
  | {ok: true; grantId: string}
  | {ok: false; code: string};

export interface Store {
  /** Current time in Unix seconds; the tables store seconds, never milliseconds. */
  nowUtc(): number;
  close(): void;

  createDraft(input: DraftInput, scope: object): {draftId: string; payloadHash: string; instruction: string; expiresAtUtc: number};
  getDraft(draftId: string): Draft | undefined;
  listDrafts(args?: {status?: string; limit?: number}): Draft[];
  listAudit(args?: {limit?: number}): AuditEntry[];

  /** Consumes the owner's approval for exactly this draft content. */
  consumeApproval(args: {draftId: string; scope: object}): GrantCheck;
  markSent(draftId: string, args: {messageId: string; response?: string}): void;
  markFailed(draftId: string, error: object): void;
  cancelDraft(draftId: string): boolean;

  /**
   * Confirmation-backend surface. The host's inbound router calls these directly, so they are part
   * of the contract a replacement store must also satisfy.
   */
  listInboundConfirmationCandidates(event: object): object[];
  recordInboundConfirmation(event: object, expectedProposalId?: string): boolean;
}
