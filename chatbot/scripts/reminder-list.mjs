#!/usr/bin/env node
// Fixed native-Cron runner. Writes digest claims (plus expiry in SQLite mode) to
// the configured private state; stdout is announced by OpenClaw to the configured owner QQ.
// The authenticated domain endpoint generates a bound model notice. No raw content,
// recipient, URL or executable is accepted from argv. Failures exit nonzero without
// stdout/stderr: native Cron announces either stream. Diagnostics stay in the domain/Cron ledger.
import {pathToFileURL} from 'node:url';
import {requestAssistantNotice} from '../packages/response-core/index.js';
export async function main(argv = process.argv.slice(2), {env = process.env, write = value => process.stdout.write(value), request} = {}) {
  if (argv.length !== 3 || argv[0] !== 'run' || argv[1] !== '--slot' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(argv[2])) throw Error('usage: reminder-list run --slot HH:mm');
  const result=await requestAssistantNotice('personal-reminder-list.compose',{slot:argv[2]},{env,request});
  if(result.text)write(result.text+'\n');
  return 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = await main(); }
  catch { process.exitCode = 1; }
}
