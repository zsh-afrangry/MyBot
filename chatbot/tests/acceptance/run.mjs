import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHostDriver } from "./host-driver.mjs";
import { createDomainFixture } from "./domain-fixture.mjs";

const driver = await createHostDriver();
const fixture = await createDomainFixture(driver);
const report = { stage: "host-dispatch", directory: driver.directory, startedAt: new Date().toISOString(),
  boundary: "Real Host dispatcher, confirmation plugin, domain services and SQLite; synthetic QQ input, deterministic cognition, fake scheduler; no QQ network or model provider.", tests: [] };
async function check(name, run) {
  const before = fixture.snapshot();
  try { await run(); report.tests.push({ name, passed: true, before, after: fixture.snapshot() }); }
  catch (error) { report.tests.push({ name, passed: false, error: error.stack, before, after: fixture.snapshot() }); throw error; }
  finally { writeFileSync(join(driver.directory, "report.json"), JSON.stringify(report, null, 2)); }
  console.log(JSON.stringify({ name, passed: true }));
}
try {
  let proposal;
  await check("A1: real Host dispatch reaches plugin before domain proposal", async () => {
    proposal = await driver.dispatch("生成隔离测试行程提案", () => fixture.proposal());
    assert.equal(proposal.ok, true);
    assert.deepEqual(driver.trace.slice(0, 2), ["reply_dispatch", "resolver"]);
    assert.equal(fixture.snapshot().profilePlanning.trips, 0);
    assert.deepEqual(fixture.snapshot().profilePlanning.grants, []);
  });
  await check("A2: commit without a new confirmation is denied", async () => {
    const result = await driver.dispatch("现在先试着提交", () => fixture.commit(proposal));
    assert.equal(result.error.code, "approval_required");
    assert.equal(fixture.snapshot().profilePlanning.trips, 0);
  });
  await check("A3: real dispatch issues grant before commit and persists exactly one trip", async () => {
    const result = await driver.dispatch(fixture.confirmation(proposal), () => fixture.commit(proposal));
    assert.equal(result.ok, true);
    assert.equal(fixture.snapshot().profilePlanning.trips, 1);
    assert.deepEqual(fixture.snapshot().profilePlanning.grants, [{ domain: "planning", status: "consumed", n: 1 }]);
  });
  if (process.argv.includes("--boundaries")) {
    await check("B1: application replay is idempotent and does not create another grant or trip", async () => {
      const before = fixture.snapshot();
      const result = await driver.dispatch(fixture.confirmation(proposal), () => fixture.commit(proposal));
      assert.equal(result.idempotent, true); assert.deepEqual(fixture.snapshot(), before);
    });
    await check("B2: the actual tool factory rejects a non-owner and a group context", async () => {
      const before = fixture.snapshot();
      for (const context of [{ ...driver.toolContext, senderIsOwner: false },
        { ...driver.toolContext, deliveryContext: { channel: "qqbot", to: "qqbot:group:test" } }]) {
        const result = await fixture.tool("personal_planning_change_commit", { proposal_id: proposal.proposalId, payload_hash: proposal.payloadHash }, context);
        assert.equal(result.error.code, "forbidden_context");
      }
      assert.deepEqual(fixture.snapshot(), before);
    });
    for (const [name, override, content] of [
      ["B3: wrong account", { AccountId: "other" }],
      ["B4: wrong sender in same session", { SenderId: "stranger" }],
      ["B5: wrong peer in same session", { OriginatingTo: "qqbot:c2c:stranger" }],
      ["B6: wrong session", { SessionKey: "agent:main:qqbot:direct:other" }],
      ["B7: quoted confirmation", { ReplyToIsQuote: true }],
      ["B8: stale message", { Timestamp: Date.now() - 301000 }],
      ["B9: bare confirmation", {}, "确认"],
      ["B10: denied confirmation", {}, "不要确认"],
    ]) await check(name, async () => {
      const pending = fixture.proposal(); assert.equal(pending.ok, true);
      const before = fixture.snapshot();
      const result = await driver.dispatch(content ? `${content} ${pending.proposalId} ${content === "确认" ? "" : pending.payloadHash}` : fixture.confirmation(pending), () => fixture.commit(pending), override);
      assert.equal(result.error.code, "approval_required"); assert.deepEqual(fixture.snapshot(), before);
    });
    await check("B11: expired proposal index cannot issue a grant", async () => {
      const pending = fixture.proposal(); fixture.expire(pending);
      const before = fixture.snapshot();
      const result = await driver.dispatch(fixture.confirmation(pending), () => fixture.commit(pending));
      assert.equal(result.error.code, "approval_required"); assert.deepEqual(fixture.snapshot(), before);
    });
    await check("B12: expired grant cannot commit", async () => {
      const pending = fixture.proposal();
      await driver.dispatch(fixture.confirmation(pending), () => undefined);
      fixture.expireGrant(pending);
      assert.equal(fixture.commit(pending).error.code, "grant_expired");
      assert.equal(fixture.snapshot().profilePlanning.trips, 1);
    });
    await check("B13: duplicate transport message is deduplicated by the real Host", async () => {
      const pending = fixture.proposal(), MessageSid = "duplicate-transport-message";
      await driver.dispatch(fixture.confirmation(pending), () => undefined, { MessageSid });
      const before = fixture.snapshot();
      const result = await driver.dispatch(fixture.confirmation(pending), () => { throw Error("duplicate must not reach cognition"); }, { MessageSid });
      assert.equal(result.skipped, true); assert.deepEqual(fixture.snapshot(), before);
    });
    await check("B14: actual planning tools propose and commit through Host confirmation", async () => {
      const pending = await driver.dispatch("生成测试提案", () => fixture.tool("personal_planning_change_propose", {
        schema_version: 1, request: { kind: "trip.create", destination: { text: "南京" }, weather_mode: "none" },
      }));
      assert.equal(pending.ok, true);
      const result = await driver.dispatch(fixture.confirmation(pending), () => fixture.tool("personal_planning_change_commit", {
        proposal_id: pending.proposalId, payload_hash: pending.payloadHash,
      }));
      assert.equal(result.ok, true); assert.equal(fixture.snapshot().profilePlanning.trips, 2);
    });
    await check("B15: Profile confirmation does not authorize pending Planning or Reminder", async () => {
      const { geoLookupFixture } = await import("../../plugins/personal-weather/dist/test-fixtures.js");
      const client = { lookupPlace: async () => ({ ...geoLookupFixture, location: [{ ...geoLookupFixture.location[0],
        name: "扬中", id: "101190704", lat: "32.2373", lon: "119.8281", adm1: "江苏省", adm2: "镇江市", type: "city" }] }) };
      const profile = await fixture.profile.proposeProfileChange(fixture.weather, client, { schema_version: 1,
        request: { kind: "current_location.set", location: { text: "扬中市" } } }, undefined, fixture.scope);
      assert.equal(profile.ok, true);
      const planning = fixture.proposal();
      const reminder = fixture.reminders.proposeReminderCreate(fixture.reminder, { schema_version: 1,
        request: { kind: "reminder.create", content: "isolated reminder", schedule: {
          local_date_time: fixture.reminders.formatShanghaiDateTime(fixture.now() + 3600).replace(" ", "T"), timezone: "Asia/Shanghai" } } }, fixture.reminderContext);
      assert.equal(reminder.ok, true, JSON.stringify(reminder));
      const revision = fixture.snapshot().profilePlanning.profileRevision;
      const result = await driver.dispatch(fixture.confirmation(profile), () => fixture.profile.commitProfileChange(fixture.weather,
        { proposal_id: profile.proposalId, payload_hash: profile.payloadHash }, fixture.scope));
      assert.equal(result.ok, true); assert.equal(fixture.snapshot().profilePlanning.profileRevision, revision + 1);
      assert.equal(fixture.commit(planning).error.code, "approval_required");
      const denied = await fixture.reminders.commitReminderProposal(fixture.reminder, { proposal_id: reminder.proposalId,
        payload_hash: reminder.payloadHash }, fixture.reminderContext, fixture.scheduler);
      assert.equal(denied.error.code, "approval_required"); assert.equal(fixture.schedulerCalls.length, 0);
      const accepted = await driver.dispatch(fixture.confirmation(reminder), () => fixture.reminders.commitReminderProposal(fixture.reminder,
        { proposal_id: reminder.proposalId, payload_hash: reminder.payloadHash }, fixture.reminderContext, fixture.scheduler));
      assert.equal(accepted.ok, true); assert.equal(fixture.schedulerCalls.length, 1);
      assert.equal(fixture.snapshot().reminder.reminders, 1);
    });
    await check("B16: wrong payload hash cannot issue a grant or change a trip", async () => {
      const pending = fixture.proposal(), before = fixture.snapshot();
      const result = await driver.dispatch(fixture.core.buildConfirmationInstruction(pending.proposalId, "0".repeat(64)), () => fixture.commit(pending));
      assert.equal(result.error.code, "approval_required"); assert.deepEqual(fixture.snapshot(), before);
    });
    await check("B17: committed proposal remains idempotent in a fresh process", async () => {
      writeFileSync(join(driver.directory, "restart-checkpoint.json"), JSON.stringify({ scope: fixture.scope,
        input: { proposal_id: proposal.proposalId, payload_hash: proposal.payloadHash } }));
      const before = fixture.snapshot();
      const result = spawnSync(process.execPath, [fileURLToPath(new URL("./verify-restart.mjs", import.meta.url)), driver.directory],
        { encoding: "utf8", timeout: 30000 });
      assert.equal(result.status, 0, result.stderr); assert.deepEqual(fixture.snapshot(), before);
    });
  }
} finally {
  report.finishedAt = new Date().toISOString();
  writeFileSync(join(driver.directory, "report.json"), JSON.stringify(report, null, 2));
  console.log("REPORT " + join(driver.directory, "report.json"));
  fixture.close(); driver.close();
}
