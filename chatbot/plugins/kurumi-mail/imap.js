// Minimal IMAP4rev1 client over implicit TLS for kurumi-mail.
//
// Invariants:
//   * No third-party runtime dependencies: only node:net / node:tls / node:buffer.
//   * Credentials never appear in thrown errors or diagnostics.
//   * Read paths use EXAMINE and BODY.PEEK[...] so listing/reading headers never marks emails \Seen.
//   * Never issues EXPUNGE, UID EXPUNGE, or CLOSE (CLOSE on SELECT silently expunges \Deleted).
import net from "node:net";
import tls from "node:tls";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_LITERAL_BYTES = 32 * 1024 * 1024;
const LITERAL_PLACEHOLDER = idx => `\u0000LIT:${idx}\u0000`;

export class ImapError extends Error {
  constructor(code, message, { stage, responseStatus } = {}) {
    super(message);
    this.name = "ImapError";
    this.code = code;
    this.stage = stage;
    this.responseStatus = responseStatus;
  }
}

export function defaultImapConnector({ host, port, secure = true, timeoutMs = DEFAULT_TIMEOUT_MS, tlsOptions } = {}) {
  return new Promise((resolve, reject) => {
    let socket;
    const cleanup = () => {
      if (!socket) return;
      socket.removeListener("error", onError);
      socket.removeListener("timeout", onTimeout);
      socket.removeListener("secureConnect", onConnect);
      socket.removeListener("connect", onConnect);
    };
    const onError = error => {
      cleanup();
      reject(new ImapError("imap_connect_failed", `IMAP connection failed: ${error?.code ?? "error"}`, { stage: "connect" }));
    };
    const onTimeout = () => {
      cleanup();
      socket?.destroy();
      reject(new ImapError("imap_timeout", "IMAP connection timed out", { stage: "connect" }));
    };
    const onConnect = () => {
      cleanup();
      resolve(socket);
    };
    const rawServername = tlsOptions?.servername ?? host;
    const connectOpts = { host, port, rejectUnauthorized: true, ...tlsOptions };
    if (typeof rawServername === "string" && rawServername.length > 0 && net.isIP(rawServername) === 0) {
      connectOpts.servername = rawServername;
    } else {
      delete connectOpts.servername;
    }
    try {
      socket = secure ? tls.connect(connectOpts) : net.connect({ host, port });
    } catch (error) {
      reject(new ImapError("imap_connect_failed", `IMAP connection failed: ${error?.code ?? "error"}`, { stage: "connect" }));
      return;
    }
    socket.setTimeout(timeoutMs);
    socket.once("error", onError);
    socket.once("timeout", onTimeout);
    socket.once(secure ? "secureConnect" : "connect", onConnect);
  });
}

/** Encode a mailbox name into RFC 3501 Modified UTF-7. */
export function encodeImapUtf7(input) {
  const str = String(input ?? "");
  let out = "";
  let nonAscii = "";
  const flushNonAscii = () => {
    if (!nonAscii) return;
    const utf16 = Buffer.alloc(nonAscii.length * 2);
    for (let i = 0; i < nonAscii.length; i += 1) {
      utf16.writeUInt16BE(nonAscii.charCodeAt(i), i * 2);
    }
    const b64 = utf16.toString("base64").replace(/=+$/u, "").replaceAll("/", ",");
    out += `&${b64}-`;
    nonAscii = "";
  };
  for (let i = 0; i < str.length; i += 1) {
    const code = str.charCodeAt(i);
    if (code >= 0x20 && code <= 0x7e) {
      flushNonAscii();
      out += code === 0x26 ? "&-" : str[i];
    } else {
      nonAscii += str[i];
    }
  }
  flushNonAscii();
  return out;
}

/** Decode an RFC 3501 Modified UTF-7 mailbox name back to Unicode. */
export function decodeImapUtf7(input) {
  const str = String(input ?? "");
  let out = "";
  for (let i = 0; i < str.length; i += 1) {
    if (str[i] !== "&") {
      out += str[i];
      continue;
    }
    const end = str.indexOf("-", i + 1);
    if (end === -1) {
      out += str.slice(i);
      break;
    }
    if (end === i + 1) {
      out += "&";
    } else {
      const b64 = str.slice(i + 1, end).replaceAll(",", "/");
      const raw = Buffer.from(b64, "base64");
      for (let off = 0; off + 1 < raw.length; off += 2) {
        out += String.fromCharCode(raw.readUInt16BE(off));
      }
    }
    i = end;
  }
  return out;
}

function unquoteImapString(token, literals) {
  if (!token) return "";
  const litMatch = /^\u0000LIT:(\d+)\u0000$/u.exec(token);
  if (litMatch) {
    return (literals[Number(litMatch[1])] ?? Buffer.alloc(0)).toString("utf8");
  }
  if (token.startsWith('"') && token.endsWith('"') && token.length >= 2) {
    return token.slice(1, -1).replace(/\\(["\\])/gu, "$1");
  }
  return token === "NIL" ? "" : token;
}

function tokenizeImapFields(text) {
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    while (i < text.length && (text[i] === " " || text[i] === "\t")) i += 1;
    if (i >= text.length) break;
    if (text[i] === "\u0000") {
      const end = text.indexOf("\u0000", i + 1);
      if (end !== -1) {
        tokens.push(text.slice(i, end + 1));
        i = end + 1;
        continue;
      }
    }
    if (text[i] === '"') {
      let val = '"';
      i += 1;
      while (i < text.length) {
        const ch = text[i];
        val += ch;
        i += 1;
        if (ch === "\\" && i < text.length) {
          val += text[i];
          i += 1;
        } else if (ch === '"') {
          break;
        }
      }
      tokens.push(val);
      continue;
    }
    if (text[i] === "(" || text[i] === ")") {
      tokens.push(text[i]);
      i += 1;
      continue;
    }
    let start = i;
    while (i < text.length && ![" ", "\t", "(", ")"].includes(text[i])) i += 1;
    tokens.push(text.slice(start, i));
  }
  return tokens;
}

function parseListLine(lineText, literals) {
  const match = /^\* LIST \(([^)]*)\) ("[^"]*"|NIL|\S+) (.+)$/iu.exec(lineText);
  if (!match) return null;
  const attrs = match[1].split(/\s+/u).filter(Boolean);
  const delimiter = unquoteImapString(match[2], literals) || "/";
  const rawName = unquoteImapString(match[3].trim(), literals);
  return {
    rawName,
    name: decodeImapUtf7(rawName),
    attributes: attrs,
    delimiter,
    selectable: !attrs.some(a => a.toLowerCase() === "\\noselect"),
  };
}

function parseFetchResponse(item) {
  const full = item.line;
  const match = /^\* (\d+) FETCH \(([\s\S]*)\)$/iu.exec(full);
  if (!match) return null;
  const seq = Number(match[1]);
  const tokens = tokenizeImapFields(match[2]);
  const record = { seq, flags: [], bodyParts: [] };
  let i = 0;
  while (i < tokens.length) {
    const key = tokens[i]?.toUpperCase();
    i += 1;
    if (key === "UID") {
      record.uid = Number(tokens[i]);
      i += 1;
    } else if (key === "RFC822.SIZE") {
      record.sizeBytes = Number(tokens[i]);
      i += 1;
    } else if (key === "INTERNALDATE") {
      record.internalDate = unquoteImapString(tokens[i], item.literals);
      i += 1;
    } else if (key === "FLAGS") {
      const flags = [];
      if (tokens[i] === "(") {
        i += 1;
        while (i < tokens.length && tokens[i] !== ")") {
          flags.push(tokens[i]);
          i += 1;
        }
        i += 1;
      }
      record.flags = flags;
    } else if (key?.startsWith("BODY[") && key.endsWith("]")) {
      const tok = tokens[i];
      i += 1;
      const litMatch = /^\u0000LIT:(\d+)\u0000$/u.exec(tok ?? "");
      const buf = litMatch
        ? (item.literals[Number(litMatch[1])] ?? Buffer.alloc(0))
        : Buffer.from(unquoteImapString(tok, item.literals), "utf8");
      record.bodyParts.push({ section: key, data: buf });
    } else if (tokens[i] === "(") {
      let depth = 1;
      i += 1;
      while (i < tokens.length && depth > 0) {
        if (tokens[i] === "(") depth += 1;
        else if (tokens[i] === ")") depth -= 1;
        i += 1;
      }
    } else {
      i += 1;
    }
  }
  return record;
}

function formatImapDate(yyyyMmDd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(String(yyyyMmDd ?? ""));
  if (!m) throw new ImapError("invalid_imap_date", "日期过滤须为 YYYY-MM-DD", { stage: "search" });
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const monthIdx = Number(m[2]) - 1;
  const day = Number(m[3]);
  if (monthIdx < 0 || monthIdx > 11 || day < 1 || day > 31) {
    throw new ImapError("invalid_imap_date", "无效日期", { stage: "search" });
  }
  return `${day}-${months[monthIdx]}-${m[1]}`;
}

function assertNoControlChars(value, label) {
  const str = String(value ?? "");
  if (/[\r\n\0]/u.test(str)) {
    throw new ImapError("invalid_imap_argument", `${label} must not contain control characters`, { stage: "command" });
  }
  return str;
}

function quoteOrLiteralArg(value) {
  const str = assertNoControlChars(value, "IMAP argument");
  if (/^[\x20-\x7e]*$/u.test(str) && !str.includes('"') && !str.includes("\\")) {
    return { type: "inline", text: `"${str}"` };
  }
  return { type: "literal", data: Buffer.from(str, "utf8") };
}

export class ImapClient {
  #socket;
  #buffer = Buffer.alloc(0);
  #currentParts = [];
  #currentLiterals = [];
  #literalRemaining = 0;
  #literalChunks = [];
  #literalSize = 0;
  #responses = [];
  #waiter = null;
  #closed = false;
  #tagCounter = 0;
  #timeoutMs;
  #selected = null;

  constructor(socket, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.#socket = socket;
    this.#timeoutMs = timeoutMs;
    socket.on("data", chunk => {
      const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
      this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, incoming]) : incoming;
      this.#parseIncoming();
      this.#drain();
    });
    socket.on("error", error => {
      this.#fail(new ImapError("imap_connection_error", `IMAP socket error: ${error?.code ?? "error"}`, { stage: "transport" }));
    });
    socket.on("close", () => {
      this.#closed = true;
      this.#drain();
    });
  }

  get selectedMailbox() {
    return this.#selected ? { ...this.#selected } : null;
  }

  #parseIncoming() {
    while (this.#buffer.length > 0) {
      if (this.#literalRemaining > 0) {
        const take = Math.min(this.#literalRemaining, this.#buffer.length);
        this.#literalChunks.push(this.#buffer.subarray(0, take));
        this.#literalSize += take;
        this.#literalRemaining -= take;
        this.#buffer = this.#buffer.subarray(take);
        if (this.#literalRemaining > 0) break;
        const litBuf = Buffer.concat(this.#literalChunks, this.#literalSize);
        this.#literalChunks = [];
        this.#literalSize = 0;
        const litIdx = this.#currentLiterals.length;
        this.#currentLiterals.push(litBuf);
        this.#currentParts.push(LITERAL_PLACEHOLDER(litIdx));
        continue;
      }

      const lfIdx = this.#buffer.indexOf(0x0a);
      if (lfIdx === -1) break;
      const hasCr = lfIdx > 0 && this.#buffer[lfIdx - 1] === 0x0d;
      const lineBytes = this.#buffer.subarray(0, hasCr ? lfIdx - 1 : lfIdx);
      this.#buffer = this.#buffer.subarray(lfIdx + 1);
      const text = lineBytes.toString("utf8");
      const litHeader = /^(.*)\{(\d+)\}$/u.exec(text);
      if (litHeader) {
        const bytes = Number(litHeader[2]);
        if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_LITERAL_BYTES) {
          this.#fail(new ImapError("imap_literal_too_large", "IMAP response literal exceeds size limit", { stage: "parse" }));
          this.destroy();
          return;
        }
        this.#currentParts.push(litHeader[1]);
        this.#literalRemaining = bytes;
        if (bytes === 0) {
          const idx = this.#currentLiterals.length;
          this.#currentLiterals.push(Buffer.alloc(0));
          this.#currentParts.push(LITERAL_PLACEHOLDER(idx));
        }
        continue;
      }

      this.#currentParts.push(text);
      const completeLine = this.#currentParts.join("");
      const literals = this.#currentLiterals;
      this.#currentParts = [];
      this.#currentLiterals = [];
      this.#responses.push({ line: completeLine, literals });
    }
  }

  #fail(error) {
    const waiter = this.#waiter;
    this.#waiter = null;
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  #drain() {
    if (!this.#waiter) return;
    while (this.#responses.length > 0) {
      const next = this.#responses.shift();
      this.#waiter.onItem(next);
      if (!this.#waiter) return;
    }
    if (this.#closed && this.#waiter) {
      this.#fail(new ImapError("imap_connection_closed", "IMAP server closed connection unexpectedly", { stage: "transport" }));
    }
  }

  #awaitItem(stage, onItem) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.#waiter?.reject === reject) {
          this.#waiter = null;
          reject(new ImapError("imap_timeout", `IMAP timed out at ${stage}`, { stage }));
        }
      }, this.#timeoutMs);
      this.#waiter = {
        reject,
        timer,
        onItem: item => {
          let done;
          try {
            done = onItem(item, () => {
              clearTimeout(timer);
              this.#waiter = null;
              resolve(item);
            });
          } catch (error) {
            clearTimeout(timer);
            this.#waiter = null;
            reject(error);
            return;
          }
          if (done) {
            clearTimeout(timer);
            this.#waiter = null;
            resolve(done);
          }
        },
      };
      this.#drain();
    });
  }

  async greeting() {
    let status = "OK";
    await this.#awaitItem("greeting", (item, finish) => {
      if (item.line.startsWith("* ")) {
        if (/^\* (BYE|BAD|NO)\b/iu.test(item.line)) status = "FAIL";
        finish();
        return item;
      }
      return null;
    });
    if (status !== "OK") throw new ImapError("imap_bad_greeting", "IMAP server rejected initial connection", { stage: "greeting" });
  }

  async #command(stage, parts, { checkStatus = true } = {}) {
    const tag = `A${String(++this.#tagCounter).padStart(4, "0")}`;
    const segments = [];
    for (const part of parts) {
      if (typeof part === "string") segments.push({ type: "inline", text: part });
      else segments.push(part);
    }

    // Group writes up to each synchronizing literal continuation.
    const untagged = [];
    let currentLine = `${tag} `;
    for (let idx = 0; idx < segments.length; idx += 1) {
      const seg = segments[idx];
      if (idx > 0) currentLine += " ";
      if (seg.type === "inline") {
        currentLine += seg.text;
        continue;
      }
      this.#socket.write(`${currentLine}{${seg.data.length}}\r\n`);
      await this.#awaitItem(stage, item => {
        if (item.line.startsWith("+")) return item;
        const tagged = new RegExp(`^${tag} (OK|NO|BAD)\\b`, "iu").exec(item.line);
        if (tagged) {
          throw new ImapError("imap_command_rejected", `IMAP server rejected ${stage} (${tagged[1].toUpperCase()})`, {
            stage,
            responseStatus: tagged[1].toUpperCase(),
          });
        }
        untagged.push(item);
        return null;
      });
      this.#socket.write(seg.data);
      currentLine = "";
    }
    this.#socket.write(`${currentLine}\r\n`);

    const taggedRegex = new RegExp(`^${tag} (OK|NO|BAD)(?: (.*))?$`, "iu");
    const finalItem = await this.#awaitItem(stage, item => {
      const m = taggedRegex.exec(item.line);
      if (m) return { status: m[1].toUpperCase(), text: m[2] ?? "", item };
      untagged.push(item);
      return null;
    });
    if (checkStatus && finalItem.status !== "OK") {
      const code = stage === "login" ? "imap_auth_failed" : "imap_command_failed";
      throw new ImapError(code, `IMAP ${stage} failed (${finalItem.status})`, { stage, responseStatus: finalItem.status });
    }
    return { status: finalItem.status, text: finalItem.text, untagged };
  }

  async login(user, authCode) {
    if (!user || !authCode) {
      throw new ImapError("imap_missing_credentials", "IMAP credentials are not configured", { stage: "login" });
    }
    await this.#command("login", ["LOGIN", quoteOrLiteralArg(user), quoteOrLiteralArg(authCode)]);
  }

  async listMailboxes(reference = '""', pattern = '"*"') {
    const res = await this.#command("list", ["LIST", reference, pattern]);
    return res.untagged.map(item => parseListLine(item.line, item.literals)).filter(Boolean);
  }

  async selectMailbox(name, { readOnly = true } = {}) {
    const mailboxName = String(name || "INBOX");
    const encoded = encodeImapUtf7(assertNoControlChars(mailboxName, "mailbox"));
    const verb = readOnly ? "EXAMINE" : "SELECT";
    const res = await this.#command(verb.toLowerCase(), [verb, quoteOrLiteralArg(encoded)]);
    let uidValidity = null;
    let exists = 0;
    for (const item of res.untagged) {
      const uv = /^\* OK \[UIDVALIDITY (\d+)\]/iu.exec(item.line);
      if (uv) uidValidity = Number(uv[1]);
      const ex = /^\* (\d+) EXISTS$/iu.exec(item.line);
      if (ex) exists = Number(ex[1]);
    }
    this.#selected = { name: mailboxName, encodedName: encoded, readOnly, uidValidity, exists };
    return this.selectedMailbox;
  }

  async uidSearch({ unseenOnly = false, from, subject, since } = {}) {
    const parts = ["UID SEARCH"];
    const textValues = [];
    if (from) textValues.push(["FROM", from]);
    if (subject) textValues.push(["SUBJECT", subject]);
    if (textValues.some(([, val]) => /[^\x20-\x7e]/u.test(val))) {
      parts.push("CHARSET UTF-8");
    }
    if (unseenOnly) parts.push("UNSEEN");
    if (since) parts.push(`SINCE ${formatImapDate(since)}`);
    for (const [kw, val] of textValues) {
      parts.push(kw, quoteOrLiteralArg(val));
    }
    if (!unseenOnly && !since && textValues.length === 0) {
      parts.push("ALL");
    }
    const res = await this.#command("uid_search", parts);
    const uids = [];
    for (const item of res.untagged) {
      const m = /^\* SEARCH(?:\s+(.*))?$/iu.exec(item.line);
      if (m && m[1]) {
        for (const tok of m[1].trim().split(/\s+/u)) {
          const uid = Number(tok);
          if (Number.isSafeInteger(uid) && uid > 0) uids.push(uid);
        }
      }
    }
    return uids;
  }

  async uidFetchHeaders(uids) {
    const list = (Array.isArray(uids) ? uids : [uids]).filter(n => Number.isSafeInteger(n) && n > 0);
    if (list.length === 0) return [];
    const res = await this.#command("uid_fetch_headers", [
      "UID FETCH",
      list.join(","),
      "(UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[HEADER])",
    ]);
    return res.untagged.map(parseFetchResponse).filter(Boolean).map(row => ({
      uid: row.uid,
      flags: row.flags,
      seen: row.flags.some(f => f.toLowerCase() === "\\seen"),
      internalDate: row.internalDate ?? null,
      sizeBytes: row.sizeBytes ?? null,
      headerBuffer: row.bodyParts.find(p => p.section.startsWith("BODY[HEADER"))?.data ?? Buffer.alloc(0),
    }));
  }

  async uidFetchMeta(uid) {
    if (!Number.isSafeInteger(uid) || uid < 1) throw new ImapError("invalid_uid", "无效邮件 UID", { stage: "fetch" });
    const res = await this.#command("uid_fetch_meta", [
      "UID FETCH",
      String(uid),
      "(UID FLAGS INTERNALDATE RFC822.SIZE)",
    ]);
    const row = res.untagged.map(parseFetchResponse).find(Boolean);
    if (!row) return null;
    return {
      uid: row.uid ?? uid,
      flags: row.flags,
      seen: row.flags.some(f => f.toLowerCase() === "\\seen"),
      internalDate: row.internalDate ?? null,
      sizeBytes: row.sizeBytes ?? 0,
    };
  }

  async uidFetchRaw(uid, { maxBytes = 25 * 1024 * 1024 } = {}) {
    const meta = await this.uidFetchMeta(uid);
    if (!meta) throw new ImapError("email_not_found", `未找到 UID=${uid} 的邮件`, { stage: "fetch" });
    if (meta.sizeBytes > maxBytes) {
      throw new ImapError("email_message_too_large", `邮件大小 (${meta.sizeBytes} 字节) 超出安全上限 (${maxBytes})`, { stage: "fetch" });
    }
    const res = await this.#command("uid_fetch_raw", [
      "UID FETCH",
      String(uid),
      "(UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[])",
    ]);
    const row = res.untagged.map(parseFetchResponse).find(Boolean);
    const rawBuffer = row?.bodyParts.find(p => p.section === "BODY[]")?.data;
    if (!rawBuffer) throw new ImapError("email_not_found", `未读取到 UID=${uid} 的邮件原始内容`, { stage: "fetch" });
    if (rawBuffer.length > maxBytes) {
      throw new ImapError("email_message_too_large", "邮件原始内容超出安全上限", { stage: "fetch" });
    }
    return { ...meta, flags: row.flags ?? meta.flags, rawBuffer };
  }

  async uidStoreSeen(uid, seen) {
    if (!Number.isSafeInteger(uid) || uid < 1) throw new ImapError("invalid_uid", "无效邮件 UID", { stage: "store" });
    const op = seen ? "+FLAGS.SILENT" : "-FLAGS.SILENT";
    await this.#command("uid_store_seen", ["UID STORE", String(uid), op, "(\\Seen)"]);
  }

  /**
   * Move by UID COPY + UID STORE \Deleted WITHOUT calling EXPUNGE or CLOSE,
   * preserving recoverable trash / folder semantics on IMAP servers.
   */
  async uidCopyAndMarkDeleted(uid, targetMailbox) {
    if (!Number.isSafeInteger(uid) || uid < 1) throw new ImapError("invalid_uid", "无效邮件 UID", { stage: "copy" });
    const encoded = encodeImapUtf7(assertNoControlChars(String(targetMailbox ?? ""), "targetMailbox"));
    await this.#command("uid_copy", ["UID COPY", String(uid), quoteOrLiteralArg(encoded)]);
    await this.#command("uid_mark_deleted", ["UID STORE", String(uid), "+FLAGS.SILENT", "(\\Deleted)"]);
  }

  async logout() {
    try {
      if (!this.#closed) await this.#command("logout", ["LOGOUT"], { checkStatus: false });
    } catch {
      // Closing socket after LOGOUT attempt suffices.
    } finally {
      this.destroy();
    }
  }

  destroy() {
    this.#closed = true;
    this.#socket?.end?.();
    this.#socket?.destroy?.();
  }
}

export async function withImapClient(config, { readOnly = true, folder = "INBOX", connector = defaultImapConnector, tlsOptions } = {}, work) {
  const socket = await connector({ host: config.host, port: config.port, secure: true, tlsOptions });
  const client = new ImapClient(socket);
  try {
    await client.greeting();
    await client.login(config.user, config.authCode);
    const mailbox = folder ? await client.selectMailbox(folder, { readOnly }) : null;
    const result = await work(client, mailbox);
    await client.logout();
    return result;
  } catch (error) {
    client.destroy();
    throw error;
  }
}
