import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function weatherStateDirectory(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(openClawStateDirectory(env), "state", "personal-weather");
}

/**
 * Kept separate from weather.sqlite so reminder retention, recovery, and a
 * future extraction into its own plugin never require a weather schema change.
 */
export function reminderStateDirectory(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(openClawStateDirectory(env), "state", "personal-reminders");
}

export function openClawStateDirectory(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return env.OPENCLAW_STATE_DIR?.trim()
    ? resolve(env.OPENCLAW_STATE_DIR)
    : join(homedir(), ".openclaw");
}

export function gatewayStateDatabasePath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(openClawStateDirectory(env), "state", "openclaw.sqlite");
}
