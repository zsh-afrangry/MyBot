export type ConfirmationDomain = string;

export type ConfirmationProposalStatus = "pending" | "committed" | "expired" | "cancelled";

export type ConfirmationGrantStatus = "pending" | "consumed" | "expired" | "rejected";

export interface ConfirmationScope {
  /** The strongest runtime correlation available for this conversation. */
  primary: string;
  /** Delivery/conversation aliases used when the host omits a session key. */
  delivery: string[];
}

export interface ConfirmationInboundEvent {
  channel: string;
  accountId?: string;
  conversationId?: string;
  senderId?: string;
  sessionKey?: string;
  messageId?: string;
  content: string;
  timestamp?: number;
  replyToIsQuote?: boolean;
  replyToMessageId?: string;
  metadata?: Record<string, unknown>;
  isGroup: boolean;
  senderIsOwner?: boolean;
}

export interface ConfirmationToolContext {
  messageChannel?: string;
  deliveryContext?: { channel?: string; to?: string; accountId?: string };
  requesterSenderId?: string;
  senderIsOwner?: boolean;
  sessionKey?: string;
}

export interface ConfirmationProposalRow {
  proposalId: string;
  domain: ConfirmationDomain;
  actionKind: string;
  subjectId: string;
  payloadHash: string;
  scope: ConfirmationScope;
  status: ConfirmationProposalStatus;
  createdAtUtc: number;
  expiresAtUtc: number;
}

export interface NaturalConfirmationSelection {
  proposalId: string;
  payloadHash: string;
  domain: string;
}

export interface ConfirmationPreview extends ConfirmationProposalRow {
  previewText: string | null;
  presentationFacts?: string[];
  sourceMessageId: string | null;
  presentedAtUtc: number | null;
  presentationMessageId: string | null;
  /** Durable presentation batch order; older/custom backends may omit it. */
  presentationOrder?: number | null;
}

/** Domain-owned persistence; transport hooks can save previews, never approvals. */
export interface NaturalConfirmationBackend {
  /** Explicit opt-in; independent domain transactions, never a cross-store transaction. */
  supportsBatch?: boolean;
  list(event: ConfirmationInboundEvent): ConfirmationPreview[];
  used(event: ConfirmationInboundEvent): NaturalConfirmationSelection[];
  savePreview(event: ConfirmationInboundEvent, selection: NaturalConfirmationSelection, text: string, facts?: string[]): boolean;
  presented(event: ConfirmationInboundEvent, selection: NaturalConfirmationSelection, messageId: string, order?: number): boolean;
  confirm(event: ConfirmationInboundEvent, selection: NaturalConfirmationSelection): boolean;
}

export interface NaturalConfirmationResult {
  ok: boolean;
  code?: string;
  idempotent?: boolean;
}

export type ConfirmationGrantCheck =
  | { ok: true; grantId: string }
  | { ok: false; code: "approval_required" | "grant_expired" | "grant_replayed" | "confirmation_context_mismatch" };
