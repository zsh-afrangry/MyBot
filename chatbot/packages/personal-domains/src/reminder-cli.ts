#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import {requestAssistantNotice} from "../../response-core/index.js";

/**
 * The only executable a reminder Cron job may run. It accepts a UUID generated
 * by the plugin. The authenticated domain endpoint claims the frozen record
 * and generates its bound assistant notice for native announce delivery.
 * Content/to/URL are never accepted from argv; generation failure prints nothing.
 */
export async function main(argv: string[] = process.argv.slice(2), options:Parameters<typeof requestAssistantNotice>[2]={}): Promise<number> {
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
  try {
    const result=await requestAssistantNotice('personal-reminder.compose',{id:reminderId},options);
    if(result.text)process.stdout.write(result.text+'\n');
    return 0;
  }catch{process.stderr.write('Reminder notice generation unavailable; inspect domain/Cron receipts\n');return 1;}

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
