import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHostDriver } from "./host-driver.mjs";
import { createDomainFixture } from "./domain-fixture.mjs";
import { createModelDriver } from "./model-driver.mjs";

const driver = await createHostDriver(), fixture = await createDomainFixture(driver);
const report = { stage: "configured-model", directory: driver.directory, tests: [],
  boundary: "Real configured primary model via provider SDK and bounded test tool loop; real Host dispatcher, confirmation plugin, tools and test SQLite. Synthetic QQ identity; not the full production agent loop or QQ transport." };
let model;
async function check(name, content, verify) {
  const before = fixture.snapshot();
  try {
    const turn = await driver.dispatch(content, () => model.turn(content));
    await verify(turn);
    report.tests.push({ name, passed: true, before, after: fixture.snapshot(), turn });
  } catch (error) {
    report.tests.push({ name, passed: false, error: error.message, before, after: fixture.snapshot(), turns: model?.turns });
    throw error;
  } finally { writeFileSync(join(driver.directory, "model-report.json"), JSON.stringify(report, null, 2)); }
  console.log(JSON.stringify({ name, passed: true }));
}
try {
  model = await createModelDriver(fixture); report.model = model.model;
  let proposal;
  await check("C1: natural-language proposal creates only a pending draft",
    "请为我生成一条待确认的行程提案：标题“自动验收测试行程”，目的地江苏省南京市，交通方式高铁。暂不填写出发和到达时间，不启用天气联动。现在只生成待确认预览，给出完整确认文本，等我下一条消息确认后再提交。", turn => {
      const calls = turn.calls.filter(call => call.name === "personal_planning_change_propose");
      assert.equal(calls.length, 1); proposal = calls[0].result; assert.equal(proposal.ok, true);
      assert.equal(turn.calls.some(call => call.name.endsWith("_commit")), false);
      assert.equal(fixture.snapshot().profilePlanning.trips, 0);
      assert.deepEqual(fixture.snapshot().profilePlanning.grants, []);
      assert.ok(turn.reply.includes(proposal.proposalId) && turn.reply.includes(proposal.payloadHash));
    });
  await check("C2: bare confirmation cannot persist a trip", "确认", () => {
    assert.equal(fixture.snapshot().profilePlanning.trips, 0);
    assert.deepEqual(fixture.snapshot().profilePlanning.grants, []);
  });
  await check("C3: canonical confirmation triggers actual model commit and consumed grant", fixture.confirmation(proposal), turn => {
    assert.ok(turn.calls.some(call => call.name === "personal_planning_change_commit" && call.result.ok));
    assert.equal(fixture.snapshot().profilePlanning.trips, 1);
    assert.deepEqual(fixture.snapshot().profilePlanning.grants, [{ domain: "planning", status: "consumed", n: 1 }]);
  });
  await check("C4: repeated confirmation does not create a second trip", fixture.confirmation(proposal), () => {
    assert.equal(fixture.snapshot().profilePlanning.trips, 1);
    assert.deepEqual(fixture.snapshot().profilePlanning.grants, [{ domain: "planning", status: "consumed", n: 1 }]);
  });
} finally {
  report.finishedAt = new Date().toISOString();
  writeFileSync(join(driver.directory, "model-report.json"), JSON.stringify(report, null, 2));
  console.log("REPORT " + join(driver.directory, "model-report.json"));
  fixture.close(); driver.close();
}
