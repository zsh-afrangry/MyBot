import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const REMINDER_SUBJECT_ID = "owner";
export const REMINDER_TIMEZONE = "Asia/Shanghai";
export const REMINDER_MAX_ATTEMPTS = 3;
export const REMINDER_RETRY_LEASE_SECONDS = 120;
export const REMINDER_RETRY_BACKOFF_SECONDS = [60, 300] as const;

const DATABASE_FILE_NAME = "reminders.sqlite";

export type ReminderStatus =
  | "scheduling"
  | "scheduled"
  | "delivering"
  | "delivered"
  | "cancelled"
  | "failed";

export type ReminderRetryStatus =
  | "scheduling"
  | "scheduled"
  | "pending"
  | "delivered"
  | "cancelled"
  | "exhausted"
  | "unknown";

export type ReminderProposalKind = "reminder_create" | "reminder_cancel" | "reminder_update";
export type ReminderProposalStatus = "pending" | "committed" | "expired" | "cancelled";

export interface ReminderDelivery {
  channel: "qqbot";
  to: string;
  accountId: string | null;
}

export interface StoredReminderProposal {
  proposalId: string;
  kind: ReminderProposalKind;
  status: ReminderProposalStatus;
  payloadJson: string;
  payloadHash: string;
  requestContextHash: string;
  delivery: ReminderDelivery;
  expiresAtUtc: number;
  resultReminderId: string | null;
}

export interface StoredReminder {
  reminderId: string;
  status: ReminderStatus;
  content: string;
  scheduledAtUtc: number;
  timezone: string;
  delivery: ReminderDelivery;
  cronJobId: string | null;
  eventKey: string;
  createdAtUtc: number;
  updatedAtUtc: number;
  dispatchedAtUtc: number | null;
  deliveredAtUtc: number | null;
  cancelledAtUtc: number | null;
  failureCode: string | null;
}

export interface ReminderRetryAttempt {
  reminder: StoredReminder;
  attemptCount: number;
  declarationKey: string;
}

export interface ReminderSummary {
  reminderId: string;
  status: ReminderStatus;
  content: string;
  scheduledAtUtc: number;
  timezone: string;
  dispatchedAtUtc: number | null;
  failureCode: string | null;
  retryStatus: ReminderRetryStatus;
  attemptCount: number;
  nextRetryAtUtc: number | null;
}

export interface ReminderStoreOptions {
  stateDirectory: string;
  now?: () => number;
}

/**
 * SQLite-only persistence adapter for personal reminders. Scheduling policy and
 * Gateway calls deliberately live above this class so it does not become a
 * transport or business-policy god object.
 */
export class ReminderStore {
  readonly stateDirectory: string;
  readonly databasePath: string;

  #database: DatabaseSync;
  #closed = false;
  #now: () => number;

  constructor(options: ReminderStoreOptions) {
    this.stateDirectory = prepareStateDirectory(options.stateDirectory);
    this.databasePath = join(this.stateDirectory, DATABASE_FILE_NAME);
    this.#now = options.now ?? currentUnixSeconds;
    prepareDatabaseFile(this.databasePath);
    this.#database = new DatabaseSync(this.databasePath);

    try {
      this.#database.exec("PRAGMA foreign_keys = ON");
      this.#database.exec("PRAGMA journal_mode = WAL");
      this.#database.exec("PRAGMA synchronous = NORMAL");
      this.#database.exec("PRAGMA busy_timeout = 5000");
      this.#database.exec("PRAGMA secure_delete = ON");
      this.#database.exec("PRAGMA temp_store = MEMORY");
      this.#database.exec(INITIAL_SCHEMA_SQL);
      migrateReminderProposalKinds(this.#database);
      this.#database.exec(RETRY_MIGRATION_SQL);
      chmodSync(this.databasePath, 0o600);
    } catch (error) {
      this.#database.close();
      this.#closed = true;
      throw error;
    }
  }

  close(): void {
    if (!this.#closed) {
      this.#database.close();
      this.#closed = true;
    }
  }

  getNowUtc(): number {
    this.#assertOpen();
    return normalizeUnixSeconds(this.#now());
  }

  createPendingProposal(input: {
    proposalId: string;
    kind: ReminderProposalKind;
    payloadJson: string;
    payloadHash: string;
    requestContextHash: string;
    delivery: ReminderDelivery;
    expiresAtUtc: number;
    atUtc: number;
  }): void {
    this.#assertOpen();
    this.#database.prepare(`
      INSERT INTO reminder_proposals (
        proposal_id, subject_id, kind, status, payload_json, payload_hash,
        request_context_hash, delivery_channel, delivery_to, delivery_account_id,
        expires_at_utc, created_at_utc, updated_at_utc
      ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.proposalId,
      REMINDER_SUBJECT_ID,
      input.kind,
      input.payloadJson,
      input.payloadHash,
      input.requestContextHash,
      input.delivery.channel,
      input.delivery.to,
      input.delivery.accountId,
      input.expiresAtUtc,
      input.atUtc,
      input.atUtc,
    );
  }

  getProposal(proposalId: string): StoredReminderProposal | undefined {
    this.#assertOpen();
    const row = this.#database.prepare(`
      SELECT proposal_id, kind, status, payload_json, payload_hash, request_context_hash,
             delivery_channel, delivery_to, delivery_account_id, expires_at_utc,
             result_reminder_id
      FROM reminder_proposals
      WHERE proposal_id = ? AND subject_id = ?
      LIMIT 1
    `).get(proposalId, REMINDER_SUBJECT_ID) as ReminderProposalRow | undefined;
    return row ? mapProposal(row) : undefined;
  }

  expireProposal(proposalId: string, atUtc: number): boolean {
    this.#assertOpen();
    return Number(this.#database.prepare(`
      UPDATE reminder_proposals
      SET status = 'expired', updated_at_utc = ?
      WHERE proposal_id = ? AND subject_id = ? AND status = 'pending'
    `).run(atUtc, proposalId, REMINDER_SUBJECT_ID).changes) === 1;
  }

  createSchedulingReminder(input: {
    reminderId: string;
    content: string;
    scheduledAtUtc: number;
    timezone: string;
    delivery: ReminderDelivery;
    eventKey: string;
    proposalId: string;
    payloadHash: string;
    atUtc: number;
  }): boolean {
    this.#assertOpen();
    return this.#transaction(() => {
      const inserted = this.#database.prepare(`
        INSERT INTO reminders (
          reminder_id, subject_id, status, content, scheduled_at_utc, timezone,
          delivery_channel, delivery_to, delivery_account_id, event_key,
          created_at_utc, updated_at_utc
        ) VALUES (?, ?, 'scheduling', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.reminderId,
        REMINDER_SUBJECT_ID,
        input.content,
        input.scheduledAtUtc,
        input.timezone,
        input.delivery.channel,
        input.delivery.to,
        input.delivery.accountId,
        input.eventKey,
        input.atUtc,
        input.atUtc,
      );
      if (Number(inserted.changes) !== 1) return false;

      this.#database.prepare(`
        INSERT INTO reminder_retry_state (
          reminder_id, retry_status, attempt_count, declaration_key, updated_at_utc
        ) VALUES (?, 'scheduling', 1, ?, ?)
      `).run(input.reminderId, input.eventKey, input.atUtc);

      const committed = this.#database.prepare(`
        UPDATE reminder_proposals
        SET status = 'committed', result_reminder_id = ?, committed_at_utc = ?, updated_at_utc = ?
        WHERE proposal_id = ?
          AND subject_id = ?
          AND kind = 'reminder_create'
          AND status = 'pending'
          AND payload_hash = ?
          AND expires_at_utc > ?
      `).run(
        input.reminderId,
        input.atUtc,
        input.atUtc,
        input.proposalId,
        REMINDER_SUBJECT_ID,
        input.payloadHash,
        input.atUtc,
      );
      if (Number(committed.changes) !== 1) {
        throw new Error("Reminder proposal changed while being committed");
      }
      this.insertAudit({
        action: "reminder.scheduling",
        entityType: "reminder",
        entityId: input.reminderId,
        proposalId: input.proposalId,
        summary: { scheduledAtUtc: input.scheduledAtUtc },
        atUtc: input.atUtc,
      });
      return true;
    });
  }

  markReminderScheduled(input: { reminderId: string; cronJobId: string; atUtc: number }): boolean {
    this.#assertOpen();
    const changed = this.#transaction(() => {
      const updated = Number(this.#database.prepare(`
        UPDATE reminders
        SET status = 'scheduled', cron_job_id = ?, updated_at_utc = ?, failure_code = NULL
        WHERE reminder_id = ? AND subject_id = ? AND status = 'scheduling'
      `).run(input.cronJobId, input.atUtc, input.reminderId, REMINDER_SUBJECT_ID).changes) === 1;
      if (!updated) return false;
      this.#database.prepare(`
        UPDATE reminder_retry_state
        SET retry_status = 'scheduled', lease_until_utc = NULL, next_retry_at_utc = NULL,
            updated_at_utc = ?
        WHERE reminder_id = ? AND retry_status = 'scheduling'
      `).run(input.atUtc, input.reminderId);
      return true;
    });
    if (changed) {
      this.insertAudit({
        action: "reminder.scheduled",
        entityType: "reminder",
        entityId: input.reminderId,
        proposalId: null,
        summary: { cronRegistered: true },
        atUtc: input.atUtc,
      });
    }
    return changed;
  }

  markReminderFailed(input: { reminderId: string; code: string; atUtc: number }): boolean {
    this.#assertOpen();
    const changed = this.#transaction(() => {
      const updated = Number(this.#database.prepare(`
        UPDATE reminders
        SET status = 'failed', failure_code = ?, updated_at_utc = ?
        WHERE reminder_id = ? AND subject_id = ? AND status IN ('scheduling', 'scheduled', 'delivering')
      `).run(input.code, input.atUtc, input.reminderId, REMINDER_SUBJECT_ID).changes) === 1;
      if (!updated) return false;
      this.scheduleRetryAfterDefiniteFailure(input.reminderId, input.code, input.atUtc);
      return true;
    });
    if (changed) {
      this.insertAudit({
        action: "reminder.failed",
        entityType: "reminder",
        entityId: input.reminderId,
        proposalId: null,
        summary: { code: input.code },
        atUtc: input.atUtc,
      });
    }
    return changed;
  }

  /** Mark scheduler registration as uncertain; this state is never auto-retried. */
  markReminderSchedulingUnknown(input: { reminderId: string; code: string; atUtc: number }): boolean {
    this.#assertOpen();
    const changed = this.#transaction(() => {
      const updated = Number(this.#database.prepare(`
        UPDATE reminders
        SET status = 'failed', failure_code = ?, updated_at_utc = ?
        WHERE reminder_id = ? AND subject_id = ? AND status = 'scheduling'
      `).run(input.code, input.atUtc, input.reminderId, REMINDER_SUBJECT_ID).changes) === 1;
      if (!updated) return false;
      this.#database.prepare(`
        UPDATE reminder_retry_state
        SET retry_status = 'unknown', next_retry_at_utc = NULL, lease_until_utc = NULL,
            last_failure_code = ?, updated_at_utc = ?
        WHERE reminder_id = ?
      `).run(input.code, input.atUtc, input.reminderId);
      return true;
    });
    if (changed) {
      this.insertAudit({
        action: "reminder.scheduling_unknown",
        entityType: "reminder",
        entityId: input.reminderId,
        proposalId: null,
        summary: { code: input.code, retry: "blocked_unknown" },
        atUtc: input.atUtc,
      });
    }
    return changed;
  }

  markReminderDelivered(input: { reminderId: string; atUtc: number }): boolean {
    this.#assertOpen();
    const changed = this.#transaction(() => {
      const updated = Number(this.#database.prepare(`
        UPDATE reminders
        SET status = 'delivered', delivered_at_utc = ?, updated_at_utc = ?, failure_code = NULL
        WHERE reminder_id = ? AND subject_id = ? AND status = 'delivering'
      `).run(input.atUtc, input.atUtc, input.reminderId, REMINDER_SUBJECT_ID).changes) === 1;
      if (!updated) return false;
      this.#database.prepare(`
        UPDATE reminder_retry_state
        SET retry_status = 'delivered', lease_until_utc = NULL, next_retry_at_utc = NULL,
            updated_at_utc = ?
        WHERE reminder_id = ?
      `).run(input.atUtc, input.reminderId);
      return true;
    });
    if (changed) {
      this.insertAudit({
        action: "reminder.delivered",
        entityType: "reminder",
        entityId: input.reminderId,
        proposalId: null,
        summary: { deliveryReconciled: true },
        atUtc: input.atUtc,
      });
    }
    return changed;
  }

  getCurrentDeclarationKey(reminderId: string): string | undefined {
    this.#assertOpen();
    const row = this.#database.prepare(`
      SELECT declaration_key FROM reminder_retry_state
      WHERE reminder_id = ?
      LIMIT 1
    `).get(reminderId) as { declaration_key?: string } | undefined;
    return row?.declaration_key;
  }

  getRetryStatus(reminderId: string): ReminderRetryStatus | undefined {
    this.#assertOpen();
    const row = this.#database.prepare(`
      SELECT retry_status FROM reminder_retry_state
      WHERE reminder_id = ?
      LIMIT 1
    `).get(reminderId) as { retry_status?: ReminderRetryStatus } | undefined;
    return row?.retry_status;
  }

  /**
   * Mark a past-due reminder as indeterminate without scheduling a duplicate.
   * This is used when the Gateway database is readable but cannot prove either
   * delivery success or a definite delivery failure after the recovery window.
   */
  markReminderDeliveryUnknown(input: { reminderId: string; code: string; atUtc: number }): boolean {
    this.#assertOpen();
    const changed = this.#transaction(() => {
      const updated = Number(this.#database.prepare(`
        UPDATE reminders
        SET status = 'failed', failure_code = ?, updated_at_utc = ?
        WHERE reminder_id = ? AND subject_id = ?
          AND status IN ('scheduling', 'scheduled', 'delivering')
      `).run(input.code, input.atUtc, input.reminderId, REMINDER_SUBJECT_ID).changes) === 1;
      if (!updated) return false;
      this.#database.prepare(`
        UPDATE reminder_retry_state
        SET retry_status = 'unknown', next_retry_at_utc = NULL, lease_until_utc = NULL,
            last_failure_code = ?, updated_at_utc = ?
        WHERE reminder_id = ?
      `).run(input.code, input.atUtc, input.reminderId);
      return true;
    });
    if (changed) {
      this.insertAudit({
        action: "reminder.delivery_unknown",
        entityType: "reminder",
        entityId: input.reminderId,
        proposalId: null,
        summary: { code: input.code, retry: "blocked_unknown" },
        atUtc: input.atUtc,
      });
    }
    return changed;
  }

  listDueRetryCandidates(atUtc: number, limit = 10): Array<{ reminderId: string; attemptCount: number; declarationKey: string }> {
    this.#assertOpen();
    const safeLimit = Number.isInteger(limit) && limit >= 1 && limit <= 20 ? limit : 10;
    return (this.#database.prepare(`
      SELECT reminder_id, attempt_count, declaration_key
      FROM reminder_retry_state
      WHERE retry_status = 'pending' AND next_retry_at_utc IS NOT NULL
        AND next_retry_at_utc <= ? AND attempt_count < ?
      ORDER BY next_retry_at_utc ASC
      LIMIT ?
    `).all(atUtc, REMINDER_MAX_ATTEMPTS, safeLimit) as RetryRow[]).map((row) => ({
      reminderId: row.reminder_id,
      attemptCount: row.attempt_count,
      declarationKey: row.declaration_key,
    }));
  }

  claimReminderRetry(reminderId: string, atUtc: number): ReminderRetryAttempt | undefined {
    this.#assertOpen();
    return this.#transaction(() => {
      const row = this.#database.prepare(`
        SELECT r.reminder_id, s.attempt_count, s.declaration_key, s.lease_until_utc,
               s.next_retry_at_utc
        FROM reminder_retry_state s
        JOIN reminders r ON r.reminder_id = s.reminder_id
        WHERE s.reminder_id = ? AND r.subject_id = ? AND r.status = 'failed'
          AND s.retry_status = 'pending' AND s.next_retry_at_utc IS NOT NULL
          AND s.next_retry_at_utc <= ? AND s.attempt_count < ?
          AND (s.lease_until_utc IS NULL OR s.lease_until_utc <= ?)
        LIMIT 1
      `).get(reminderId, REMINDER_SUBJECT_ID, atUtc, REMINDER_MAX_ATTEMPTS, atUtc) as RetryClaimRow | undefined;
      if (!row) return undefined;
      const nextAttempt = row.attempt_count + 1;
      const declarationKey = retryDeclarationKey(row.declaration_key, nextAttempt);
      const updated = Number(this.#database.prepare(`
        UPDATE reminder_retry_state
        SET retry_status = 'scheduling', attempt_count = ?, declaration_key = ?,
            next_retry_at_utc = NULL, lease_until_utc = ?, last_retry_at_utc = ?, updated_at_utc = ?
        WHERE reminder_id = ? AND retry_status = 'pending'
          AND (lease_until_utc IS NULL OR lease_until_utc <= ?)
      `).run(
        nextAttempt,
        declarationKey,
        atUtc + REMINDER_RETRY_LEASE_SECONDS,
        atUtc,
        atUtc,
        reminderId,
        atUtc,
      ).changes) === 1;
      if (!updated) return undefined;
      this.#database.prepare(`
        UPDATE reminders
        SET status = 'scheduling', cron_job_id = NULL, dispatched_at_utc = NULL,
            delivered_at_utc = NULL, failure_code = NULL, updated_at_utc = ?
        WHERE reminder_id = ? AND status = 'failed'
      `).run(atUtc, reminderId);
      const reminder = this.getReminder(reminderId);
      if (!reminder) throw new Error("Claimed reminder retry could not be read");
      this.insertAudit({
        action: "reminder.retry_claimed",
        entityType: "reminder",
        entityId: reminderId,
        proposalId: null,
        summary: { attempt: nextAttempt, declarationKey },
        atUtc,
      });
      return { reminder, attemptCount: nextAttempt, declarationKey };
    });
  }

  markReminderRetryScheduleUnknown(input: { reminderId: string; code: string; atUtc: number }): boolean {
    this.#assertOpen();
    const changed = this.#transaction(() => {
      const updated = Number(this.#database.prepare(`
        UPDATE reminders SET status = 'failed', failure_code = ?, updated_at_utc = ?
        WHERE reminder_id = ? AND subject_id = ? AND status = 'scheduling'
      `).run(input.code, input.atUtc, input.reminderId, REMINDER_SUBJECT_ID).changes) === 1;
      if (!updated) return false;
      this.#database.prepare(`
        UPDATE reminder_retry_state SET retry_status = 'unknown', lease_until_utc = NULL,
          next_retry_at_utc = NULL, last_failure_code = ?, updated_at_utc = ?
        WHERE reminder_id = ? AND retry_status = 'scheduling'
      `).run(input.code, input.atUtc, input.reminderId);
      return true;
    });
    if (changed) {
      this.insertAudit({
        action: "reminder.retry_unknown",
        entityType: "reminder",
        entityId: input.reminderId,
        proposalId: null,
        summary: { code: input.code, retry: "blocked_unknown" },
        atUtc: input.atUtc,
      });
    }
    return changed;
  }

  getReminder(reminderId: string): StoredReminder | undefined {
    this.#assertOpen();
    const row = this.#database.prepare(`
      SELECT reminder_id, status, content, scheduled_at_utc, timezone,
             delivery_channel, delivery_to, delivery_account_id, cron_job_id, event_key,
             created_at_utc, updated_at_utc, dispatched_at_utc, delivered_at_utc,
             cancelled_at_utc, failure_code
      FROM reminders
      WHERE reminder_id = ? AND subject_id = ?
      LIMIT 1
    `).get(reminderId, REMINDER_SUBJECT_ID) as ReminderRow | undefined;
    return row ? mapReminder(row) : undefined;
  }

  listActiveSummaries(limit = 20): ReminderSummary[] {
    this.#assertOpen();
    const safeLimit = Number.isInteger(limit) && limit >= 1 && limit <= 50 ? limit : 20;
    const rows = this.#database.prepare(`
      SELECT r.reminder_id, r.status, r.content, r.scheduled_at_utc, r.timezone,
             r.dispatched_at_utc, r.failure_code,
             COALESCE(s.retry_status, 'unknown') AS retry_status,
             COALESCE(s.attempt_count, 1) AS attempt_count,
             s.next_retry_at_utc
      FROM reminders
      AS r LEFT JOIN reminder_retry_state AS s ON s.reminder_id = r.reminder_id
      WHERE r.subject_id = ? AND r.status IN ('scheduling', 'scheduled', 'delivering', 'failed')
      ORDER BY r.scheduled_at_utc ASC
      LIMIT ?
    `).all(REMINDER_SUBJECT_ID, safeLimit) as ReminderSummaryRow[];
    return rows.map((row) => ({
      reminderId: row.reminder_id,
      status: row.status,
      content: row.content,
      scheduledAtUtc: row.scheduled_at_utc,
      timezone: row.timezone,
      dispatchedAtUtc: row.dispatched_at_utc,
      failureCode: row.failure_code,
      retryStatus: row.retry_status,
      attemptCount: row.attempt_count,
      nextRetryAtUtc: row.next_retry_at_utc,
    }));
  }

  listReconciliationReminders(limit = 50): StoredReminder[] {
    this.#assertOpen();
    const safeLimit = Number.isInteger(limit) && limit >= 1 && limit <= 100 ? limit : 50;
    const rows = this.#database.prepare(`
      SELECT reminder_id, status, content, scheduled_at_utc, timezone,
             delivery_channel, delivery_to, delivery_account_id, cron_job_id, event_key,
             created_at_utc, updated_at_utc, dispatched_at_utc, delivered_at_utc,
             cancelled_at_utc, failure_code
      FROM reminders
      WHERE subject_id = ? AND status IN ('scheduling', 'scheduled', 'delivering')
      ORDER BY scheduled_at_utc ASC
      LIMIT ?
    `).all(REMINDER_SUBJECT_ID, safeLimit) as ReminderRow[];
    return rows.map(mapReminder);
  }

  claimForDelivery(reminderId: string, atUtc: number): StoredReminder | undefined {
    this.#assertOpen();
    return this.#transaction(() => {
      const changed = Number(this.#database.prepare(`
        UPDATE reminders
        SET status = 'delivering', dispatched_at_utc = ?, updated_at_utc = ?
        WHERE reminder_id = ?
          AND subject_id = ?
          AND status = 'scheduled'
          AND scheduled_at_utc <= ?
      `).run(atUtc, atUtc, reminderId, REMINDER_SUBJECT_ID, atUtc).changes) === 1;
      if (!changed) return undefined;
      const reminder = this.getReminder(reminderId);
      if (!reminder) throw new Error("Claimed reminder could not be read");
      this.insertAudit({
        action: "reminder.delivery_claimed",
        entityType: "reminder",
        entityId: reminderId,
        proposalId: null,
        summary: { eventKey: reminder.eventKey },
        atUtc,
      });
      return reminder;
    });
  }

  commitCancellationProposal(input: {
    proposalId: string;
    payloadHash: string;
    reminderId: string;
    atUtc: number;
  }): boolean {
    this.#assertOpen();
    return this.#transaction(() => {
      const cancelled = this.#database.prepare(`
        UPDATE reminders
        SET status = 'cancelled', cancelled_at_utc = ?, updated_at_utc = ?
        WHERE reminder_id = ? AND subject_id = ? AND status IN ('scheduling', 'scheduled', 'failed')
      `).run(input.atUtc, input.atUtc, input.reminderId, REMINDER_SUBJECT_ID);
      if (Number(cancelled.changes) !== 1) return false;
      this.#database.prepare(`
        UPDATE reminder_retry_state
        SET retry_status = 'cancelled', next_retry_at_utc = NULL, lease_until_utc = NULL,
            updated_at_utc = ?
        WHERE reminder_id = ?
      `).run(input.atUtc, input.reminderId);
      const committed = this.#database.prepare(`
        UPDATE reminder_proposals
        SET status = 'committed', result_reminder_id = ?, committed_at_utc = ?, updated_at_utc = ?
        WHERE proposal_id = ?
          AND subject_id = ?
          AND kind = 'reminder_cancel'
          AND status = 'pending'
          AND payload_hash = ?
          AND expires_at_utc > ?
      `).run(
        input.reminderId,
        input.atUtc,
        input.atUtc,
        input.proposalId,
        REMINDER_SUBJECT_ID,
        input.payloadHash,
        input.atUtc,
      );
      if (Number(committed.changes) !== 1) {
        throw new Error("Reminder cancellation proposal changed while being committed");
      }
      this.insertAudit({
        action: "reminder.cancelled",
        entityType: "reminder",
        entityId: input.reminderId,
        proposalId: input.proposalId,
        summary: { method: "owner_confirmation" },
        atUtc: input.atUtc,
      });
      return true;
    });
  }

  /**
   * Atomically records a typed reminder change before the remote Gateway
   * update.  The remote operation is intentionally performed by the service
   * layer after this transaction; a schedule change therefore enters the
   * `unknown` retry state until the Gateway result is confirmed.
   */
  applyReminderUpdate(input: {
    proposalId: string;
    payloadHash: string;
    reminderId: string;
    expectedContent: string;
    expectedScheduledAtUtc: number;
    expectedCronJobId: string;
    nextContent: string;
    nextScheduledAtUtc: number;
    scheduleChanged: boolean;
    atUtc: number;
  }): boolean {
    this.#assertOpen();
    return this.#transaction(() => {
      const proposal = this.#database.prepare(`
        SELECT 1
        FROM reminder_proposals
        WHERE proposal_id = ? AND subject_id = ? AND kind = 'reminder_update'
          AND status = 'pending' AND payload_hash = ? AND expires_at_utc > ?
        LIMIT 1
      `).get(
        input.proposalId,
        REMINDER_SUBJECT_ID,
        input.payloadHash,
        input.atUtc,
      );
      if (!proposal) return false;

      const retry = this.#database.prepare(`
        SELECT retry_status
        FROM reminder_retry_state
        WHERE reminder_id = ?
        LIMIT 1
      `).get(input.reminderId) as { retry_status?: ReminderRetryStatus } | undefined;
      if (retry?.retry_status !== "scheduled") return false;

      const updated = Number(this.#database.prepare(`
        UPDATE reminders
        SET content = ?, scheduled_at_utc = ?, updated_at_utc = ?,
            failure_code = CASE WHEN ? = 1 THEN 'cron_update_pending' ELSE NULL END
        WHERE reminder_id = ? AND subject_id = ? AND status = 'scheduled'
          AND content = ? AND scheduled_at_utc = ? AND cron_job_id = ?
      `).run(
        input.nextContent,
        input.nextScheduledAtUtc,
        input.atUtc,
        input.scheduleChanged ? 1 : 0,
        input.reminderId,
        REMINDER_SUBJECT_ID,
        input.expectedContent,
        input.expectedScheduledAtUtc,
        input.expectedCronJobId,
      ).changes) === 1;
      if (!updated) return false;

      if (input.scheduleChanged) {
        const retryUpdated = Number(this.#database.prepare(`
          UPDATE reminder_retry_state
          SET retry_status = 'unknown', next_retry_at_utc = NULL, lease_until_utc = NULL,
              last_failure_code = 'cron_update_pending', updated_at_utc = ?
          WHERE reminder_id = ? AND retry_status = 'scheduled'
        `).run(input.atUtc, input.reminderId).changes) === 1;
        if (!retryUpdated) throw new Error("Reminder update retry state changed while being applied");
      }

      const committed = Number(this.#database.prepare(`
        UPDATE reminder_proposals
        SET status = 'committed', result_reminder_id = ?, committed_at_utc = ?, updated_at_utc = ?
        WHERE proposal_id = ? AND subject_id = ? AND kind = 'reminder_update'
          AND status = 'pending' AND payload_hash = ? AND expires_at_utc > ?
      `).run(
        input.reminderId,
        input.atUtc,
        input.atUtc,
        input.proposalId,
        REMINDER_SUBJECT_ID,
        input.payloadHash,
        input.atUtc,
      ).changes) === 1;
      if (!committed) throw new Error("Reminder update proposal changed while being committed");

      this.insertAudit({
        action: "reminder.update_requested",
        entityType: "reminder",
        entityId: input.reminderId,
        proposalId: input.proposalId,
        summary: {
          contentChanged: input.expectedContent !== input.nextContent,
          scheduleChanged: input.scheduleChanged,
          remoteState: input.scheduleChanged ? "pending" : "not_required",
        },
        atUtc: input.atUtc,
      });
      return true;
    });
  }

  markReminderUpdateConfirmed(input: { reminderId: string; atUtc: number }): boolean {
    this.#assertOpen();
    const changed = this.#transaction(() => {
      const updated = Number(this.#database.prepare(`
        UPDATE reminders
        SET failure_code = NULL, updated_at_utc = ?
        WHERE reminder_id = ? AND subject_id = ? AND status = 'scheduled'
      `).run(input.atUtc, input.reminderId, REMINDER_SUBJECT_ID).changes) === 1;
      if (!updated) return false;
      const retryUpdated = Number(this.#database.prepare(`
        UPDATE reminder_retry_state
        SET retry_status = 'scheduled', next_retry_at_utc = NULL, lease_until_utc = NULL,
            last_failure_code = NULL, updated_at_utc = ?
        WHERE reminder_id = ? AND retry_status = 'unknown'
      `).run(input.atUtc, input.reminderId).changes) === 1;
      if (!retryUpdated) throw new Error("Reminder update retry state changed while being confirmed");
      return true;
    });
    if (changed) {
      this.insertAudit({
        action: "reminder.updated",
        entityType: "reminder",
        entityId: input.reminderId,
        proposalId: null,
        summary: { remoteState: "confirmed" },
        atUtc: input.atUtc,
      });
    }
    return changed;
  }

  /** Keep the new local desired state, but block further writes until the
   * remote Gateway outcome is reconciled.  The reminder remains scheduled so
   * a successfully applied remote update can still deliver it. */
  markReminderUpdateUnknown(input: { reminderId: string; code: string; atUtc: number }): boolean {
    this.#assertOpen();
    const changed = this.#transaction(() => {
      const updated = Number(this.#database.prepare(`
        UPDATE reminders
        SET failure_code = ?, updated_at_utc = ?
        WHERE reminder_id = ? AND subject_id = ? AND status = 'scheduled'
      `).run(input.code, input.atUtc, input.reminderId, REMINDER_SUBJECT_ID).changes) === 1;
      if (!updated) return false;
      const retryUpdated = Number(this.#database.prepare(`
        UPDATE reminder_retry_state
        SET retry_status = 'unknown', next_retry_at_utc = NULL, lease_until_utc = NULL,
            last_failure_code = ?, updated_at_utc = ?
        WHERE reminder_id = ?
      `).run(input.code, input.atUtc, input.reminderId).changes) === 1;
      if (!retryUpdated) throw new Error("Reminder update retry state is missing");
      return true;
    });
    if (changed) {
      this.insertAudit({
        action: "reminder.update_unknown",
        entityType: "reminder",
        entityId: input.reminderId,
        proposalId: null,
        summary: { code: input.code, retry: "blocked_unknown" },
        atUtc: input.atUtc,
      });
    }
    return changed;
  }

  insertAudit(input: {
    action: string;
    entityType: string;
    entityId: string | null;
    proposalId: string | null;
    summary: Record<string, unknown>;
    atUtc: number;
  }): void {
    this.#assertOpen();
    this.#database.prepare(`
      INSERT INTO reminder_audit_log (
        subject_id, action, entity_type, entity_id, proposal_id, summary_json, created_at_utc
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      REMINDER_SUBJECT_ID,
      input.action,
      input.entityType,
      input.entityId,
      input.proposalId,
      JSON.stringify(input.summary),
      input.atUtc,
    );
  }

  #transaction<T>(work: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  private scheduleRetryAfterDefiniteFailure(reminderId: string, code: string, atUtc: number): void {
    const row = this.#database.prepare(`
      SELECT attempt_count FROM reminder_retry_state
      WHERE reminder_id = ?
      LIMIT 1
    `).get(reminderId) as { attempt_count?: number } | undefined;
    const attempt = row?.attempt_count ?? REMINDER_MAX_ATTEMPTS;
    const exhausted = attempt >= REMINDER_MAX_ATTEMPTS;
    const delay = REMINDER_RETRY_BACKOFF_SECONDS[Math.max(0, attempt - 1)]
      ?? REMINDER_RETRY_BACKOFF_SECONDS[REMINDER_RETRY_BACKOFF_SECONDS.length - 1]
      ?? 300;
    this.#database.prepare(`
      UPDATE reminder_retry_state
      SET retry_status = ?, next_retry_at_utc = ?, lease_until_utc = NULL,
          last_failure_code = ?, updated_at_utc = ?
      WHERE reminder_id = ? AND retry_status NOT IN ('unknown', 'cancelled', 'delivered', 'exhausted')
    `).run(
      exhausted ? "exhausted" : "pending",
      exhausted ? null : atUtc + delay,
      code,
      atUtc,
      reminderId,
    );
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("ReminderStore is closed");
  }
}

type ReminderProposalRow = {
  proposal_id: string;
  kind: ReminderProposalKind;
  status: ReminderProposalStatus;
  payload_json: string;
  payload_hash: string;
  request_context_hash: string;
  delivery_channel: ReminderDelivery["channel"];
  delivery_to: string;
  delivery_account_id: string | null;
  expires_at_utc: number;
  result_reminder_id: string | null;
};

type ReminderRow = {
  reminder_id: string;
  status: ReminderStatus;
  content: string;
  scheduled_at_utc: number;
  timezone: string;
  delivery_channel: ReminderDelivery["channel"];
  delivery_to: string;
  delivery_account_id: string | null;
  cron_job_id: string | null;
  event_key: string;
  created_at_utc: number;
  updated_at_utc: number;
  dispatched_at_utc: number | null;
  delivered_at_utc: number | null;
  cancelled_at_utc: number | null;
  failure_code: string | null;
};

type ReminderSummaryRow = Pick<
  ReminderRow,
  "reminder_id" | "status" | "content" | "scheduled_at_utc" | "timezone" | "dispatched_at_utc" | "failure_code"
> & {
  retry_status: ReminderRetryStatus;
  attempt_count: number;
  next_retry_at_utc: number | null;
};

function mapProposal(row: ReminderProposalRow): StoredReminderProposal {
  return {
    proposalId: row.proposal_id,
    kind: row.kind,
    status: row.status,
    payloadJson: row.payload_json,
    payloadHash: row.payload_hash,
    requestContextHash: row.request_context_hash,
    delivery: {
      channel: row.delivery_channel,
      to: row.delivery_to,
      accountId: row.delivery_account_id,
    },
    expiresAtUtc: row.expires_at_utc,
    resultReminderId: row.result_reminder_id,
  };
}

function mapReminder(row: ReminderRow): StoredReminder {
  return {
    reminderId: row.reminder_id,
    status: row.status,
    content: row.content,
    scheduledAtUtc: row.scheduled_at_utc,
    timezone: row.timezone,
    delivery: {
      channel: row.delivery_channel,
      to: row.delivery_to,
      accountId: row.delivery_account_id,
    },
    cronJobId: row.cron_job_id,
    eventKey: row.event_key,
    createdAtUtc: row.created_at_utc,
    updatedAtUtc: row.updated_at_utc,
    dispatchedAtUtc: row.dispatched_at_utc,
    deliveredAtUtc: row.delivered_at_utc,
    cancelledAtUtc: row.cancelled_at_utc,
    failureCode: row.failure_code,
  };
}

function currentUnixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function normalizeUnixSeconds(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Clock must provide a non-negative integer Unix timestamp");
  }
  return value;
}

function prepareStateDirectory(inputPath: string): string {
  const stateDirectory = resolve(inputPath);
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(stateDirectory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("Reminder stateDirectory must be a real directory, not a symlink");
  }
  chmodSync(stateDirectory, 0o700);
  return stateDirectory;
}

function prepareDatabaseFile(databasePath: string): void {
  if (existsSync(databasePath)) {
    const stat = lstatSync(databasePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error("reminders.sqlite must be a regular file, not a symlink");
    }
  }
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const descriptor = openSync(
    databasePath,
    existsSync(databasePath)
      ? constants.O_RDWR | noFollow
      : constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | noFollow,
    0o600,
  );
  closeSync(descriptor);
  chmodSync(databasePath, 0o600);
}

const INITIAL_SCHEMA_SQL = String.raw`
  CREATE TABLE IF NOT EXISTS reminder_proposals (
    proposal_id TEXT PRIMARY KEY,
    subject_id TEXT NOT NULL DEFAULT 'owner',
    kind TEXT NOT NULL CHECK (kind IN ('reminder_create', 'reminder_cancel', 'reminder_update')),
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'committed', 'expired', 'cancelled')),
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
    request_context_hash TEXT NOT NULL CHECK (length(request_context_hash) = 64),
    delivery_channel TEXT NOT NULL CHECK (delivery_channel = 'qqbot'),
    delivery_to TEXT NOT NULL CHECK (length(delivery_to) BETWEEN 1 AND 500),
    delivery_account_id TEXT,
    expires_at_utc INTEGER NOT NULL CHECK (expires_at_utc >= 0),
    result_reminder_id TEXT,
    committed_at_utc INTEGER CHECK (committed_at_utc >= 0),
    created_at_utc INTEGER NOT NULL CHECK (created_at_utc >= 0),
    updated_at_utc INTEGER NOT NULL CHECK (updated_at_utc >= created_at_utc)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS reminder_proposals_pending_index
    ON reminder_proposals(subject_id, status, expires_at_utc);

  CREATE TABLE IF NOT EXISTS reminders (
    reminder_id TEXT PRIMARY KEY,
    subject_id TEXT NOT NULL DEFAULT 'owner',
    status TEXT NOT NULL CHECK (
      status IN ('scheduling', 'scheduled', 'delivering', 'delivered', 'cancelled', 'failed')
    ),
    content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 200),
    scheduled_at_utc INTEGER NOT NULL CHECK (scheduled_at_utc >= 0),
    timezone TEXT NOT NULL CHECK (timezone = 'Asia/Shanghai'),
    delivery_channel TEXT NOT NULL CHECK (delivery_channel = 'qqbot'),
    delivery_to TEXT NOT NULL CHECK (length(delivery_to) BETWEEN 1 AND 500),
    delivery_account_id TEXT,
    cron_job_id TEXT,
    event_key TEXT NOT NULL UNIQUE CHECK (length(event_key) BETWEEN 1 AND 200),
    dispatched_at_utc INTEGER CHECK (dispatched_at_utc >= 0),
    delivered_at_utc INTEGER CHECK (delivered_at_utc >= 0),
    cancelled_at_utc INTEGER CHECK (cancelled_at_utc >= 0),
    failure_code TEXT CHECK (length(failure_code) BETWEEN 1 AND 100),
    created_at_utc INTEGER NOT NULL CHECK (created_at_utc >= 0),
    updated_at_utc INTEGER NOT NULL CHECK (updated_at_utc >= created_at_utc)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS reminders_active_index
    ON reminders(subject_id, status, scheduled_at_utc);

  CREATE TABLE IF NOT EXISTS reminder_audit_log (
    id INTEGER PRIMARY KEY,
    subject_id TEXT NOT NULL DEFAULT 'owner',
    action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 100),
    entity_type TEXT NOT NULL CHECK (length(entity_type) BETWEEN 1 AND 100),
    entity_id TEXT,
    proposal_id TEXT,
    summary_json TEXT NOT NULL CHECK (json_valid(summary_json)),
    created_at_utc INTEGER NOT NULL CHECK (created_at_utc >= 0)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS reminder_retry_state (
    reminder_id TEXT PRIMARY KEY REFERENCES reminders(reminder_id) ON DELETE CASCADE,
    retry_status TEXT NOT NULL CHECK (
      retry_status IN ('scheduling', 'scheduled', 'pending', 'delivered', 'cancelled', 'exhausted', 'unknown')
    ),
    attempt_count INTEGER NOT NULL DEFAULT 1 CHECK (attempt_count >= 1 AND attempt_count <= 3),
    next_retry_at_utc INTEGER CHECK (next_retry_at_utc >= 0),
    lease_until_utc INTEGER CHECK (lease_until_utc >= 0),
    declaration_key TEXT NOT NULL UNIQUE CHECK (length(declaration_key) BETWEEN 1 AND 200),
    last_failure_code TEXT CHECK (length(last_failure_code) BETWEEN 1 AND 100),
    last_retry_at_utc INTEGER CHECK (last_retry_at_utc >= 0),
    updated_at_utc INTEGER NOT NULL CHECK (updated_at_utc >= 0)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS reminder_retry_due_index
    ON reminder_retry_state(retry_status, next_retry_at_utc);
`;

/** Upgrade the proposal kind CHECK constraint without touching proposal rows.
 * SQLite cannot alter a CHECK constraint in place, so copy the table inside a
 * single transaction. This is deliberately kept local to this migration and
 * runs before the retry ledger migration. */
function migrateReminderProposalKinds(database: DatabaseSync): void {
  const row = database.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'reminder_proposals'
  `).get() as { sql?: string } | undefined;
  if (!row?.sql || row.sql.includes("'reminder_update'")) return;
  database.exec(String.raw`
    BEGIN IMMEDIATE;
    CREATE TABLE reminder_proposals_v2 (
      proposal_id TEXT PRIMARY KEY,
      subject_id TEXT NOT NULL DEFAULT 'owner',
      kind TEXT NOT NULL CHECK (kind IN ('reminder_create', 'reminder_cancel', 'reminder_update')),
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'committed', 'expired', 'cancelled')),
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
      request_context_hash TEXT NOT NULL CHECK (length(request_context_hash) = 64),
      delivery_channel TEXT NOT NULL CHECK (delivery_channel = 'qqbot'),
      delivery_to TEXT NOT NULL CHECK (length(delivery_to) BETWEEN 1 AND 500),
      delivery_account_id TEXT,
      expires_at_utc INTEGER NOT NULL CHECK (expires_at_utc >= 0),
      result_reminder_id TEXT,
      committed_at_utc INTEGER CHECK (committed_at_utc >= 0),
      created_at_utc INTEGER NOT NULL CHECK (created_at_utc >= 0),
      updated_at_utc INTEGER NOT NULL CHECK (updated_at_utc >= created_at_utc)
    ) STRICT;
    INSERT INTO reminder_proposals_v2 (
      proposal_id, subject_id, kind, status, payload_json, payload_hash,
      request_context_hash, delivery_channel, delivery_to, delivery_account_id,
      expires_at_utc, result_reminder_id, committed_at_utc, created_at_utc, updated_at_utc
    )
    SELECT proposal_id, subject_id, kind, status, payload_json, payload_hash,
           request_context_hash, delivery_channel, delivery_to, delivery_account_id,
           expires_at_utc, result_reminder_id, committed_at_utc, created_at_utc, updated_at_utc
    FROM reminder_proposals;
    DROP TABLE reminder_proposals;
    ALTER TABLE reminder_proposals_v2 RENAME TO reminder_proposals;
    CREATE INDEX reminder_proposals_pending_index
      ON reminder_proposals(subject_id, status, expires_at_utc);
    COMMIT;
  `);
}

/**
 * Adds the retry ledger to installations created before R2D. Existing failed
 * rows are deliberately marked `unknown`: their original Gateway outcome is
 * not provable after the fact, so the first release never resends them.
 */
const RETRY_MIGRATION_SQL = String.raw`
  INSERT OR IGNORE INTO reminder_retry_state (
    reminder_id, retry_status, attempt_count, declaration_key, updated_at_utc
  )
  SELECT reminder_id,
         CASE status
           WHEN 'scheduling' THEN 'scheduling'
           WHEN 'scheduled' THEN 'scheduled'
           WHEN 'delivering' THEN 'scheduled'
           WHEN 'delivered' THEN 'delivered'
           WHEN 'cancelled' THEN 'cancelled'
           ELSE 'unknown'
         END,
         1,
         event_key,
         updated_at_utc
  FROM reminders;
`;

type RetryRow = {
  reminder_id: string;
  attempt_count: number;
  declaration_key: string;
};

type RetryClaimRow = RetryRow;

function retryDeclarationKey(base: string, attempt: number): string {
  const suffix = `:retry:${attempt}`;
  const prefix = base.length + suffix.length <= 200 ? base : base.slice(0, 200 - suffix.length);
  return `${prefix}${suffix}`;
}
