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

export type ConfirmationGrantCheck =
  | { ok: true; grantId: string }
  | { ok: false; code: "approval_required" | "grant_expired" | "grant_replayed" | "confirmation_context_mismatch" };
