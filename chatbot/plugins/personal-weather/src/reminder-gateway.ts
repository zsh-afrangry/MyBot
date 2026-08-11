import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ReminderCronAddInput, ReminderCronUpdateInput } from "./reminders.js";

const REMINDER_PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Builds the only Cron shape the reminder plugin may register. The Gateway
 * `cron.add` API expects job fields at the root (not inside a `job` envelope).
 * Keeping it pure makes that version-sensitive boundary directly testable.
 */
export function buildReminderCronAddParams(input: ReminderCronAddInput): Record<string, unknown> {
  return {
    name: `kurumi.personal-reminder.${input.reminderId}`,
    declarationKey: input.declarationKey ?? input.eventKey,
    enabled: true,
    schedule: {
      kind: "at",
      at: new Date(input.scheduledAtUtc * 1000).toISOString(),
    },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: {
      kind: "command",
      argv: [process.execPath, "dist/reminder-cli.js", "deliver", "--id", input.reminderId],
      cwd: REMINDER_PLUGIN_ROOT,
      timeoutSeconds: 20,
      noOutputTimeoutSeconds: 10,
      outputMaxBytes: 4096,
    },
    delivery: {
      mode: "announce",
      channel: "qqbot",
      to: input.delivery.to,
      ...(input.delivery.accountId ? { accountId: input.delivery.accountId } : {}),
    },
    deleteAfterRun: true,
  };
}

/** The only Gateway patch shape exposed to reminder updates.  The managed job
 * identity and declaration key remain unchanged, so updating a reminder does
 * not create a duplicate Cron declaration. */
export function buildReminderCronUpdateParams(input: ReminderCronUpdateInput): Record<string, unknown> {
  return {
    id: input.jobId,
    patch: {
      schedule: {
        kind: "at",
        at: new Date(input.scheduledAtUtc * 1000).toISOString(),
      },
    },
  };
}
