#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import { reminderStateDirectory } from "./paths.js";
import { ReminderStore } from "./reminder-store.js";

/**
 * The only executable a reminder Cron job may run. It accepts a UUID generated
 * by the plugin, reads the frozen record, and prints one fixed-format line for
 * Gateway announce delivery. It never invokes an LLM or accepts content/to/URL
 * from argv.
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const [command, ...args] = argv;
  if (command !== "deliver") {
    process.stderr.write("usage: reminder-cli deliver --id <uuid>\n");
    return 2;
  }
  const reminderId = readReminderId(args);
  if (!reminderId) {
    process.stderr.write("invalid reminder id\n");
    return 2;
  }
  const store = new ReminderStore({ stateDirectory: reminderStateDirectory() });
  try {
    const reminder = store.claimForDelivery(reminderId, store.getNowUtc());
    // Cancelled, duplicated, or prematurely fired jobs deliberately produce no
    // message. A second delivery must never be created from this process.
    if (!reminder) return 0;
    process.stdout.write(`主人，提醒时间到了：${reminder.content}\n`);
    return 0;
  } finally {
    store.close();
  }
}

function readReminderId(args: string[]): string | undefined {
  if (args.length !== 2 || args[0] !== "--id") return undefined;
  const candidate = args[1]?.toLowerCase();
  return candidate && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(candidate)
    ? candidate
    : undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
