// MIME construction tests.
//
// These cover the encoding rules that are easy to get subtly wrong and expensive to discover in
// production: RFC 2047 headers, RFC 2231 attachment filenames, base64 line width, dot-stuffing, and
// header injection. One test is a regression guard for a real prototype bug: the envelope sender was
// lost, producing `MAIL FROM:<>`.
import test from "node:test";
import assert from "node:assert/strict";
import {
  assertSafeHeaderValue,
  buildMessage,
  contentDisposition,
  dotStuff,
  encodeHeaderValue,
  formatAddress,
} from "../mime.js";

const FROM = { address: "365999865@qq.com" };
const TO = "1794511189@qq.com";
const MESSAGE_ID = "11111111-2222-3333-4444-555555555555@kurumi-mail";

function build(overrides = {}) {
  return buildMessage({ from: FROM, to: [TO], subject: "hello", text: "body", messageId: MESSAGE_ID, ...overrides });
}

test("plain ASCII headers stay readable", () => {
  assert.equal(encodeHeaderValue("Routine check"), "Routine check");
  const message = build({ subject: "Routine check" });
  assert.match(message.raw, /^Subject: Routine check$/mu);
  assert.doesNotMatch(message.raw, /=\?UTF-8\?B\?/u);
});

test("non-ASCII subjects use RFC 2047 and never exceed 75 characters per encoded word", () => {
  const encoded = encodeHeaderValue("项目进度与下周安排（含附件）以及更多需要折行的中文说明文字用于验证分段行为正确");
  for (const word of encoded.split(/\s+/u)) {
    assert.ok(word.length <= 75, `encoded word too long: ${word.length}`);
  }
  assert.match(encoded, /^=\?UTF-8\?B\?/u);
  // Decoding all words yields the original text.
  const decoded = encoded
    .split(/\s+/u)
    .map((word) => Buffer.from(word.replace(/^=\?UTF-8\?B\?/u, "").replace(/\?=$/u, ""), "base64").toString("utf8"))
    .join("");
  assert.equal(decoded, "项目进度与下周安排（含附件）以及更多需要折行的中文说明文字用于验证分段行为正确");
});

test("header values containing CR, LF or NUL are rejected outright", () => {
  for (const value of ["ok\r\nBcc: evil@example.test", "line\nbreak", "nul\0byte"]) {
    assert.throws(() => assertSafeHeaderValue(value, "subject"), /must not contain/u);
  }
  assert.throws(() => build({ subject: "hi\r\nBcc: evil@example.test" }), /subject/u);
  assert.throws(() => build({ to: ["a@b.test\r\nBcc: evil@example.test"] }), /recipient/u);
  assert.throws(() => build({ attachments: [{ filename: "x\r\n.txt", content: "x" }] }), /filename/u);
});

test("non-ASCII attachment filenames carry one unambiguous RFC 2231 extended parameter", () => {
  const disposition = contentDisposition("季度报告.pdf");
  assert.match(disposition, /^attachment; filename\*=UTF-8''/u);
  assert.match(disposition, /filename\*=UTF-8''%E5%AD%A3%E5%BA%A6%E6%8A%A5%E5%91%8A\.pdf/u);
  const message = build({ attachments: [{ filename: "季度报告.pdf", content: "hi", contentType: "application/pdf" }] });
  assert.match(message.raw, /filename\*=UTF-8''%E5%AD%A3%E5%BA%A6%E6%8A%A5%E5%91%8A\.pdf/u);
});

test("the envelope sender is never empty (regression: MAIL FROM:<> bug)", () => {
  const message = build();
  assert.equal(message.envelopeFrom, "365999865@qq.com");
  assert.ok(message.envelopeFrom.length > 0);
  assert.deepEqual(message.envelopeTo, [TO]);
});

test("envelope recipients are bare addresses even when display names are used", () => {
  const message = build({ to: [{ address: TO, name: "朋友" }] });
  assert.deepEqual(message.envelopeTo, [TO]);
  assert.doesNotMatch(message.envelopeTo[0], /</u);
  assert.match(message.raw, /^To: "=\?UTF-8\?B\?/mu);
});

test("base64 bodies are wrapped at 76 characters", () => {
  const message = build({ text: "中文正文".repeat(200) });
  const body = message.raw.split("\r\n\r\n")[1] ?? "";
  const lines = body.split("\r\n").filter((line) => /^[A-Za-z0-9+/=]+$/u.test(line) && line.length > 0);
  assert.ok(lines.length > 1, "expected a wrapped body");
  for (const line of lines) assert.ok(line.length <= 76, `line too long: ${line.length}`);
});

test("dot-stuffing protects a body line that is a single dot", () => {
  assert.equal(dotStuff("a\r\n.\r\nb"), "a\r\n..\r\nb");
  assert.equal(dotStuff(".hidden"), "..hidden");
  assert.equal(dotStuff("normal"), "normal");
});

test("attachments produce a well-formed multipart/mixed with both parts", () => {
  const message = build({ attachments: [{ filename: "note.txt", content: "attached text" }] });
  assert.match(message.raw, /^Content-Type: multipart\/mixed; boundary="kurumi-/mu);
  const boundary = /boundary="([^"]+)"/u.exec(message.raw)?.[1];
  assert.ok(boundary, "boundary must be declared");
  const opens = message.raw.split(`--${boundary}`).length - 1;
  // One opening delimiter per part plus the closing delimiter.
  assert.equal(opens, 3);
  assert.match(message.raw, new RegExp(`--${boundary}--`, "u"));
  assert.match(message.raw, /Content-Type: text\/plain; charset="UTF-8"/u);
  assert.match(message.raw, /Content-Disposition: attachment; filename="note.txt"/u);
});

test("addresses are validated and HTML bodies are refused for now", () => {
  assert.throws(() => formatAddress({ address: "not-an-address" }), /invalid email address/u);
  assert.throws(() => build({ to: ["a@b"] }), /invalid email address/u);
  assert.throws(() => build({ html: "<b>hi</b>" }), /html bodies are not supported/u);
  assert.equal(formatAddress({ address: TO }), TO);
  assert.equal(formatAddress({ address: TO, name: "Friend" }), `"Friend" <${TO}>`);
});

test("the built message separates envelope fields from visible headers", () => {
  const message = build();
  const [headers] = message.raw.split("\r\n\r\n");
  assert.match(headers, /^From: 365999865@qq\.com$/mu);
  assert.match(headers, new RegExp(`^To: ${TO}$`, "mu"));
  assert.match(headers, /^MIME-Version: 1\.0$/mu);
  assert.match(headers, new RegExp(`^Message-ID: <${MESSAGE_ID}>$`, "mu"));
  assert.match(headers, /^Date: /mu);
  // No envelope-only artefact leaked into the header block.
  assert.doesNotMatch(headers, /MAIL FROM|RCPT TO/u);
});
