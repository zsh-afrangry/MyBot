import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { main as reminderCliMain } from "./reminder-cli.js";
import { reminderStateDirectory } from "./paths.js";
import { ReminderStore, REMINDER_TIMEZONE } from "./reminder-store.js";
import {
  commitReminderProposal,
  getReminderState,
  proposeReminderCancellation,
  proposeReminderCreate,
  proposeReminderUpdate,
  type ReminderCronScheduler,
  type TrustedReminderContext,
} from "./reminders.js";

const NOW_UTC = Math.floor(Date.parse("2026-08-12T12:00:00Z") / 1000);
const CONTEXT: TrustedReminderContext = {
  delivery: { channel: "qqbot", to: "qqbot:c2c:test-owner", accountId: "default" },
};

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("personal reminders", () => {
  it("creates a hash-bound proposal and schedules it exactly once after confirmation", async () => {
    const { store } = createStore();
    try {
      const proposed = proposeReminderCreate(store, createInput("2026-08-12T20:30", "早点睡觉"), CONTEXT);
      expect(proposed.ok).toBe(true);
      if (!proposed.ok) return;

      const scheduler = fakeScheduler();
      const committed = await commitReminderProposal(
        store,
        { proposal_id: proposed.proposalId, payload_hash: proposed.payloadHash },
        CONTEXT,
        scheduler.value,
      );
      expect(committed).toMatchObject({ ok: true, status: "scheduled", idempotent: false });
      expect(scheduler.add).toHaveBeenCalledTimes(1);
      expect(scheduler.add.mock.calls[0]?.[0]).toMatchObject({
        scheduledAtUtc: Math.floor(Date.parse("2026-08-12T12:30:00Z") / 1000),
        delivery: CONTEXT.delivery,
      });
      expect(JSON.stringify(scheduler.add.mock.calls[0]?.[0])).not.toContain("早点睡觉");

      const again = await commitReminderProposal(
        store,
        { proposal_id: proposed.proposalId, payload_hash: proposed.payloadHash },
        CONTEXT,
        scheduler.value,
      );
      expect(again).toMatchObject({ ok: true, status: "scheduled", idempotent: true });
      expect(scheduler.add).toHaveBeenCalledTimes(1);
    } finally {
      store.close();
    }
  });

  it("rejects past or ambiguous local times before persisting a proposal", () => {
    const { store } = createStore();
    try {
      expect(proposeReminderCreate(store, createInput("2026-08-12T19:59", "喝水"), CONTEXT)).toMatchObject({
        ok: false,
        error: { code: "invalid_input" },
      });
      expect(proposeReminderCreate(store, createInput("今晚", "喝水"), CONTEXT)).toMatchObject({
        ok: false,
        error: { code: "invalid_input" },
      });
    } finally {
      store.close();
    }
  });

  it("requires a separate confirmed cancellation and removes only the managed job", async () => {
    const { store } = createStore();
    try {
      const created = proposeReminderCreate(store, createInput("2026-08-12T20:30", "收拾行李"), CONTEXT);
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const scheduler = fakeScheduler();
      const scheduled = await commitReminderProposal(
        store,
        { proposal_id: created.proposalId, payload_hash: created.payloadHash },
        CONTEXT,
        scheduler.value,
      );
      expect(scheduled.ok).toBe(true);
      if (!scheduled.ok) return;

      const cancelledPreview = proposeReminderCancellation(store, {
        schema_version: 1,
        request: { kind: "reminder.cancel", reminder_id: scheduled.reminder.reminderId },
      }, CONTEXT);
      expect(cancelledPreview).toMatchObject({ ok: true, kind: "reminder_cancel" });
      if (!cancelledPreview.ok) return;

      const cancelled = await commitReminderProposal(
        store,
        { proposal_id: cancelledPreview.proposalId, payload_hash: cancelledPreview.payloadHash },
        CONTEXT,
        scheduler.value,
      );
      expect(cancelled).toMatchObject({ ok: true, status: "cancelled" });
      expect(scheduler.remove).toHaveBeenCalledWith({ jobId: "managed-cron-job" });
      expect(getReminderState(store).activeReminders).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("updates an existing reminder in place and is idempotent", async () => {
    const { store } = createStore();
    try {
      const created = proposeReminderCreate(store, createInput("2026-08-12T20:30", "早点睡觉"), CONTEXT);
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const scheduler = fakeScheduler();
      const scheduled = await commitReminderProposal(
        store,
        { proposal_id: created.proposalId, payload_hash: created.payloadHash },
        CONTEXT,
        scheduler.value,
      );
      expect(scheduled.ok).toBe(true);
      if (!scheduled.ok) return;

      const proposed = proposeReminderUpdate(store, updateInput(
        scheduled.reminder.reminderId,
        "2026-08-12T21:00",
        "准备睡觉",
      ), CONTEXT);
      expect(proposed).toMatchObject({
        ok: true,
        kind: "reminder_update",
        canonicalFacts: {
          kind: "reminder.update",
          previousContent: "早点睡觉",
          content: "准备睡觉",
          schedule: { localDateTime: "2026-08-12T21:00", timezone: REMINDER_TIMEZONE },
        },
      });
      if (!proposed.ok) return;

      const updated = await commitReminderProposal(
        store,
        { proposal_id: proposed.proposalId, payload_hash: proposed.payloadHash },
        CONTEXT,
        scheduler.value,
      );
      expect(updated).toMatchObject({ ok: true, status: "updated", idempotent: false });
      expect(scheduler.add).toHaveBeenCalledTimes(1);
      expect(scheduler.remove).not.toHaveBeenCalled();
      expect(scheduler.update).toHaveBeenCalledTimes(1);
      expect(scheduler.update).toHaveBeenCalledWith({
        jobId: "managed-cron-job",
        scheduledAtUtc: Math.floor(Date.parse("2026-08-12T13:00:00Z") / 1000),
      });
      expect(store.getReminder(scheduled.reminder.reminderId)).toMatchObject({
        content: "准备睡觉",
        scheduledAtUtc: Math.floor(Date.parse("2026-08-12T13:00:00Z") / 1000),
        cronJobId: "managed-cron-job",
        status: "scheduled",
      });
      expect(store.getRetryStatus(scheduled.reminder.reminderId)).toBe("scheduled");

      const again = await commitReminderProposal(
        store,
        { proposal_id: proposed.proposalId, payload_hash: proposed.payloadHash },
        CONTEXT,
        scheduler.value,
      );
      expect(again).toMatchObject({ ok: true, status: "updated", idempotent: true });
      expect(scheduler.update).toHaveBeenCalledTimes(1);
    } finally {
      store.close();
    }
  });

  it("supports content-only changes without a Gateway schedule call", async () => {
    const { store } = createStore();
    try {
      const created = proposeReminderCreate(store, createInput("2026-08-12T20:30", "原内容"), CONTEXT);
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const scheduler = fakeScheduler();
      const scheduled = await commitReminderProposal(
        store,
        { proposal_id: created.proposalId, payload_hash: created.payloadHash },
        CONTEXT,
        scheduler.value,
      );
      expect(scheduled.ok).toBe(true);
      if (!scheduled.ok) return;
      const proposed = proposeReminderUpdate(store, {
        schema_version: 1,
        request: { kind: "reminder.update", reminder_id: scheduled.reminder.reminderId, content: "新内容" },
      }, CONTEXT);
      expect(proposed.ok).toBe(true);
      if (!proposed.ok) return;
      const updated = await commitReminderProposal(
        store,
        { proposal_id: proposed.proposalId, payload_hash: proposed.payloadHash },
        CONTEXT,
        scheduler.value,
      );
      expect(updated).toMatchObject({ ok: true, status: "updated" });
      expect(scheduler.update).not.toHaveBeenCalled();
      expect(store.getRetryStatus(scheduled.reminder.reminderId)).toBe("scheduled");
      expect(store.getReminder(scheduled.reminder.reminderId)?.content).toBe("新内容");
    } finally {
      store.close();
    }
  });

  it("keeps an update outcome unknown without retrying or allowing another write", async () => {
    const { store } = createStore();
    try {
      const created = proposeReminderCreate(store, createInput("2026-08-12T20:30", "待核对"), CONTEXT);
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const scheduler = fakeScheduler();
      const scheduled = await commitReminderProposal(
        store,
        { proposal_id: created.proposalId, payload_hash: created.payloadHash },
        CONTEXT,
        scheduler.value,
      );
      expect(scheduled.ok).toBe(true);
      if (!scheduled.ok) return;
      scheduler.update.mockRejectedValue(new Error("Gateway response lost"));
      const proposed = proposeReminderUpdate(store, updateInput(
        scheduled.reminder.reminderId,
        "2026-08-12T21:00",
        "待核对的新内容",
      ), CONTEXT);
      expect(proposed.ok).toBe(true);
      if (!proposed.ok) return;
      const updated = await commitReminderProposal(
        store,
        { proposal_id: proposed.proposalId, payload_hash: proposed.payloadHash },
        CONTEXT,
        scheduler.value,
      );
      expect(updated).toMatchObject({ ok: true, status: "update_unknown", warnings: expect.any(Array) });
      expect(store.getRetryStatus(scheduled.reminder.reminderId)).toBe("unknown");
      expect(store.getReminder(scheduled.reminder.reminderId)).toMatchObject({
        content: "待核对的新内容",
        status: "scheduled",
        failureCode: "cron_update_unknown",
      });
      const repeated = await commitReminderProposal(
        store,
        { proposal_id: proposed.proposalId, payload_hash: proposed.payloadHash },
        CONTEXT,
        scheduler.value,
      );
      expect(repeated).toMatchObject({ ok: true, status: "update_unknown", idempotent: true });
      expect(scheduler.update).toHaveBeenCalledTimes(1);
      const cancel = proposeReminderCancellation(store, {
        schema_version: 1,
        request: { kind: "reminder.cancel", reminder_id: scheduled.reminder.reminderId },
      }, CONTEXT);
      expect(cancel).toMatchObject({ ok: false, error: { code: "reminder_unavailable" } });
      const anotherUpdate = proposeReminderUpdate(store, updateInput(
        scheduled.reminder.reminderId,
        "2026-08-12T21:30",
        "不应再次写入",
      ), CONTEXT);
      expect(anotherUpdate).toMatchObject({ ok: false, error: { code: "reminder_unavailable" } });
      expect(scheduler.update).toHaveBeenCalledTimes(1);
    } finally {
      store.close();
    }
  });

  it("blocks cancellation while cron registration remains uncertain", async () => {
    const { store } = createStore();
    try {
      const created = proposeReminderCreate(store, createInput("2026-08-12T20:30", "不确定状态"), CONTEXT);
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const scheduler = fakeScheduler();
      scheduler.add.mockRejectedValue(new Error("registration response lost"));
      const scheduled = await commitReminderProposal(
        store,
        { proposal_id: created.proposalId, payload_hash: created.payloadHash },
        CONTEXT,
        scheduler.value,
      );
      expect(scheduled).toMatchObject({ ok: true, status: "scheduling_failed" });
      if (!scheduled.ok) return;

      const cancellation = proposeReminderCancellation(store, {
        schema_version: 1,
        request: { kind: "reminder.cancel", reminder_id: scheduled.reminder.reminderId },
      }, CONTEXT);
      expect(cancellation).toMatchObject({
        ok: false,
        error: { code: "reminder_unavailable" },
      });
      if (cancellation.ok) return;
      expect(cancellation.error.message).toContain("不确定");
      expect(scheduler.remove).not.toHaveBeenCalled();
      expect(store.getRetryStatus(scheduled.reminder.reminderId)).toBe("unknown");
    } finally {
      store.close();
    }
  });

  it("converts a cross-day Shanghai local time to the prior UTC date", () => {
    const { store } = createStore();
    try {
      const proposed = proposeReminderCreate(store, createInput("2026-08-13T00:05", "跨日测试"), CONTEXT);
      expect(proposed).toMatchObject({
        ok: true,
        canonicalFacts: {
          schedule: {
            localDateTime: "2026-08-13T00:05",
            atUtc: Math.floor(Date.parse("2026-08-12T16:05:00Z") / 1000),
            timezone: REMINDER_TIMEZONE,
          },
        },
      });
    } finally {
      store.close();
    }
  });

  it("rejects a changed hash and expires a stale proposal without creating a reminder", async () => {
    let now = NOW_UTC;
    const stateDirectory = join(createDirectory(), "state");
    const store = new ReminderStore({ stateDirectory, now: () => now });
    try {
      const proposed = proposeReminderCreate(store, createInput("2026-08-12T20:30", "过期测试"), CONTEXT);
      expect(proposed.ok).toBe(true);
      if (!proposed.ok) return;
      expect(await commitReminderProposal(
        store,
        { proposal_id: proposed.proposalId, payload_hash: "0".repeat(64) },
        CONTEXT,
        fakeScheduler().value,
      )).toMatchObject({ ok: false, error: { code: "proposal_hash_mismatch" } });

      now += 24 * 60 * 60;
      expect(await commitReminderProposal(
        store,
        { proposal_id: proposed.proposalId, payload_hash: proposed.payloadHash },
        CONTEXT,
        fakeScheduler().value,
      )).toMatchObject({ ok: false, error: { code: "proposal_expired" } });
      expect(store.listActiveSummaries()).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("claims a due reminder once and prints deterministic text without a model call", async () => {
    const baseDirectory = createDirectory();
    const stateDirectory = reminderStateDirectory({ OPENCLAW_STATE_DIR: baseDirectory });
    const store = new ReminderStore({ stateDirectory, now: () => NOW_UTC });
    try {
      const proposed = proposeReminderCreate(store, createInput("2026-08-12T20:30", "起身活动"), CONTEXT);
      expect(proposed.ok).toBe(true);
      if (!proposed.ok) return;
      const scheduler = fakeScheduler();
      const scheduled = await commitReminderProposal(
        store,
        { proposal_id: proposed.proposalId, payload_hash: proposed.payloadHash },
        CONTEXT,
        scheduler.value,
      );
      expect(scheduled.ok).toBe(true);
      if (!scheduled.ok) return;
      store.close();

      const previousStateDirectory = process.env.OPENCLAW_STATE_DIR;
      process.env.OPENCLAW_STATE_DIR = baseDirectory;
      const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        const originalNow = Date.now;
        Date.now = () => Date.parse("2026-08-12T12:31:00Z");
        expect(await reminderCliMain(["deliver", "--id", scheduled.reminder.reminderId])).toBe(0);
        expect(await reminderCliMain(["deliver", "--id", scheduled.reminder.reminderId])).toBe(0);
        expect(output).toHaveBeenCalledTimes(1);
        expect(output).toHaveBeenCalledWith("主人，提醒时间到了：起身活动\n");
        Date.now = originalNow;
      } finally {
        output.mockRestore();
        if (previousStateDirectory === undefined) delete process.env.OPENCLAW_STATE_DIR;
        else process.env.OPENCLAW_STATE_DIR = previousStateDirectory;
      }
    } finally {
      store.close();
    }
  });

  it("creates a 0700 state directory and a 0600 SQLite database", () => {
    const { store, stateDirectory } = createStore();
    try {
      expect(statSync(stateDirectory).mode & 0o777).toBe(0o700);
      expect(statSync(store.databasePath).mode & 0o777).toBe(0o600);
    } finally {
      store.close();
    }
  });
});

function createStore(): { store: ReminderStore; stateDirectory: string } {
  const stateDirectory = join(createDirectory(), "state");
  return { store: new ReminderStore({ stateDirectory, now: () => NOW_UTC }), stateDirectory };
}

function createDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "kurumi-reminder-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function createInput(localDateTime: string, content: string) {
  return {
    schema_version: 1 as const,
    request: {
      kind: "reminder.create" as const,
      content,
      schedule: { local_date_time: localDateTime, timezone: REMINDER_TIMEZONE },
    },
  };
}

function updateInput(reminderId: string, localDateTime: string, content: string) {
  return {
    schema_version: 1 as const,
    request: {
      kind: "reminder.update" as const,
      reminder_id: reminderId,
      content,
      schedule: { local_date_time: localDateTime, timezone: REMINDER_TIMEZONE },
    },
  };
}

function fakeScheduler(): {
  value: ReminderCronScheduler;
  add: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
} {
  const add = vi.fn<ReminderCronScheduler["add"]>().mockResolvedValue({ jobId: "managed-cron-job" });
  const remove = vi.fn<ReminderCronScheduler["remove"]>().mockResolvedValue(undefined);
  const update = vi.fn<NonNullable<ReminderCronScheduler["update"]>>().mockResolvedValue(undefined);
  return { value: { add, remove, update }, add, remove, update };
}
