export function readQqCronFeedback(stateDir: string, runId: string, peer: string): Array<{
  action: 'qq.cron_text';
  runId: string;
  messageId: string | null;
  deliveryKey: string;
  part: number;
  parts: number;
  platformStatus: 'accepted' | 'rejected' | 'unknown' | 'not_attempted';
  recipientStatus: 'acknowledged' | 'unverified';
  clientDelivery: 'unknown';
  readStatus: 'unknown';
  receiptId?: string;
  receiptSource?: string;
  recordedAt?: string;
}>;
