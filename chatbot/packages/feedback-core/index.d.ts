export function observeFeedback(action: string, log: {warn?: (line: string) => void} | undefined, record: () => void): void;

export function notificationFeedback(input: {
  action: string;
  platformStatus: string;
  acknowledgement?: {id: string; source: string; at: number} | null;
}): {
  action: string;
  platformStatus: string;
  recipientStatus: 'acknowledged' | 'unverified';
  clientDelivery: 'unknown';
  readStatus: 'unknown';
  receiptId?: string;
  receiptSource?: string;
  recordedAt?: string;
};

export function businessFeedback<Action extends string, Status extends string, Evidence>(
  action: Action, status: Status, evidence: Evidence,
): {action: Action; status: Status; evidence: Evidence};
