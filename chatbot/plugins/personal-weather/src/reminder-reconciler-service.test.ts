import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createReminderReconcilerService,
  runReminderRetryMaintenanceOnce,
  runReminderReconcilerOnce,
} from "./reminder-reconciler-service.js";
import { reminderStateDirectory } from "./paths.js";
import { ReminderStore, REMINDER_TIMEZONE } from "./reminder-store.js";
import { commitReminderProposal, proposeReminderCreate, type ReminderCronScheduler } from "./reminders.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("personal reminder reconciler service", () => {
  it("runs a local pass and releases its single-instance lock", () => {
    const base = mkdtempSync(join(tmpdir(), "kurumi-reconciler-service-"));
    directories.push(base);

    const result = runReminderReconcilerOnce({
      stateDirectory: base,
      gatewayDatabasePath: join(base, "missing-gateway.sqlite"),
    });

    expect(result).toMatchObject({ skipped: false, scanned: 0, warnings: [] });
    expect(() => writeFileSync(join(base, "reconciler.lock"), "should be absent")).not.toThrow();
  });

  it("skips when another live service owns the lock", () => {
    const base = mkdtempSync(join(tmpdir(), "kurumi-reconciler-lock-"));
    directories.push(base);
    writeFileSync(
      join(base, "reconciler.lock"),
      JSON.stringify({ pid: process.pid, token: "another-instance" }),
      { mode: 0o600 },
    );

    const result = runReminderReconcilerOnce({ stateDirectory: base });

    expect(result).toMatchObject({ skipped: true, skipReason: "lock_busy" });
  });

  it("takes over a stale lock during restart recovery", () => {
    const base = mkdtempSync(join(tmpdir(), "kurumi-reconciler-stale-lock-"));
    directories.push(base);
    writeFileSync(
      join(base, "reconciler.lock"),
      JSON.stringify({ pid: 999_999_999, token: "stale-instance" }),
      { mode: 0o600 },
    );

    const result = runReminderReconcilerOnce({ stateDirectory: base });

    expect(result).toMatchObject({ skipped: false, scanned: 0, warnings: [] });
    expect(() => writeFileSync(join(base, "reconciler.lock"), "should be absent")).not.toThrow();
  });

  it("starts and stops without exposing a tool or delivery path", () => {
    const base = mkdtempSync(join(tmpdir(), "kurumi-reconciler-lifecycle-"));
    directories.push(base);
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const service = createReminderReconcilerService({
      stateDirectory: base,
      intervalMs: 5_000,
    });

    service.start({ logger } as never);
    service.start({ logger } as never);
    service.stop?.({ logger } as never);

    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("started"));
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("stopped"));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("already_started"));
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("rejects an unsafe polling interval", () => {
    expect(() => createReminderReconcilerService({ intervalMs: 1_000 })).toThrow(
      "between 5000 and 86400000",
    );
  });

  it("retries only a definite delivery failure with a new declaration key", async () => {
    const base = mkdtempSync(join(tmpdir(), "kurumi-reconciler-retry-"));
    directories.push(base);
    const stateDirectory = reminderStateDirectory({ OPENCLAW_STATE_DIR: base });
    const now = Math.floor(Date.parse("2026-08-12T12:00:00Z") / 1000);
    const store = new ReminderStore({ stateDirectory, now: () => now });
    const context = {
      delivery: { channel: "qqbot" as const, to: "qqbot:c2c:test-owner", accountId: "default" },
    };
    try {
      const proposed = proposeReminderCreate(store, {
        schema_version: 1,
        request: {
          kind: "reminder.create",
          content: "重试测试",
          schedule: { local_date_time: "2026-08-12T20:30", timezone: REMINDER_TIMEZONE },
        },
      }, context);
      expect(proposed.ok).toBe(true);
      if (!proposed.ok) return;
      const scheduler: ReminderCronScheduler = { add: async () => ({ jobId: "initial-job" }), remove: async () => undefined };
      const committed = await commitReminderProposal(store, {
        proposal_id: proposed.proposalId,
        payload_hash: proposed.payloadHash,
      }, context, scheduler);
      expect(committed.ok).toBe(true);
      if (!committed.ok) return;
      const reminderId = committed.reminder.reminderId;
      const originalKey = store.getReminder(reminderId)?.eventKey;
      expect(originalKey).toBeTruthy();
      expect(store.markReminderFailed({ reminderId, code: "delivery_failed", atUtc: now })).toBe(true);
      expect(store.listDueRetryCandidates(now + 59)).toHaveLength(0);
      store.close();

      const retryAdd = vi.fn<ReminderCronScheduler["add"]>().mockResolvedValue({ jobId: "retry-job" });
      const result = await runReminderRetryMaintenanceOnce({
        stateDirectory,
        gatewayDatabasePath: join(base, "missing-gateway.sqlite"),
        nowUtc: () => now + 60,
        scheduler: { add: retryAdd, remove: async () => undefined },
      });
      expect(result).toMatchObject({ skipped: false, retriesScheduled: 1, retriesUnknown: 0 });
      expect(retryAdd).toHaveBeenCalledWith(expect.objectContaining({
        reminderId,
        eventKey: originalKey,
        declarationKey: `${originalKey}:retry:2`,
      }));

      const checked = new ReminderStore({ stateDirectory, now: () => now + 60 });
      try {
        expect(checked.getReminder(reminderId)?.status).toBe("scheduled");
        expect(checked.getCurrentDeclarationKey(reminderId)).toBe(`${originalKey}:retry:2`);
        expect(checked.listDueRetryCandidates(now + 60)).toHaveLength(0);
      } finally {
        checked.close();
      }
    } finally {
      try { store.close(); } catch { /* already closed */ }
    }
  });

  it("does not retry an uncertain cron registration", async () => {
    const base = mkdtempSync(join(tmpdir(), "kurumi-reconciler-unknown-"));
    directories.push(base);
    const stateDirectory = reminderStateDirectory({ OPENCLAW_STATE_DIR: base });
    const now = Math.floor(Date.parse("2026-08-12T12:00:00Z") / 1000);
    const store = new ReminderStore({ stateDirectory, now: () => now });
    const context = {
      delivery: { channel: "qqbot" as const, to: "qqbot:c2c:test-owner", accountId: "default" },
    };
    try {
      const proposed = proposeReminderCreate(store, {
        schema_version: 1,
        request: {
          kind: "reminder.create",
          content: "未知状态测试",
          schedule: { local_date_time: "2026-08-12T20:30", timezone: REMINDER_TIMEZONE },
        },
      }, context);
      expect(proposed.ok).toBe(true);
      if (!proposed.ok) return;
      const committed = await commitReminderProposal(store, {
        proposal_id: proposed.proposalId,
        payload_hash: proposed.payloadHash,
      }, context, { add: async () => { throw new Error("response lost"); }, remove: async () => undefined });
      expect(committed).toMatchObject({ ok: true, status: "scheduling_failed" });
      if (!committed.ok) return;
      expect(store.listDueRetryCandidates(now + 3600)).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("marks the third definite failure exhausted and exposes it in state", async () => {
    const base = mkdtempSync(join(tmpdir(), "kurumi-reconciler-exhausted-"));
    directories.push(base);
    const stateDirectory = reminderStateDirectory({ OPENCLAW_STATE_DIR: base });
    const now = Math.floor(Date.parse("2026-08-12T12:00:00Z") / 1000);
    const store = new ReminderStore({ stateDirectory, now: () => now });
    const context = {
      delivery: { channel: "qqbot" as const, to: "qqbot:c2c:test-owner", accountId: "default" },
    };
    try {
      const proposed = proposeReminderCreate(store, {
        schema_version: 1,
        request: {
          kind: "reminder.create",
          content: "耗尽测试",
          schedule: { local_date_time: "2026-08-12T20:30", timezone: REMINDER_TIMEZONE },
        },
      }, context);
      expect(proposed.ok).toBe(true);
      if (!proposed.ok) return;
      const committed = await commitReminderProposal(store, {
        proposal_id: proposed.proposalId,
        payload_hash: proposed.payloadHash,
      }, context, { add: async () => ({ jobId: "initial-job" }), remove: async () => undefined });
      expect(committed.ok).toBe(true);
      if (!committed.ok) return;
      const id = committed.reminder.reminderId;
      expect(store.markReminderFailed({ reminderId: id, code: "delivery_failed", atUtc: now })).toBe(true);
      const retry2 = store.claimReminderRetry(id, now + 60);
      expect(retry2?.attemptCount).toBe(2);
      expect(store.markReminderScheduled({ reminderId: id, cronJobId: "retry-2", atUtc: now + 60 })).toBe(true);
      expect(store.markReminderFailed({ reminderId: id, code: "delivery_failed", atUtc: now + 60 })).toBe(true);
      const retry3 = store.claimReminderRetry(id, now + 60 + 300);
      expect(retry3?.attemptCount).toBe(3);
      expect(store.markReminderScheduled({ reminderId: id, cronJobId: "retry-3", atUtc: now + 360 })).toBe(true);
      expect(store.markReminderFailed({ reminderId: id, code: "delivery_failed", atUtc: now + 360 })).toBe(true);
      expect(store.listDueRetryCandidates(now + 10_000)).toHaveLength(0);
      expect(store.listActiveSummaries()[0]).toMatchObject({
        reminderId: id,
        status: "failed",
        retryStatus: "exhausted",
        attemptCount: 3,
        failureCode: "delivery_failed",
      });
    } finally {
      store.close();
    }
  });
});
