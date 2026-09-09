import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, resolve, join } from "node:path";

// A fresh process may reopen only a test directory bearing the expected prefix.
const directory = resolve(process.argv[2] || "");
if (!basename(directory).startsWith("kurumi-acceptance-")) throw Error("Refusing non-test state directory");
process.env.OPENCLAW_STATE_DIR = directory;
process.env.OPENCLAW_CONFIG_PATH = join(directory, "openclaw.json");
const checkpoint = JSON.parse(readFileSync(join(directory, "restart-checkpoint.json"), "utf8"));
const { WeatherStore } = await import("../../plugins/personal-weather/dist/store.js");
const { commitPlanningProposal } = await import("../../plugins/personal-weather/dist/planning.js");
const store = new WeatherStore({ stateDirectory: join(directory, "state/personal-weather") });
try {
  const before = store.listTripSummaries().length;
  const result = commitPlanningProposal(store, checkpoint.input, checkpoint.scope);
  assert.equal(result.ok, true); assert.equal(result.idempotent, true);
  assert.equal(store.listTripSummaries().length, before);
  writeFileSync(join(directory, "restart-result.json"), JSON.stringify({ passed: true, trips: before, idempotent: result.idempotent }));
} finally { store.close(); }
