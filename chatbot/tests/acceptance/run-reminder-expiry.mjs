import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHostDriver } from "./host-driver.mjs";
import { createDomainFixture } from "./domain-fixture.mjs";
import { createModelDriver } from "./model-driver.mjs";
import { formatDateTime } from "../../plugins/personal-weather/dist/time-display.js";

// A real-model display check; no commit tool, production DB, Cron, or QQ delivery.
const driver = await createHostDriver(), fixture = await createDomainFixture(driver);
const report = { stage: "reminder-expiry-display", directory: driver.directory, passed: false,
  boundary: "Configured primary model in bounded test loop; synthetic QQ input, real reminder proposal tool and isolated SQLite. Not production Agent/QQ acceptance.",
  before: fixture.snapshot() };
try {
  const model = await createModelDriver(fixture, { toolNames: ["personal_reminder_propose"] });
  report.model = model.model;
  const schedule = formatDateTime(Math.floor(Date.now() / 1000) + 172800, "Asia/Shanghai").slice(0, 16);
  const content = `请为我生成一条提醒提案：${schedule}（Asia/Shanghai）提醒我“到期显示验收”。只生成一次提案，不提交。请分别说明提醒触发时间与提案确认截止时间；截止时间原样列出工具返回的 UTC、本地时间和时区，不自己从秒数换算。`;
  const turn = await driver.dispatch(content, () => model.turn(content));
  // Keep reviewable tool/reply evidence without raw provider responses or thinking.
  report.turn = { content, calls: turn.calls, reply: turn.reply };
  assert.equal(turn.calls.length, 1);
  const proposal = turn.calls[0].result;
  assert.equal(turn.calls[0].name, "personal_reminder_propose");
  assert.equal(proposal.ok, true);
  for (const text of Object.values(proposal.expiresAtDisplay)) assert.ok(turn.reply.includes(text));
  const row = fixture.reminder.getProposal(proposal.proposalId);
  report.databaseProposal = { expiresAtUtc: row.expiresAtUtc, status: row.status, payloadHash: row.payloadHash };
  assert.equal(Date.parse(proposal.expiresAtDisplay.local) / 1000, row.expiresAtUtc);
  assert.equal(Date.parse(proposal.expiresAtDisplay.utc) / 1000, row.expiresAtUtc);
  assert.equal(row.status, "pending");
  assert.equal(row.payloadHash, proposal.payloadHash);
  const after = fixture.snapshot();
  assert.deepEqual(after.profilePlanning, report.before.profilePlanning);
  assert.equal(after.reminder.reminders, 0);
  assert.equal(after.reminder.reminder_audit_log, 0);
  assert.deepEqual(after.reminder.grants, []);
  assert.deepEqual(after.reminder.proposals, [{ domain: "personal_reminder", status: "pending", n: 1 }]);
  report.passed = true;
} catch (error) {
  report.error = error.message;
  process.exitCode = 1;
} finally {
  report.after = fixture.snapshot();
  report.finishedAt = new Date().toISOString();
  writeFileSync(join(driver.directory, "reminder-expiry-report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, error: report.error, report: join(driver.directory, "reminder-expiry-report.json") }));
  fixture.close(); driver.close();
}
