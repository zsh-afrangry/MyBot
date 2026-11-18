#!/usr/bin/env node
// Read-only log query over registered files and SQLite sources. docs/18.
import {runCli} from '../packages/log-query/index.js';

try {
  process.exitCode = await runCli();
} catch (error) {
  console.error(`log-query: ${error.message}`);
  process.exitCode = 2;
}
