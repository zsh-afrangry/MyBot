import { existsSync, lstatSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { gatewayStateDatabasePath } from "./paths.js";
import { ReminderStore, type StoredReminder } from "./reminder-store.js";

const DELIVERY_STALE_AFTER_SECONDS = 5 * 60;
/**
 * After this window a past-due reminder without a provable Gateway outcome is
 * recorded as unknown. It is deliberately not treated as a retryable failure:
 * the scheduler may have accepted/delivered it while the local process was
 * stopped, so sending a replacement would risk a duplicate notification.
 */
const DELIVERY_UNKNOWN_AFTER_SECONDS = 5 * 60;

export interface ReminderReconcileResult {
  scanned: number;
  jobsAdopted: number;
  delivered: number;
  failed: number;
  warnings: string[];
}

/**
 * Reconciles the private reminder store with the Gateway's durable SQLite
 * cron/job history. This is intentionally a read-only view of the Gateway
 * database: the reconciler never edits OpenClaw's scheduler rows and never
 * sends a message itself.
 */
export function reconcileReminderState(
  store: ReminderStore,
  options: { gatewayDatabasePath?: string; nowUtc?: number } = {},
): ReminderReconcileResult {
  const reminders = store.listReconciliationReminders();
  const result: ReminderReconcileResult = {
    scanned: reminders.length,
    jobsAdopted: 0,
    delivered: 0,
    failed: 0,
    warnings: [],
  };
  if (reminders.length === 0) return result;

  const databasePath = options.gatewayDatabasePath ?? gatewayStateDatabasePath();
  if (!existsSync(databasePath)) {
    result.warnings.push("gateway_state_unavailable");
    return result;
  }
  const stat = lstatSync(databasePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    result.warnings.push("gateway_state_invalid");
    return result;
  }

  let database: DatabaseSync;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
  } catch {
    result.warnings.push("gateway_state_unreadable");
    return result;
  }
  try {
    const nowUtc = options.nowUtc ?? store.getNowUtc();
    for (const reminder of reminders) {
      reconcileOne(store, database, reminder, nowUtc, result);
    }
  } catch {
    result.warnings.push("gateway_state_schema_unavailable");
  } finally {
    database.close();
  }
  return result;
}

function reconcileOne(
  store: ReminderStore,
  database: DatabaseSync,
  reminder: StoredReminder,
  nowUtc: number,
  result: ReminderReconcileResult,
): void {
  const declarationKey = store.getCurrentDeclarationKey(reminder.reminderId) ?? reminder.eventKey;
  const job = database.prepare(`
    SELECT job_id, declaration_key, last_run_status, last_delivery_status,
           last_delivered, last_error
    FROM cron_jobs
    WHERE declaration_key = ? OR job_id = ?
    ORDER BY updated_at DESC
    LIMIT 1
  `).get(declarationKey, reminder.cronJobId) as CronJobRow | undefined;

  if (job && reminder.status === "scheduling") {
    if (store.markReminderScheduled({
      reminderId: reminder.reminderId,
      cronJobId: job.job_id,
      atUtc: nowUtc,
    })) {
      result.jobsAdopted += 1;
    }
    return;
  }

  // A process can stop after the local scheduling row is written but before
  // cron.add returns. If the Gateway has no matching job after the recovery
  // window, the outcome is unknowable; make it visible and block auto-retry.
  if (!job && reminder.status === "scheduling") {
    if (nowUtc >= reminder.scheduledAtUtc + DELIVERY_UNKNOWN_AFTER_SECONDS) {
      if (store.markReminderDeliveryUnknown({
        reminderId: reminder.reminderId,
        code: "cron_registration_unknown",
        atUtc: nowUtc,
      })) {
        result.failed += 1;
      }
    }
    return;
  }

  const jobId = job?.job_id ?? reminder.cronJobId;
  if (!jobId) {
    if (nowUtc >= reminder.scheduledAtUtc + DELIVERY_UNKNOWN_AFTER_SECONDS) {
      if (store.markReminderDeliveryUnknown({
        reminderId: reminder.reminderId,
        code: "delivery_unknown",
        atUtc: nowUtc,
      })) {
        result.failed += 1;
      }
    }
    return;
  }

  const run = database.prepare(`
    SELECT status, delivery_status, delivered, run_at_ms, error, delivery_error
    FROM cron_run_logs
    WHERE job_id = ?
    ORDER BY seq DESC
    LIMIT 1
  `).get(jobId) as CronRunRow | undefined;
  const status = run ?? (job ? {
    status: job.last_run_status,
    delivery_status: job.last_delivery_status,
    delivered: job.last_delivered,
    run_at_ms: null,
    error: job.last_error,
    delivery_error: null,
  } satisfies CronRunRow : undefined);
  if (!status || status.run_at_ms === null) {
    if (nowUtc >= reminder.scheduledAtUtc + DELIVERY_UNKNOWN_AFTER_SECONDS) {
      if (store.markReminderDeliveryUnknown({
        reminderId: reminder.reminderId,
        code: "delivery_unknown",
        atUtc: nowUtc,
      })) {
        result.failed += 1;
      }
    }
    return;
  }

  const runAtUtc = Math.floor(status.run_at_ms / 1000);
  if (runAtUtc < reminder.scheduledAtUtc - 60) return;
  if (status.status === "ok" && status.delivery_status === "delivered" && status.delivered === 1) {
    if (store.markReminderDelivered({ reminderId: reminder.reminderId, atUtc: nowUtc })) {
      result.delivered += 1;
    }
    return;
  }

  const deliveryFailed = status.status === "error"
    || status.delivery_status === "failed"
    || status.delivered === 0;
  const dispatchAge = reminder.dispatchedAtUtc === null ? 0 : nowUtc - reminder.dispatchedAtUtc;
  if (deliveryFailed && (reminder.status !== "delivering" || dispatchAge >= DELIVERY_STALE_AFTER_SECONDS)) {
    if (store.markReminderFailed({
      reminderId: reminder.reminderId,
      code: normalizeFailureCode(status.delivery_error || status.error || "delivery_failed"),
      atUtc: nowUtc,
    })) {
      result.failed += 1;
    }
  }
}

/** Keep Gateway diagnostics out of the private audit record and within the DB bound. */
function normalizeFailureCode(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return normalized || "delivery_failed";
}

type CronJobRow = {
  job_id: string;
  declaration_key: string | null;
  last_run_status: string | null;
  last_delivery_status: string | null;
  last_delivered: number | null;
  last_error: string | null;
};

type CronRunRow = {
  status: string | null;
  delivery_status: string | null;
  delivered: number | null;
  run_at_ms: number | null;
  error: string | null;
  delivery_error: string | null;
};
