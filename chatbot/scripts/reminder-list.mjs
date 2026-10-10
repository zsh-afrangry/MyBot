#!/usr/bin/env node
// Fixed native-Cron runner. Writes list expiry/digest claims to the configured
// private state; stdout is announced by OpenClaw to the configured owner QQ.
// No model, shell, arbitrary recipient, or user-controlled executable.
import {pathToFileURL} from 'node:url';
import {ListStore, stateRoot} from '../plugins/personal-reminder-list/store.js';
export function main(argv = process.argv.slice(2), {env = process.env, now = Date.now, write = value => process.stdout.write(value)} = {}) {
  if (argv.length !== 3 || argv[0] !== 'run' || argv[1] !== '--slot' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(argv[2])) throw Error('usage: reminder-list run --slot HH:mm');
  const store = new ListStore({root: stateRoot(env), ownerId: env.KURUMI_LIST_OWNER_ID, now});
  try {
    const digest = store.claimDigest(argv[2]);
    if (digest?.text) write(digest.text + '\n');
    return 0;
  } finally { store.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = main(); }
  catch { process.stderr.write('Reminder-list runner failed; inspect domain state and Cron run\n'); process.exitCode = 1; }
}
