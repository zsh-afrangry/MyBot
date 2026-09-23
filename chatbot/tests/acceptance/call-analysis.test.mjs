import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { analyzeCalls, assertProposalCalls } from "./call-analysis.mjs";

const call = (id, args) => ({ role: "assistant", content: [{ type: "toolCall", id, name: "propose", arguments: args }] });
const response = (id, value, isError = false) => ({ role: "toolResult", toolCallId: id, toolName: "propose", isError,
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] });
const rejected = id => response(id, 'Validation failed for tool "propose": invalid time', true);

test("valid correction is distinct from retrying equivalent reordered arguments", () => {
  const corrected = analyzeCalls([call("1", { time: "bad" }), rejected("1"), call("2", { time: "good" }), response("2", { ok: true })]);
  assert.equal(corrected.correctedSchemaSuccesses, 1);
  assertProposalCalls(corrected, "propose", assert);
  const repeated = analyzeCalls([call("1", { a: 1, b: 2 }), rejected("1"), call("2", { b: 2, a: 1 }), response("2", { ok: true })]);
  assert.equal(repeated.sameArgumentsAfterFailure, 1);
  assert.throws(() => assertProposalCalls(repeated, "propose", assert));
});
test("IDs match out-of-order results, ambiguous legacy results fail closed", () => {
  const matched = analyzeCalls([call("1", { a: 1 }), call("2", { a: 2 }), response("2", { ok: true }), rejected("1")]);
  assert.deepEqual(matched.attempts.map(item => item.outcome), ["schema-rejected", "success"]);
  const legacy = response(undefined, { ok: true });
  assert.equal(analyzeCalls([call("1", {}), call("2", {}), legacy]).unknownOrUnmatched, 3);
});
test("multiple successful responses never imply idempotent or duplicate writes", () => {
  for (const args of [{ a: 1 }, { a: 2 }]) {
    const report = analyzeCalls([call("1", { a: 1 }), response("1", { ok: true }), call("2", args), response("2", { ok: true, idempotent: true })]);
    assert.equal(report.successes, 2);
    assert.throws(() => assertProposalCalls(report, "propose", assert));
  }
});
test("business rejection, missing response and contradictory error flags cannot pass", () => {
  for (const messages of [[call("1", {})], [call("1", {}), response("1", { ok: false })], [call("1", {}), response("1", { ok: true }, true)]]) {
    assert.throws(() => assertProposalCalls(analyzeCalls(messages), "propose", assert));
  }
});
test("historical failures remain distinct without rewriting their verdicts", () => {
  const load = name => JSON.parse(readFileSync(new URL(`../../../docs/verification/${name}`, import.meta.url), "utf8"));
  const reminder = load("confirmation-instruction-reminder-initial.json");
  const planning = load("planning-capability-initial.json");
  assert.equal(reminder.status, "acceptance-failed");
  assert.equal(planning.status, "acceptance-failed");
  const r = analyzeCalls(reminder.messages), p = analyzeCalls(planning.messages);
  assert.equal(r.schemaRejections, 2); assert.equal(r.sameArgumentsAfterFailure, 1);
  assert.throws(() => assertProposalCalls(r, "personal_reminder_propose", assert));
  assert.equal(p.schemaRejections, 1); assert.equal(p.correctedSchemaSuccesses, 1);
  assertProposalCalls(p, "personal_planning_change_propose", assert);
  assert.equal(planning.after.profilePlanning.trips, 0);
  assert.equal(planning.after.profilePlanning.change_proposals, planning.before.profilePlanning.change_proposals + 1);
});
