import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import type {
  OpenClawPluginService,
  OpenClawPluginServiceContext,
} from "openclaw/plugin-sdk/plugin-entry";

import {
  reconcileReminderState,
  type ReminderReconcileResult,
} from "./reminder-reconciler.js";
import { reminderStateDirectory } from "./paths.js";
import { ReminderStore } from "./reminder-store.js";
import type { ReminderCronScheduler } from "./reminders.js";

/** One minute is frequent enough to repair a state transition without polling the model. */
export const REMINDER_RECONCILER_INTERVAL_MS = 60_000;
const LOCK_FILE_NAME = "reconciler.lock";

export interface ReminderReconcilerRunResult extends ReminderReconcileResult {
  skipped: boolean;
  skipReason?: "lock_busy";
  retriesScheduled?: number;
  retriesUnknown?: number;
}

export interface ReminderReconcilerServiceOptions {
  stateDirectory?: string;
  gatewayDatabasePath?: string;
  intervalMs?: number;
  nowUtc?: () => number;
  /** Supplied only by full Gateway runtime; tests can use a fake scheduler. */
  scheduler?: ReminderCronScheduler;
}

/**
 * Runs one deterministic, local reconciliation pass. It only writes the private
 * reminder SQLite; the Gateway state database is opened read-only by the lower
 * level reconciler. A small O_EXCL lock prevents two Gateway/service instances
 * from racing the same pass.
 */
export function runReminderReconcilerOnce(
  options: ReminderReconcilerServiceOptions = {},
): ReminderReconcilerRunResult {
  const storeOptions = {
    stateDirectory: options.stateDirectory ?? reminderStateDirectory(),
    ...(options.nowUtc ? { now: options.nowUtc } : {}),
  };
  const store = new ReminderStore({
    ...storeOptions,
  });
  const lockPath = join(store.stateDirectory, LOCK_FILE_NAME);
  const lock = acquireReconcilerLock(lockPath);
  if (!lock) {
    store.close();
    return {
      scanned: 0,
      jobsAdopted: 0,
      delivered: 0,
      failed: 0,
      warnings: [],
      skipped: true,
      skipReason: "lock_busy",
      retriesScheduled: 0,
      retriesUnknown: 0,
    };
  }

  try {
    const reconcileOptions = {
      ...(options.gatewayDatabasePath ? { gatewayDatabasePath: options.gatewayDatabasePath } : {}),
      ...(options.nowUtc ? { nowUtc: options.nowUtc() } : {}),
    };
    return {
      ...reconcileReminderState(store, reconcileOptions),
      skipped: false,
    };
  } finally {
    store.close();
    releaseReconcilerLock(lockPath, lock.token);
  }
}

/**
 * Reconcile first, then schedule only definite delivery failures whose retry
 * ledger is due. Registration errors are recorded as `unknown` and never
 * retried automatically because the Gateway may have accepted the request.
 */
export async function runReminderRetryMaintenanceOnce(
  options: ReminderReconcilerServiceOptions = {},
): Promise<ReminderReconcilerRunResult> {
  const store = new ReminderStore({
    stateDirectory: options.stateDirectory ?? reminderStateDirectory(),
    ...(options.nowUtc ? { now: options.nowUtc } : {}),
  });
  const lockPath = join(store.stateDirectory, LOCK_FILE_NAME);
  const lock = acquireReconcilerLock(lockPath);
  if (!lock) {
    store.close();
    return {
      scanned: 0,
      jobsAdopted: 0,
      delivered: 0,
      failed: 0,
      warnings: [],
      skipped: true,
      skipReason: "lock_busy",
      retriesScheduled: 0,
      retriesUnknown: 0,
    };
  }

  try {
    const nowUtc = options.nowUtc ? options.nowUtc() : store.getNowUtc();
    const result: ReminderReconcilerRunResult = {
      ...reconcileReminderState(store, {
        ...(options.gatewayDatabasePath ? { gatewayDatabasePath: options.gatewayDatabasePath } : {}),
        nowUtc,
      }),
      skipped: false,
      retriesScheduled: 0,
      retriesUnknown: 0,
    };
    if (!options.scheduler) return result;

    for (const candidate of store.listDueRetryCandidates(nowUtc)) {
      const attempt = store.claimReminderRetry(candidate.reminderId, nowUtc);
      if (!attempt) continue;
      try {
        const scheduled = await options.scheduler.add({
          reminderId: attempt.reminder.reminderId,
          scheduledAtUtc: attempt.reminder.scheduledAtUtc,
          delivery: attempt.reminder.delivery,
          eventKey: attempt.reminder.eventKey,
          declarationKey: attempt.declarationKey,
        });
        if (!store.markReminderScheduled({
          reminderId: attempt.reminder.reminderId,
          cronJobId: scheduled.jobId,
          atUtc: nowUtc,
        })) {
          store.markReminderRetryScheduleUnknown({
            reminderId: attempt.reminder.reminderId,
            code: "retry_state_changed",
            atUtc: nowUtc,
          });
          result.retriesUnknown = (result.retriesUnknown ?? 0) + 1;
          continue;
        }
        result.retriesScheduled = (result.retriesScheduled ?? 0) + 1;
      } catch {
        store.markReminderRetryScheduleUnknown({
          reminderId: attempt.reminder.reminderId,
          code: "cron_retry_add_unknown",
          atUtc: nowUtc,
        });
        result.retriesUnknown = (result.retriesUnknown ?? 0) + 1;
      }
    }
    return result;
  } finally {
    store.close();
    releaseReconcilerLock(lockPath, lock.token);
  }
}

/** Registers the host-local service; it has no model, tool, channel, or QQ send path. */
export function createReminderReconcilerService(
  options: ReminderReconcilerServiceOptions = {},
): OpenClawPluginService {
  const intervalMs = normalizeInterval(options.intervalMs);
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let stopped = false;
  let logger: OpenClawPluginServiceContext["logger"] | undefined;

  const tick = (): void => {
    if (stopped || running) return;
    running = true;
    void (async () => {
      try {
        const result = await runReminderRetryMaintenanceOnce(options);
        if (result.skipped) {
          logger?.warn("personal-weather reminder reconciler warning=lock_busy");
          return;
        }
        if (result.warnings.length > 0) {
          logger?.warn(`personal-weather reminder reconciler warning=${result.warnings.join(",")}`);
        }
        if (result.scanned > 0 || result.jobsAdopted > 0 || result.delivered > 0 || result.failed > 0
          || (result.retriesScheduled ?? 0) > 0 || (result.retriesUnknown ?? 0) > 0 || result.warnings.length > 0) {
          logger?.info(
            `personal-weather reminder reconciler: scanned=${result.scanned} adopted=${result.jobsAdopted} delivered=${result.delivered} failed=${result.failed} retries=${result.retriesScheduled ?? 0} unknown=${result.retriesUnknown ?? 0} warnings=${result.warnings.length}`,
          );
        }
      } catch (error) {
        logger?.error(`personal-weather reminder reconciler failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        running = false;
      }
    })();
  };

  return {
    id: "personal-weather-reminder-reconciler",
    start(ctx) {
      logger = ctx.logger;
      if (timer) {
        logger.warn("personal-weather reminder reconciler warning=already_started");
        return;
      }
      stopped = false;
      tick();
      timer = setInterval(tick, intervalMs);
      timer.unref();
      logger.info(`personal-weather reminder reconciler started (interval=${intervalMs}ms)`);
    },
    stop(ctx) {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      logger = ctx.logger;
      logger.info("personal-weather reminder reconciler stopped");
    },
  };
}

function normalizeInterval(value: number | undefined): number {
  if (value === undefined) return REMINDER_RECONCILER_INTERVAL_MS;
  if (!Number.isSafeInteger(value) || value < 5_000 || value > 86_400_000) {
    throw new Error("Reminder reconciler interval must be an integer between 5000 and 86400000 ms");
  }
  return value;
}

type ReconcilerLock = { token: string };

function acquireReconcilerLock(lockPath: string): ReconcilerLock | undefined {
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = openSync(
        lockPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      try {
        writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token }), { encoding: "utf8" });
      } finally {
        closeSync(descriptor);
      }
      return { token };
    } catch (error) {
      if (!isAlreadyExists(error) || !isStaleLock(lockPath)) return undefined;
      try {
        unlinkSync(lockPath);
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function releaseReconcilerLock(lockPath: string, token: string): void {
  try {
    const stat = lstatSync(lockPath);
    if (stat.isSymbolicLink() || !stat.isFile()) return;
    const metadata = JSON.parse(readFileSync(lockPath, "utf8")) as { token?: unknown };
    if (metadata.token === token) unlinkSync(lockPath);
  } catch {
    // The lock is only a duplicate-run guard; never let cleanup mask a pass result.
  }
}

function isStaleLock(lockPath: string): boolean {
  try {
    const stat = lstatSync(lockPath);
    if (stat.isSymbolicLink() || !stat.isFile()) return false;
    const metadata = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: unknown };
    if (!Number.isInteger(metadata.pid) || (metadata.pid as number) <= 0) return false;
    try {
      process.kill(metadata.pid as number, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
  } catch {
    return false;
  }
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "EEXIST");
}
