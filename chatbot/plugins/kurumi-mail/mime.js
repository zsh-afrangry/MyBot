// MIME message construction for kurumi-mail.
//
// Pure functions only: no I/O, no credentials, no clock except what the caller passes in. That keeps
// the encoding rules (RFC 2047 headers, RFC 2231 filenames, multipart framing) unit-testable without
// a network or a mail server.
//
// Deliberate limits:
//   * plain text is the default body; HTML is opt-in per draft, because HTML is the easiest way to
//     smuggle markup into a message and the owner rarely needs it;
//   * header values are rejected outright if they contain CR/LF/NUL, so a crafted subject or
//     recipient cannot inject extra headers;
//   * the envelope sender is returned separately from the From: header, so the SMTP MAIL FROM can
//     never be confused with the visible header (an earlier prototype sent MAIL FROM:<> by mistake).

const CRLF = "\r\n";
const ENCODED_WORD_LIMIT = 75; // RFC 2047: an encoded-word must not exceed 75 characters.
const BASE64_LINE = 76;

/** Throw when a value could inject a header or break the line protocol. */
export function assertSafeHeaderValue(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  if (/[\r\n\0]/.test(value)) throw new Error(`${label} must not contain CR, LF or NUL`);
  return value;
}

/** True when the text is plain printable ASCII and needs no encoding. */
function isPlainAscii(text) {
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7E]*$/.test(text);
}

/** RFC 2047 encoded-word, split so no chunk exceeds 75 characters. */
export function encodeHeaderValue(value, label = "header") {
  assertSafeHeaderValue(value, label);
  if (isPlainAscii(value)) return value;
  const bytes = Buffer.from(value, "utf8");
  // An encoded word is "=?UTF-8?B?" (10) + base64 + "?=" (2), so base64 may use 63 characters.
  // base64 length is always a multiple of 4, hence 60 characters = 45 source bytes
  // (10 + 60 + 2 = 72, safely under the 75-character limit).
  const maxBase64Chars = Math.floor((ENCODED_WORD_LIMIT - 12) / 4) * 4;
  const maxBytes = (maxBase64Chars / 4) * 3;
  const words = [];
  for (let offset = 0; offset < bytes.length;) {
    // Never split a multi-byte character: back off to a UTF-8 boundary.
    let end = Math.min(offset + maxBytes, bytes.length);
    while (end > offset && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1;
    words.push(`=?UTF-8?B?${bytes.subarray(offset, end).toString("base64")}?=`);
    offset = end;
  }
  // Only foldHeader inserts wire line breaks. Pre-folding here makes its next fold add an empty
  // line, ending the message headers before Content-Type and turning PDF base64 into visible text.
  return words.join(" ");
}

/**
 * One address rule for the whole plugin: local part, "@", and a dotted domain. Deliberately stricter
 * than RFC 5322 (no quoted local parts or literal IPs) because both the draft validator and the MIME
 * builder must agree, and a single strict rule is easier to reason about than two.
 */
export function isValidAddress(value) {
  return /^[^\s@<>,;]+@[^\s@<>,;.]+(\.[^\s@<>,;.]+)+$/u.test(String(value ?? ""));
}

/** `Name <addr@host>` with a safely encoded display name. */
export function formatAddress(input) {
  const address = assertSafeHeaderValue(String(input?.address ?? ""), "address");
  if (!isValidAddress(address)) throw new Error(`invalid email address: ${address}`);
  const name = input?.name === undefined || input.name === null || input.name === "" ? undefined : String(input.name);
  if (name === undefined) return address;
  const encoded = encodeHeaderValue(name, "display name").replace(/"/g, "");
  return `"${encoded}" <${address}>`;
}

/** RFC 2231 filename parameter. Do not duplicate filename/filename*: some clients keep only first. */
export function contentDisposition(filename) {
  assertSafeHeaderValue(filename, "attachment filename");
  const ascii = filename.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
  return isPlainAscii(filename) ? `attachment; filename="${ascii}"` : `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** Wrap base64 into 76-character lines, as required inside a MIME body. */
export function wrapBase64(buffer) {
  const text = Buffer.from(buffer).toString("base64");
  const lines = [];
  for (let i = 0; i < text.length; i += BASE64_LINE) lines.push(text.slice(i, i + BASE64_LINE));
  return lines.join(CRLF);
}

/** Fold a header value onto continuation lines without splitting words. */
function foldHeader(name, value) {
  const prefix = `${name}: `;
  const pieces = [];
  let line = prefix;
  for (const word of String(value).split(" ")) {
    if (line.length > prefix.length && line.length + 1 + word.length > 78) {
      pieces.push(line);
      line = ` ${word}`;
    } else {
      line = line === prefix ? prefix + word : `${line} ${word}`;
    }
  }
  pieces.push(line);
  return pieces.join(CRLF);
}

function escapePlainText(text) {
  // Keep the body verbatim; only normalise line endings so the SMTP DATA stream is well-formed.
  return String(text).replace(/\r\n|\r|\n/g, CRLF);
}

/**
 * Build one message.
 *
 * @returns {{ raw: string, envelopeFrom: string, envelopeTo: string[], subject: string }}
 *   `envelopeFrom`/`envelopeTo` are for MAIL FROM / RCPT TO only; they never appear in the headers.
 */
export function buildMessage(input) {
  const from = input?.from;
  if (!from || typeof from.address !== "string") throw new Error("from.address is required");
  const to = Array.isArray(input.to) ? input.to : [input.to];
  if (to.length === 0) throw new Error("at least one recipient is required");
  const recipients = to.map((entry) => (typeof entry === "string" ? { address: entry } : entry));
  // Validate safety before formatting so a CRLF-bearing recipient is reported as a recipient problem.
  for (const entry of recipients) assertSafeHeaderValue(String(entry?.address ?? ""), "recipient");
  const recipientsFormatted = recipients.map(formatAddress);
  const envelopeTo = recipients.map((entry) => String(entry.address));

  const subject = assertSafeHeaderValue(String(input.subject ?? ""), "subject");
  const text = escapePlainText(input.text ?? "");
  if (input.html !== undefined && input.html !== null) {
    throw new Error("html bodies are not supported yet; send plain text");
  }
  const attachments = Array.isArray(input.attachments) ? input.attachments : [];
  for (const attachment of attachments) {
    assertSafeHeaderValue(String(attachment?.filename ?? ""), "attachment filename");
    if (attachment?.content === undefined) throw new Error("attachment.content is required");
  }

  const date = input.date instanceof Date ? input.date : new Date();
  const messageId = assertSafeHeaderValue(String(input.messageId ?? ""), "messageId");

  const headers = [
    foldHeader("From", formatAddress(from)),
    foldHeader("To", recipientsFormatted.join(", ")),
    foldHeader("Subject", encodeHeaderValue(subject, "subject")),
    `Date: ${date.toUTCString()}`,
    `Message-ID: <${messageId}>`,
    "MIME-Version: 1.0",
  ];
  if (input.replyTo) headers.push(foldHeader("Reply-To", formatAddress(input.replyTo)));
  if (input.inReplyTo) headers.push(foldHeader("In-Reply-To", assertSafeHeaderValue(String(input.inReplyTo), "inReplyTo")));

  let body;
  if (attachments.length === 0) {
    headers.push('Content-Type: text/plain; charset="UTF-8"');
    headers.push("Content-Transfer-Encoding: base64");
    body = wrapBase64(Buffer.from(text, "utf8"));
  } else {
    const boundary = `kurumi-${messageId.replace(/[^A-Za-z0-9]/g, "").slice(0, 24) || "boundary"}`;
    headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
    const chunks = [
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
      "",
      wrapBase64(Buffer.from(text, "utf8")),
    ];
    for (const attachment of attachments) {
      const filename = String(attachment.filename);
      const contentType = assertSafeHeaderValue(String(attachment.contentType ?? "application/octet-stream"), "contentType");
      chunks.push(
        `--${boundary}`,
        `Content-Type: ${contentType}; name="${filename.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_")}"`,
        `Content-Disposition: ${contentDisposition(filename)}`,
        "Content-Transfer-Encoding: base64",
        "",
        wrapBase64(attachment.content instanceof Uint8Array ? attachment.content : Buffer.from(String(attachment.content), "utf8")),
      );
    }
    chunks.push(`--${boundary}--`, "");
    body = chunks.join(CRLF);
  }

  const raw = `${headers.join(CRLF)}${CRLF}${CRLF}${body}${CRLF}`;
  return { raw, envelopeFrom: assertSafeHeaderValue(String(from.address), "envelope from"), envelopeTo, subject };
}

/** Dot-stuffing for the DATA phase: a lone "." would end the message. */
export function dotStuff(raw) {
  return String(raw)
    .split(CRLF)
    .map((line) => (line.startsWith(".") ? `.${line}` : line))
    .join(CRLF);
}
