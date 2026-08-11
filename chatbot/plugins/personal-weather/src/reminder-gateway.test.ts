import { describe, expect, it } from "vitest";

import { buildReminderCronAddParams, buildReminderCronUpdateParams } from "./reminder-gateway.js";

describe("reminder Gateway Cron adapter", () => {
  it("uses the current flat cron.add request shape and never includes reminder content", () => {
    const params = buildReminderCronAddParams({
      reminderId: "11111111-2222-4333-8444-555555555555",
      scheduledAtUtc: Math.floor(Date.parse("2026-08-12T02:00:00Z") / 1000),
      eventKey: "personal-reminder:11111111-2222-4333-8444-555555555555:1786490400",
      delivery: {
        channel: "qqbot",
        to: "qqbot:c2c:test-owner",
        accountId: "default",
      },
    });

    expect(params).toMatchObject({
      name: "kurumi.personal-reminder.11111111-2222-4333-8444-555555555555",
      declarationKey: "personal-reminder:11111111-2222-4333-8444-555555555555:1786490400",
      schedule: { kind: "at", at: "2026-08-12T02:00:00.000Z" },
      payload: {
        kind: "command",
        argv: [process.execPath, "dist/reminder-cli.js", "deliver", "--id", "11111111-2222-4333-8444-555555555555"],
      },
      delivery: { mode: "announce", channel: "qqbot", to: "qqbot:c2c:test-owner", accountId: "default" },
      deleteAfterRun: true,
    });
    expect(params).not.toHaveProperty("job");
    expect(JSON.stringify(params)).not.toContain("提醒模块验收");

    expect(buildReminderCronAddParams({
      reminderId: "11111111-2222-4333-8444-555555555555",
      scheduledAtUtc: Math.floor(Date.parse("2026-08-12T02:00:00Z") / 1000),
      eventKey: "canonical-event-key",
      declarationKey: "canonical-event-key:retry:2",
      delivery: { channel: "qqbot", to: "qqbot:c2c:test-owner", accountId: "default" },
    }).declarationKey).toBe("canonical-event-key:retry:2");
  });

  it("updates only the existing managed job schedule", () => {
    expect(buildReminderCronUpdateParams({
      jobId: "gateway-job-123",
      scheduledAtUtc: Math.floor(Date.parse("2026-08-12T02:10:00Z") / 1000),
    })).toEqual({
      id: "gateway-job-123",
      patch: { schedule: { kind: "at", at: "2026-08-12T02:10:00.000Z" } },
    });
  });
});
