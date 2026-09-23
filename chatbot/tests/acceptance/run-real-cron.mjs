import assert from "node:assert/strict";
import { writeFileSync, openSync, closeSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { createHostDriver } from "./host-driver.mjs";
import { createDomainFixture } from "./domain-fixture.mjs";

const driver = await createHostDriver();
const fixture = await createDomainFixture(driver);
const host = process.env.OPENCLAW_HOST_ROOT || "/home/afrangry/.npm-global/lib/node_modules/openclaw";
const { callGatewayFromCli } = await import(pathToFileURL(join(host, "dist/plugin-sdk/gateway-runtime.js")));
const { buildReminderCronAddParams, buildReminderCronUpdateParams } = await import("../../plugins/personal-weather/dist/reminder-gateway.js");
const portProbe = createServer();
await new Promise((resolve, reject) => { portProbe.once("error", reject); portProbe.listen(0, "127.0.0.1", resolve); });
const port = portProbe.address().port;
await new Promise(resolve => portProbe.close(resolve));
const token = randomUUID();
const cfg = { agents: { defaults: { workspace: driver.cfg.agents.defaults.workspace } }, plugins: { enabled: false },
  gateway: { mode: "local", port, bind: "loopback", auth: { mode: "token", token: "${OPENCLAW_GATEWAY_TOKEN}" }, controlUi: { enabled: false } },
  discovery: { mdns: { mode: "off" } } };
writeFileSync(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify(cfg, null, 2));
const logFd = openSync(join(driver.directory, "gateway.log"), "w");
const child = spawn(process.execPath, [join(host, "openclaw.mjs"), "gateway", "run", "--port", String(port), "--bind", "loopback", "--auth", "token", "--tailscale", "off"], {
  env: { ...process.env, OPENCLAW_GATEWAY_TOKEN: token }, stdio: ["ignore", logFd, logFd],
});
closeSync(logFd);
const report = { directory: driver.directory, boundary: "Real isolated Gateway RPC/Cron storage, actual domain transactions and confirmation hook; deterministic cognition; no model or QQ network; jobs scheduled one day ahead and removed before shutdown", tests: [], rpc: [] };
const rpc = (method, params = {}) => callGatewayFromCli(method, { url: `ws://127.0.0.1:${port}`, token, timeout: "5000", json: true }, params);
const scheduler = {
  async add(input) {
    const params = buildReminderCronAddParams(input);
    const result = await rpc("cron.add", params);
    const jobId = result.id ?? result.jobId ?? result.job?.id;
    report.rpc.push({ method: "cron.add", params, result });
    assert.ok(jobId, "Gateway must return a job ID");
    return { jobId };
  },
  async update(input) {
    const params = buildReminderCronUpdateParams(input), result = await rpc("cron.update", params);
    report.rpc.push({ method: "cron.update", params, result });
  },
  async remove(input) {
    const params = { id: input.jobId }, result = await rpc("cron.remove", params);
    report.rpc.push({ method: "cron.remove", params, result });
  },
};
const commit = proposal => driver.dispatch(fixture.confirmation(proposal), () => fixture.reminders.commitReminderProposal(
  fixture.reminder, { proposal_id: proposal.proposalId, payload_hash: proposal.payloadHash }, fixture.reminderContext, scheduler));
const schedule = offset => ({ local_date_time: fixture.reminders.formatShanghaiDateTime(fixture.now() + offset).replace(" ", "T"), timezone: "Asia/Shanghai" });
const jobs = async () => (await rpc("cron.list", { includeDisabled: true })).jobs;
const persist = () => writeFileSync(join(driver.directory, "real-cron-report.json"), JSON.stringify(report, null, 2));
async function check(name, operation) {
  const item = { name, before: fixture.snapshot() }; report.tests.push(item);
  try { await operation(); item.passed = true; }
  catch (error) { item.passed = false; item.error = error.message; throw error; }
  finally { item.after = fixture.snapshot(); persist(); }
}
try {
  let ready = false;
  for (let i = 0; i < 20; i++) {
    if (child.exitCode !== null) throw Error("Isolated Gateway exited during startup; inspect gateway.log");
    try { await rpc("health"); ready = true; break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.ok(ready, "Isolated Gateway did not become ready");
  assert.deepEqual(await jobs(), []);
  let created, originalJobId;
  await check("Create: confirmation grant -> real cron.add -> scheduled reminder", async () => {
    const proposal = fixture.reminders.proposeReminderCreate(fixture.reminder, { schema_version: 1,
      request: { kind: "reminder.create", content: "isolated real Cron acceptance", schedule: schedule(86400) } }, fixture.reminderContext);
    assert.equal(proposal.ok, true);
    created = await commit(proposal);
    assert.equal(created.ok, true, JSON.stringify(created));
    const list = await jobs(); assert.equal(list.length, 1);
    originalJobId = list[0].id;
    assert.equal(list[0].payload.kind, "command");
    assert.equal(list[0].schedule.at, new Date(proposal.canonicalFacts.schedule.atUtc * 1000).toISOString());
    report.created = { result: created, jobs: list };
  });
  await check("Update: new grant -> real cron.update on same job ID", async () => {
    const proposal = fixture.reminders.proposeReminderUpdate(fixture.reminder, { schema_version: 1,
      request: { kind: "reminder.update", reminder_id: created.reminder.reminderId, content: "updated isolated acceptance", schedule: schedule(90000) } }, fixture.reminderContext);
    assert.equal(proposal.ok, true);
    const result = await commit(proposal); assert.equal(result.ok, true, JSON.stringify(result));
    const list = await jobs(); assert.equal(list.length, 1); assert.equal(list[0].id, originalJobId);
    assert.equal(list[0].schedule.at, new Date(proposal.canonicalFacts.schedule.atUtc * 1000).toISOString());
    report.updated = { result, jobs: list };
    const before = report.rpc.length;
    const replay = await commit(proposal); assert.equal(replay.ok, true); assert.equal(report.rpc.length, before);
  });
  await check("Cancel: own grant -> real cron.remove -> cancelled reminder", async () => {
    const proposal = fixture.reminders.proposeReminderCancellation(fixture.reminder, { schema_version: 1,
      request: { kind: "reminder.cancel", reminder_id: created.reminder.reminderId } }, fixture.reminderContext);
    assert.equal(proposal.ok, true);
    const result = await commit(proposal); assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.status, "cancelled"); assert.deepEqual(await jobs(), []);
    report.cancelled = result;
    assert.deepEqual(report.rpc.map(item => item.method), ["cron.add", "cron.update", "cron.remove"]);
  });
  report.status = "passed";
} catch (error) {
  report.status = "failed"; report.error = String(error.message).replaceAll(token, "[redacted]"); process.exitCode = 1;
} finally {
  child.kill("SIGTERM");
  await Promise.race([new Promise(resolve => child.once("exit", resolve)), new Promise(resolve => setTimeout(resolve, 10000))]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  report.gatewayStopped = child.exitCode !== null || child.signalCode !== null;
  fixture.close(); driver.close(); persist();
  console.log(JSON.stringify({ directory: driver.directory, status: report.status, error: report.error, tests: report.tests.map(({ name, passed }) => ({ name, passed })) }));
}
process.exit(process.exitCode || 0);
