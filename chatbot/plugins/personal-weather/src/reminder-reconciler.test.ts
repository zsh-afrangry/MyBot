import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { reminderStateDirectory } from "./paths.js";
import { ReminderStore, REMINDER_TIMEZONE } from "./reminder-store.js";
import { reconcileReminderState } from "./reminder-reconciler.js";
import { commitReminderProposal, proposeReminderCreate, type ReminderCronScheduler } from "./reminders.js";

const NOW_UTC = Math.floor(Date.parse("2026-08-12T12:00:00Z") / 1000);
const CONTEXT = {
  delivery: { channel: "qqbot" as const, to: "qqbot:c2c:test-owner", accountId: "default" },
};
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("personal reminder reconciliation", () => {
  it("adopts a scheduled job and marks the CLI delivery delivered from Gateway run history", async () => {
    const base = mkdtempSync(join(tmpdir(), "kurumi-reconcile-test-"));
    directories.push(base);
    const store = new ReminderStore({
      stateDirectory: reminderStateDirectory({ OPENCLAW_STATE_DIR: base }),
      now: () => NOW_UTC,
    });
    const gatewayPath = join(base, "gateway.sqlite");
    const gateway = new DatabaseSync(gatewayPath);
    gateway.exec(`
      CREATE TABLE cron_jobs (
        job_id TEXT, declaration_key TEXT, last_run_status TEXT,
        last_delivery_status TEXT, last_delivered INTEGER, last_error TEXT, updated_at INTEGER
      );
      CREATE TABLE cron_run_logs (
        job_id TEXT, seq INTEGER, status TEXT, delivery_status TEXT, delivered INTEGER,
        run_at_ms INTEGER, error TEXT, delivery_error TEXT
      );
    `);
    try {
      const proposed = proposeReminderCreate(store, {
        schema_version: 1,
        request: {
          kind: "reminder.create",
          content: "对账测试",
          schedule: { local_date_time: "2026-08-12T20:30", timezone: REMINDER_TIMEZONE },
        },
      }, CONTEXT);
      expect(proposed.ok).toBe(true);
      if (!proposed.ok) return;
      const scheduler: ReminderCronScheduler = {
        add: async () => ({ jobId: "managed-job" }),
        remove: async () => undefined,
      };
      const committed = await commitReminderProposal(store, {
        proposal_id: proposed.proposalId,
        payload_hash: proposed.payloadHash,
      }, CONTEXT, scheduler);
      expect(committed.ok).toBe(true);
      if (!committed.ok) return;
      const scheduledAt = committed.reminder.scheduledAtUtc;
      const reminder = store.getReminder(committed.reminder.reminderId);
      expect(reminder?.eventKey).toBeTruthy();
      store.claimForDelivery(committed.reminder.reminderId, scheduledAt);
      const eventKey = reminder?.eventKey;
      if (!eventKey) throw new Error("test reminder did not have an event key");
      gateway.prepare(`
        INSERT INTO cron_jobs VALUES (?, ?, NULL, NULL, NULL, NULL, ?)
      `).run("managed-job", eventKey, NOW_UTC * 1000);
      gateway.prepare(`
        INSERT INTO cron_run_logs VALUES (?, 1, 'ok', 'delivered', 1, ?, NULL, NULL)
      `).run("managed-job", scheduledAt * 1000);
      gateway.close();

      const reconciled = reconcileReminderState(store, {
        gatewayDatabasePath: gatewayPath,
        nowUtc: scheduledAt + 5,
      });
      expect(reconciled).toMatchObject({ scanned: 1, delivered: 1, failed: 0 });
      expect(store.getReminder(committed.reminder.reminderId)?.status).toBe("delivered");
    } finally {
      store.close();
      try { gateway.close(); } catch { /* already closed */ }
    }
  });

  it("bounds Gateway failure diagnostics before writing the reminder failure code", async () => {
    const base = mkdtempSync(join(tmpdir(), "kurumi-reconcile-failure-"));
    directories.push(base);
    const store = new ReminderStore({
      stateDirectory: reminderStateDirectory({ OPENCLAW_STATE_DIR: base }),
      now: () => NOW_UTC,
    });
    const gatewayPath = join(base, "gateway.sqlite");
    const gateway = new DatabaseSync(gatewayPath);
    gateway.exec(`
      CREATE TABLE cron_jobs (
        job_id TEXT, declaration_key TEXT, last_run_status TEXT,
        last_delivery_status TEXT, last_delivered INTEGER, last_error TEXT, updated_at INTEGER
      );
      CREATE TABLE cron_run_logs (
        job_id TEXT, seq INTEGER, status TEXT, delivery_status TEXT, delivered INTEGER,
        run_at_ms INTEGER, error TEXT, delivery_error TEXT
      );
    `);
    try {
      const proposed = proposeReminderCreate(store, {
        schema_version: 1,
        request: {
          kind: "reminder.create",
          content: "失败对账测试",
          schedule: { local_date_time: "2026-08-12T20:30", timezone: REMINDER_TIMEZONE },
        },
      }, CONTEXT);
      expect(proposed.ok).toBe(true);
      if (!proposed.ok) return;
      const committed = await commitReminderProposal(store, {
        proposal_id: proposed.proposalId,
        payload_hash: proposed.payloadHash,
      }, CONTEXT, { add: async () => ({ jobId: "failed-job" }), remove: async () => undefined });
      expect(committed.ok).toBe(true);
      if (!committed.ok) return;
      const reminder = store.getReminder(committed.reminder.reminderId);
      if (!reminder?.eventKey) throw new Error("test reminder did not have an event key");
      store.claimForDelivery(committed.reminder.reminderId, committed.reminder.scheduledAtUtc);
      gateway.prepare("INSERT INTO cron_jobs VALUES (?, ?, NULL, NULL, NULL, NULL, ?)")
        .run("failed-job", reminder.eventKey, NOW_UTC * 1000);
      gateway.prepare("INSERT INTO cron_run_logs VALUES (?, 1, 'error', 'failed', 0, ?, ?, ?)")
        .run(
          "failed-job",
          committed.reminder.scheduledAtUtc * 1000,
          "gateway error with spaces and symbols ".repeat(20),
          "qq delivery unavailable ".repeat(20),
        );
      gateway.close();

      const reconciled = reconcileReminderState(store, {
        gatewayDatabasePath: gatewayPath,
        nowUtc: committed.reminder.scheduledAtUtc + 5 * 60,
      });
      expect(reconciled).toMatchObject({ scanned: 1, delivered: 0, failed: 1 });
      const failureCode = store.getReminder(committed.reminder.reminderId)?.failureCode;
      expect(failureCode).toMatch(/^[a-z0-9_.-]+$/);
      expect(failureCode?.length).toBeLessThanOrEqual(80);
    } finally {
      store.close();
      try { gateway.close(); } catch { /* already closed */ }
    }
  });

  it("marks a past-due reminder unknown when no Gateway run can prove delivery", async () => {
    const base = mkdtempSync(join(tmpdir(), "kurumi-reconcile-unknown-delivery-"));
    directories.push(base);
    const store = new ReminderStore({
      stateDirectory: reminderStateDirectory({ OPENCLAW_STATE_DIR: base }),
      now: () => NOW_UTC,
    });
    const gatewayPath = join(base, "gateway.sqlite");
    const gateway = new DatabaseSync(gatewayPath);
    gateway.exec(`
      CREATE TABLE cron_jobs (
        job_id TEXT, declaration_key TEXT, last_run_status TEXT,
        last_delivery_status TEXT, last_delivered INTEGER, last_error TEXT, updated_at INTEGER
      );
      CREATE TABLE cron_run_logs (
        job_id TEXT, seq INTEGER, status TEXT, delivery_status TEXT, delivered INTEGER,
        run_at_ms INTEGER, error TEXT, delivery_error TEXT
      );
    `);
    try {
      const proposed = proposeReminderCreate(store, {
        schema_version: 1,
        request: {
          kind: "reminder.create",
          content: "停机恢复未知状态",
          schedule: { local_date_time: "2026-08-12T20:30", timezone: REMINDER_TIMEZONE },
        },
      }, CONTEXT);
      expect(proposed.ok).toBe(true);
      if (!proposed.ok) return;
      const committed = await commitReminderProposal(store, {
        proposal_id: proposed.proposalId,
        payload_hash: proposed.payloadHash,
      }, CONTEXT, { add: async () => ({ jobId: "missing-from-gateway" }), remove: async () => undefined });
      expect(committed.ok).toBe(true);
      if (!committed.ok) return;
      const pastDue = committed.reminder.scheduledAtUtc + 5 * 60 + 1;
      const reconciled = reconcileReminderState(store, { gatewayDatabasePath: gatewayPath, nowUtc: pastDue });
      expect(reconciled).toMatchObject({ scanned: 1, failed: 1, delivered: 0 });
      expect(store.getReminder(committed.reminder.reminderId)).toMatchObject({
        status: "failed",
        failureCode: "delivery_unknown",
      });
      expect(store.getRetryStatus(committed.reminder.reminderId)).toBe("unknown");
      expect(store.listDueRetryCandidates(pastDue + 3600)).toHaveLength(0);
    } finally {
      store.close();
      gateway.close();
    }
  });
});
