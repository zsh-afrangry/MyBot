// Read-only RFC 5322 / MIME parser for kurumi-mail inbox.
//
// Handles:
//   * Header unfolding & RFC 2047 encoded words (=?UTF-8?B|Q?...?=, =?GB18030?...?=).
//   * Authentication-Results SPF/DKIM failure detection (downgrades trust).
//   * Recursive multipart traversal with bounded depth & parts, base64/quoted-printable decoding.
//   * RFC 2231 attachment filename decoding & safe sanitization.
//   * Prompt-injection fence markers for untrusted email bodies.
import { createHash } from "node:crypto";

const MAX_MIME_DEPTH = 8;
const MAX_MIME_PARTS = 64;
const MAX_BODY_CHARS = 32_000;

function decodeCharsetBuffer(buf, charset = "utf-8") {
  const norm = String(charset ?? "utf-8").trim().toLowerCase();
  const mapped = norm === "gb2312" || norm === "gbk" || norm === "x-gbk" ? "gb18030"
    : norm === "us-ascii" ? "ascii"
      : norm === "latin1" ? "iso-8859-1"
        : norm;
  try {
    return new TextDecoder(mapped, { fatal: false }).decode(buf);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(buf);
  }
}

function decodeQuotedPrintableBuffer(str, { underscoreAsSpace = false } = {}) {
  const text = String(str ?? "").replace(/=\r?\n/gu, "");
  const out = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "=" && i + 2 < text.length && /^[0-9a-f]{2}$/iu.test(text.slice(i + 1, i + 3))) {
      out.push(Number.parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else if (underscoreAsSpace && ch === "_") {
      out.push(0x20);
    } else {
      const bytes = Buffer.from(ch, "utf8");
      for (const b of bytes) out.push(b);
    }
  }
  return Buffer.from(out);
}

/** Decode RFC 2047 encoded words, collapsing whitespace only between adjacent encoded-words. */
export function decodeRfc2047(value) {
  const collapsed = String(value ?? "").replace(/\?=\s+=\?/gu, "?==?");
  return collapsed.replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=/giu, (_full, charset, enc, payload) => {
    const buf = enc.toUpperCase() === "B"
      ? Buffer.from(payload, "base64")
      : decodeQuotedPrintableBuffer(payload, { underscoreAsSpace: true });
    return decodeCharsetBuffer(buf, charset);
  });
}

export function splitHeadersAndBody(rawBuffer) {
  const buf = Buffer.isBuffer(rawBuffer) ? rawBuffer : Buffer.from(String(rawBuffer ?? ""), "utf8");
  let sepIdx = buf.indexOf("\r\n\r\n");
  let sepLen = 4;
  const lfSep = buf.indexOf("\n\n");
  if (lfSep !== -1 && (sepIdx === -1 || lfSep < sepIdx)) {
    sepIdx = lfSep;
    sepLen = 2;
  }
  if (sepIdx === -1) {
    return { headerBuffer: buf, bodyBuffer: Buffer.alloc(0) };
  }
  return {
    headerBuffer: buf.subarray(0, sepIdx),
    bodyBuffer: buf.subarray(sepIdx + sepLen),
  };
}

export function parseHeaders(headerBuffer) {
  const raw = decodeCharsetBuffer(headerBuffer, "utf-8");
  const unfolded = raw.replace(/\r?\n[ \t]+/gu, " ");
  const map = new Map();
  for (const line of unfolded.split(/\r?\n/u)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const val = line.slice(colon + 1).trim();
    const arr = map.get(name) ?? [];
    arr.push(val);
    map.set(name, arr);
  }
  return map;
}

function parseParams(headerValue) {
  const text = String(headerValue ?? "");
  const parts = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "\\" && inQuotes && i + 1 < text.length) {
      cur += ch + text[i + 1];
      i += 1;
      continue;
    }
    if (ch === '"') inQuotes = !inQuotes;
    if (ch === ";" && !inQuotes) {
      parts.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur) parts.push(cur);

  const main = (parts.shift() ?? "").trim().toLowerCase();
  const params = Object.create(null);
  const starPieces = Object.create(null);

  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const keyRaw = part.slice(0, eq).trim().toLowerCase();
    let val = part.slice(eq + 1).trim();
    if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) {
      val = val.slice(1, -1).replace(/\\(.)/gu, "$1");
    }
    const extCont = /^([a-z0-9_-]+)\*(\d+)(\*)?$/u.exec(keyRaw);
    if (extCont) {
      const [, base, idxStr, isStar] = extCont;
      starPieces[base] ??= [];
      starPieces[base].push({ idx: Number(idxStr), val, isStar: Boolean(isStar) });
    } else {
      params[keyRaw] = val;
    }
  }

  for (const [base, list] of Object.entries(starPieces)) {
    list.sort((a, b) => a.idx - b.idx);
    const combined = list.map(x => x.val).join("");
    params[`${base}*`] = combined;
  }

  for (const key of Object.keys(params)) {
    if (key.endsWith("*")) {
      const base = key.slice(0, -1);
      const raw = params[key];
      const rfc2231 = /^([^']*)'[^']*'(.*)$/u.exec(raw);
      if (rfc2231) {
        const [, charset, encoded] = rfc2231;
        const pct = encoded.replace(/%([0-9a-f]{2})/giu, (_m, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
        const bytes = Buffer.from(pct, "latin1");
        params[base] = decodeCharsetBuffer(bytes, charset || "utf-8");
      } else {
        params[base] = decodeRfc2047(raw);
      }
    } else {
      params[key] = decodeRfc2047(params[key]);
    }
  }
  return { main, params };
}

export function parseAddressList(rawHeader) {
  if (!rawHeader) return [];
  const entries = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < rawHeader.length; i += 1) {
    const ch = rawHeader[i];
    if (ch === "\\" && inQuotes && i + 1 < rawHeader.length) {
      cur += ch + rawHeader[i + 1];
      i += 1;
      continue;
    }
    if (ch === '"') inQuotes = !inQuotes;
    if (ch === "," && !inQuotes) {
      entries.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) entries.push(cur.trim());

  const out = [];
  for (const item of entries) {
    const decoded = decodeRfc2047(item).trim();
    const angle = /^(.*?)\s*<([^<>@\s]+@[^<>@\s]+)>$/u.exec(decoded);
    if (angle) {
      const name = angle[1].replace(/^"|"$/gu, "").trim();
      out.push({ name: name || null, address: angle[2].trim().toLowerCase() });
      continue;
    }
    const bare = /([a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+)/u.exec(decoded);
    if (bare) {
      out.push({ name: null, address: bare[1].trim().toLowerCase() });
    }
  }
  return out;
}

export function sanitizeAttachmentFilename(rawName) {
  const cleaned = String(rawName ?? "")
    .replaceAll("\\", "/")
    .split("/")
    .at(-1)
    .normalize("NFC")
    .replace(/[\p{Cc}\p{Cf}]/gu, "_")
    .replaceAll("..", "_")
    .toWellFormed()
    .trim();
  const safe = Array.from(cleaned || "attachment.bin").slice(0, 160).join("");
  const extMatch = /\.([a-z0-9]{1,16})$/iu.exec(safe);
  return {
    filename: safe,
    safeExtension: extMatch ? extMatch[1].toLowerCase() : "bin",
  };
}

export function inspectAuthenticationResults(headersMap) {
  const values = headersMap.get("authentication-results") ?? [];
  const warnings = [];
  for (const val of values) {
    if (/\bspf=fail\b/iu.test(val)) warnings.push("spf=fail");
    if (/\bdkim=fail\b/iu.test(val)) warnings.push("dkim=fail");
  }
  return {
    authFailed: warnings.length > 0,
    authWarnings: [...new Set(warnings)],
  };
}

export function parseEnvelopeFromHeaders(headerBuffer) {
  const headers = parseHeaders(headerBuffer);
  const fromList = parseAddressList(headers.get("from")?.[0]);
  const toList = parseAddressList(headers.get("to")?.join(", "));
  const ccList = parseAddressList(headers.get("cc")?.join(", "));
  const subject = decodeRfc2047(headers.get("subject")?.[0] ?? "").trim();
  const date = (headers.get("date")?.[0] ?? "").trim() || null;
  const messageId = (headers.get("message-id")?.[0] ?? "").trim() || null;
  const { authFailed, authWarnings } = inspectAuthenticationResults(headers);
  return {
    headers,
    from: fromList[0] ?? { name: null, address: null },
    to: toList,
    cc: ccList,
    subject,
    date,
    messageId,
    authFailed,
    authWarnings,
  };
}

function decodePartBody(bodyBuffer, encoding) {
  const enc = String(encoding ?? "7bit").trim().toLowerCase();
  if (enc === "base64") {
    const cleaned = bodyBuffer.toString("ascii").replace(/\s+/gu, "");
    return Buffer.from(cleaned, "base64");
  }
  if (enc === "quoted-printable") {
    return decodeQuotedPrintableBuffer(bodyBuffer.toString("latin1"), { underscoreAsSpace: false });
  }
  return bodyBuffer;
}

function stripHtmlToText(html) {
  return String(html ?? "")
    .replace(/<style\b[\s\S]*?<\/style>/giu, " ")
    .replace(/<script\b[\s\S]*?<\/script>/giu, " ")
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/giu, "\n")
    .replace(/<[^>]+>/gu, "")
    .replaceAll("&nbsp;", " ")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function splitMultipartBody(bodyBuffer, boundary) {
  const raw = bodyBuffer.toString("latin1");
  const delim = `--${boundary}`;
  const chunks = [];
  let searchFrom = 0;
  let firstIdx = raw.indexOf(delim, searchFrom);
  if (firstIdx === -1) return chunks;
  while (firstIdx !== -1) {
    const afterDelim = firstIdx + delim.length;
    if (raw.slice(afterDelim, afterDelim + 2) === "--") break;
    let bodyStart = afterDelim;
    if (raw.slice(bodyStart, bodyStart + 2) === "\r\n") bodyStart += 2;
    else if (raw[bodyStart] === "\n") bodyStart += 1;

    const nextIdx = raw.indexOf(`\n${delim}`, bodyStart);
    if (nextIdx === -1) break;
    let bodyEnd = nextIdx;
    if (bodyEnd > bodyStart && raw[bodyEnd - 1] === "\r") bodyEnd -= 1;
    chunks.push(bodyBuffer.subarray(bodyStart, bodyEnd));
    searchFrom = nextIdx + 1;
    firstIdx = nextIdx + 1;
  }
  return chunks;
}

export function wrapUntrustedBody(text) {
  const safe = String(text ?? "").replaceAll("[UNTRUSTED_EMAIL_CONTENT_END]", "[UNTRUSTED_EMAIL_CONTENT_END_ESCAPED]");
  return `[UNTRUSTED_EMAIL_CONTENT_START]\n${safe}\n[UNTRUSTED_EMAIL_CONTENT_END]`;
}

export function parseRawEmail(rawBuffer, { includeAttachmentBytes = false } = {}) {
  const { headerBuffer, bodyBuffer } = splitHeadersAndBody(rawBuffer);
  const envelope = parseEnvelopeFromHeaders(headerBuffer);

  let plainText = null;
  let htmlText = null;
  const attachments = [];
  let partCounter = 0;

  function walk(hdrsMap, partBodyBuf, partId, depth) {
    if (depth > MAX_MIME_DEPTH || ++partCounter > MAX_MIME_PARTS) return;
    const ct = parseParams(hdrsMap.get("content-type")?.[0] ?? "text/plain; charset=utf-8");
    const cd = parseParams(hdrsMap.get("content-disposition")?.[0] ?? "");
    const cte = hdrsMap.get("content-transfer-encoding")?.[0] ?? "7bit";
    const type = ct.main || "text/plain";

    if (type.startsWith("multipart/") && ct.params.boundary) {
      const subParts = splitMultipartBody(partBodyBuf, ct.params.boundary);
      for (let i = 0; i < subParts.length; i += 1) {
        const { headerBuffer: subH, bodyBuffer: subB } = splitHeadersAndBody(subParts[i]);
        const subMap = parseHeaders(subH);
        const childId = partId ? `${partId}.${i + 1}` : String(i + 1);
        walk(subMap, subB, childId, depth + 1);
      }
      return;
    }

    const decodedBuf = decodePartBody(partBodyBuf, cte);
    const rawFilename = cd.params.filename ?? ct.params.name ?? null;
    const isAttachment = cd.main === "attachment"
      || (Boolean(rawFilename) && !["text/plain", "text/html"].includes(type))
      || (Boolean(rawFilename) && cd.main === "inline" && !type.startsWith("text/"));

    if (isAttachment || (!type.startsWith("text/") && type !== "")) {
      const { filename, safeExtension } = sanitizeAttachmentFilename(rawFilename || `part-${partId}.${type.split("/")[1] || "bin"}`);
      const digest = createHash("sha256").update(decodedBuf).digest("hex");
      attachments.push({
        partId: partId || "1",
        filename,
        safeExtension,
        contentType: type,
        sizeBytes: decodedBuf.length,
        sha256: digest,
        ...(includeAttachmentBytes ? { content: decodedBuf } : {}),
      });
      return;
    }

    const text = decodeCharsetBuffer(decodedBuf, ct.params.charset || "utf-8");
    if (type === "text/plain" && plainText === null) {
      plainText = text;
    } else if (type === "text/html" && htmlText === null) {
      htmlText = stripHtmlToText(text);
    }
  }

  walk(envelope.headers, bodyBuffer, "", 0);
  const rawText = (plainText ?? htmlText ?? "").trim();
  const bodyTruncated = rawText.length > MAX_BODY_CHARS;
  const textBody = bodyTruncated ? rawText.slice(0, MAX_BODY_CHARS) : rawText;

  return {
    from: envelope.from,
    to: envelope.to,
    cc: envelope.cc,
    subject: envelope.subject,
    date: envelope.date,
    messageId: envelope.messageId,
    authFailed: envelope.authFailed,
    authWarnings: envelope.authWarnings,
    textBody,
    bodyTruncated,
    attachments,
  };
}
