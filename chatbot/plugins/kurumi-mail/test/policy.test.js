// Input-policy tests.
//
// The first two cases are regressions for a real failed round trip (2026-10-16): the model passed a
// single recipient as a string and named the body "body". Both were hard schema rejections, so the
// call never reached the plugin; the model retried, then emitted a malformed tool call and the whole
// run failed. These cases pin the shapes that must keep working.
import test from "node:test";
import assert from "node:assert/strict";
import {
  MailPolicyError,
  assertRecipient,
  assertRecipientsAllowed,
  normalizeAllowlist,
  normalizeDraftArgs,
  normalizeOutboxArgs,
  normalizeRecipients,
  normalizeSendArgs,
  recipientsNotAllowed,
} from "../policy.js";

test("a single recipient as a plain string is accepted (regression)", () => {
  const input = normalizeDraftArgs({ to: "365999865@qq.com", subject: "测试", text: "正文" });
  assert.equal(input.problem, undefined);
  assert.deepEqual(input.to, ["365999865@qq.com"]);
});

test("the body may be named body or text (regression)", () => {
  const viaBody = normalizeDraftArgs({ to: ["a@x.test"], subject: "s", body: "用 body 传的正文" });
  assert.equal(viaBody.problem, undefined);
  assert.equal(viaBody.text, "用 body 传的正文");
  const viaText = normalizeDraftArgs({ to: ["a@x.test"], subject: "s", text: "用 text 传的正文" });
  assert.equal(viaText.text, "用 text 传的正文");
  // When both are present, the canonical key wins rather than silently picking one at random.
  const both = normalizeDraftArgs({ to: ["a@x.test"], subject: "s", text: "text", body: "body" });
  assert.equal(both.text, "text");
});

test("recipients accept arrays, strings and common separators", () => {
  assert.deepEqual(normalizeRecipients("a@x.test"), ["a@x.test"]);
  assert.deepEqual(normalizeRecipients(["a@x.test", "b@x.test"]), ["a@x.test", "b@x.test"]);
  assert.deepEqual(normalizeRecipients("a@x.test, b@x.test;c@x.test"), ["a@x.test", "b@x.test", "c@x.test"]);
  assert.deepEqual(normalizeRecipients("a@x.test，b@x.test；c@x.test"), ["a@x.test", "b@x.test", "c@x.test"]);
  assert.deepEqual(normalizeRecipients("  a@x.test  "), ["a@x.test"]);
  assert.deepEqual(normalizeRecipients(undefined), []);
  assert.deepEqual(normalizeRecipients(""), []);
  // cc follows the same rules as to.
  const input = normalizeDraftArgs({ to: "a@x.test", cc: "b@x.test, c@x.test", subject: "s", text: "t" });
  assert.deepEqual(input.cc, ["b@x.test", "c@x.test"]);
});

test("missing draft fields come back as fixable problems, not schema rejections", () => {
  for (const [args, expected] of [
    [{ subject: "s", text: "t" }, /recipient is required/u],
    [{ to: "a@x.test", text: "t" }, /'subject' is required/u],
    [{ to: "a@x.test", subject: "s" }, /plain-text body is required/u],
    [{ to: "a@x.test", subject: "  ", text: "t" }, /'subject' is required/u],
    [{ to: "a@x.test", subject: "s", text: "   " }, /plain-text body is required/u],
  ]) {
    const input = normalizeDraftArgs(args);
    assert.ok(input.problem, `expected a problem for ${JSON.stringify(args)}`);
    assert.match(input.problem, expected);
  }
  // An empty call reports the first thing to fix, and every message names the field to supply.
  assert.match(normalizeDraftArgs({}).problem, /recipient is required/u);
  assert.match(normalizeDraftArgs({}).problem, /'to'/u);
});

test("numbers, nulls and odd input never throw out of the normaliser", () => {
  assert.doesNotThrow(() => normalizeDraftArgs(undefined));
  assert.doesNotThrow(() => normalizeDraftArgs(null));
  assert.doesNotThrow(() => normalizeDraftArgs({ to: 42, subject: 7, text: 9 }));
  const coerced = normalizeDraftArgs({ to: 42, subject: 7, text: 9 });
  assert.deepEqual(coerced.to, ["42"]);
  assert.equal(coerced.subject, "7");
  assert.equal(coerced.text, "9");
});

test("email_outbox defaults to listing (regression)", () => {
  assert.equal(normalizeOutboxArgs({}).action, "list");
  assert.equal(normalizeOutboxArgs(undefined).action, "list");
  assert.equal(normalizeOutboxArgs({}).problem, undefined);
});

test("email_outbox rejects an unknown action and a cancel without a draft id", () => {
  assert.match(normalizeOutboxArgs({ action: "flush" }).problem, /must be one of list, audit, cancel/u);
  assert.match(normalizeOutboxArgs({ action: "cancel" }).problem, /draftId.*required/u);
  assert.equal(normalizeOutboxArgs({ action: "cancel", draftId: "abc" }).problem, undefined);
  assert.equal(normalizeOutboxArgs({ action: "audit", limit: 999 }).limit, 50);
  assert.equal(normalizeOutboxArgs({ action: "list", limit: 0 }).limit, 1);
});

test("allowlist helpers normalise and compare as documented", () => {
  assert.deepEqual(normalizeAllowlist([" B@x.test ", "a@x.test", "a@x.test", "", null]), ["a@x.test", "b@x.test"]);
  assert.deepEqual(normalizeAllowlist(undefined), []);
  assert.deepEqual(recipientsNotAllowed(["A@X.test", "c@x.test"], ["a@x.test"]), ["c@x.test"]);
  assert.throws(() => assertRecipientsAllowed(["a@x.test"], []), MailPolicyError);
  assert.doesNotThrow(() => assertRecipientsAllowed(["A@X.test"], ["a@x.test"]));
});

test("one address rule is shared by the policy layer and the MIME builder", () => {
  assert.equal(assertRecipient(" a@x.test "), "a@x.test");
  for (const bad of ["not-an-address", "a@b", "@x.test", "a@", "a b@x.test", "a@x.test\nBcc: e@x.test"]) {
    assert.throws(() => assertRecipient(bad), /invalid recipient|must not contain/u, `should reject: ${JSON.stringify(bad)}`);
  }
});

test("email_send tolerates an echoed confirmation line but never trusts it", () => {
  // Models paste the confirmation back as an extra field; the call must not die on that key.
  const input = normalizeSendArgs({ draftId: "3efdd3dd-471d-43b6-bda1-93d1f5f2dd9e", approval: "确认 f860045e8c0a" });
  assert.equal(input.problem, undefined);
  assert.equal(input.draftId, "3efdd3dd-471d-43b6-bda1-93d1f5f2dd9e");
  // The echoed text is dropped: approval is the grant the host recorded, never an argument.
  assert.equal(Object.hasOwn(input, "approval"), false);
  assert.equal(Object.keys(input).sort().join(","), "draftId");
});

test("email_send explains a missing draft id instead of failing schema validation", () => {
  assert.match(normalizeSendArgs({}).problem, /'draftId' is required/u);
  assert.match(normalizeSendArgs({ approval: "确认 abc" }).problem, /'draftId' is required/u);
  assert.match(normalizeSendArgs({ draftId: "   " }).problem, /'draftId' is required/u);
  assert.equal(normalizeSendArgs(undefined).problem !== undefined, true);
  assert.equal(normalizeSendArgs({ draftId: " x " }).draftId, "x");
});
