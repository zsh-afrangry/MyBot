import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function weatherStateDirectory(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const openClawState = env.OPENCLAW_STATE_DIR?.trim()
    ? resolve(env.OPENCLAW_STATE_DIR)
    : join(homedir(), ".openclaw");
  return join(openClawState, "state", "personal-weather");
}
