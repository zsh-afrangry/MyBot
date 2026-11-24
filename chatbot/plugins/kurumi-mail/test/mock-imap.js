// Loopback TLS IMAP4rev1 mock server for unit & isolated host acceptance tests.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import { decodeImapUtf7, encodeImapUtf7 } from "../imap.js";
import { parseEnvelopeFromHeaders, splitHeadersAndBody } from "../mime-parse.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const IMAP_CERT_FILE = path.join(HERE, "fixtures", "cert.pem");
export const IMAP_KEY_FILE = path.join(HERE, "fixtures", "key.pem");
export const IMAP_TEST_USER = "1794511189@qq.com";
export const IMAP_TEST_PASS = "imap-test-auth-code";

function parseCommandArgs(rest) {
  const args = [];
  let i = 0;
  while (i < rest.length) {
    while (i < rest.length && rest[i] === " ") i += 1;
    if (i >= rest.length) break;
    if (rest[i] === '"') {
      let s = "";
      i += 1;
      while (i < rest.length) {
        const ch = rest[i];
        i += 1;
        if (ch === "\\" && i < rest.length) {
          s += rest[i];
          i += 1;
        } else if (ch === '"') {
          break;
        } else {
          s += ch;
        }
      }
      args.push(s);
    } else if (rest[i] === "(") {
      let depth = 1;
      const start = i;
      i += 1;
      while (i < rest.length && depth > 0) {
        if (rest[i] === "(") depth += 1;
        else if (rest[i] === ")") depth -= 1;
        i += 1;
      }
      args.push(rest.slice(start, i));
    } else {
      const start = i;
      while (i < rest.length && rest[i] !== " ") i += 1;
      args.push(rest.slice(start, i));
    }
  }
  return args;
}

export class MockImapServer {
  #server;
  #sockets = new Set();
  #opts;
  #folders = new Map();
  commands = [];
  expungeAttempted = false;

  constructor(options = {}) {
    this.#opts = {
      useTls: true,
      user: IMAP_TEST_USER,
      pass: IMAP_TEST_PASS,
      failAuth: false,
      dropAfterCopy: false,
      ...options,
    };
    this.#folders.set("INBOX", { name: "INBOX", attributes: ["\\HasNoChildren"], uidValidity: 1001, nextUid: 1, messages: [] });
    this.#folders.set("已发送", { name: "已发送", attributes: ["\\Sent"], uidValidity: 1002, nextUid: 1, messages: [] });
    this.#folders.set("已删除", { name: "已删除", attributes: ["\\Trash"], uidValidity: 1003, nextUid: 1, messages: [] });
    this.#folders.set("账单归档", { name: "账单归档", attributes: [], uidValidity: 1004, nextUid: 1, messages: [] });
  }

  addMessage(folderName, { uid, rawBuffer, flags = [], internalDate = "24-Nov-2026 12:00:00 +0800" }) {
    const folder = this.#folders.get(folderName);
    if (!folder) throw new Error(`Unknown folder ${folderName}`);
    const assignedUid = uid ?? folder.nextUid;
    folder.nextUid = Math.max(folder.nextUid, assignedUid + 1);
    const buf = Buffer.isBuffer(rawBuffer) ? rawBuffer : Buffer.from(String(rawBuffer), "utf8");
    folder.messages.push({ uid: assignedUid, rawBuffer: buf, flags: [...flags], internalDate });
    return assignedUid;
  }

  getMessages(folderName) {
    return (this.#folders.get(folderName)?.messages ?? []).map(m => ({ ...m, flags: [...m.flags] }));
  }

  setUidValidity(folderName, uidValidity) {
    const folder = this.#folders.get(folderName);
    if (!folder) throw new Error(`Unknown folder ${folderName}`);
    folder.uidValidity = uidValidity;
  }

  async start() {
    const handler = socket => this.#handle(socket);
    this.#server = this.#opts.useTls
      ? tls.createServer({ cert: fs.readFileSync(IMAP_CERT_FILE), key: fs.readFileSync(IMAP_KEY_FILE) }, handler)
      : net.createServer(handler);
    await new Promise((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(0, "127.0.0.1", resolve);
    });
    return { host: "127.0.0.1", port: this.#server.address().port };
  }

  async stop() {
    for (const sock of this.#sockets) sock.destroy();
    this.#sockets.clear();
    if (!this.#server) return;
    await new Promise(resolve => this.#server.close(() => resolve()));
    this.#server = null;
  }

  #handle(socket) {
    this.#sockets.add(socket);
    socket.on("close", () => this.#sockets.delete(socket));
    let authenticated = false;
    let selected = null;
    let buf = Buffer.alloc(0);
    let pendingParts = [];
    let expectedLiteral = 0;

    socket.write("* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN] Mock IMAP4rev1 ready\r\n");

    const processLine = completeCommand => {
      const sp = completeCommand.indexOf(" ");
      if (sp <= 0) return;
      const tag = completeCommand.slice(0, sp);
      const rest = completeCommand.slice(sp + 1);
      const upper = rest.toUpperCase();
      this.commands.push(rest);

      if (upper === "EXPUNGE" || upper.startsWith("UID EXPUNGE") || upper === "CLOSE") {
        this.expungeAttempted = true;
        socket.write(`${tag} BAD Physical expunge/close forbidden in mock IMAP\r\n`);
        return;
      }

      if (upper.startsWith("LOGOUT")) {
        socket.write("* BYE Mock IMAP signing off\r\n");
        socket.write(`${tag} OK LOGOUT completed\r\n`);
        socket.end();
        return;
      }

      if (upper.startsWith("LOGIN ")) {
        const args = parseCommandArgs(rest.slice(6));
        if (!this.#opts.failAuth && args[0] === this.#opts.user && args[1] === this.#opts.pass) {
          authenticated = true;
          socket.write(`${tag} OK LOGIN completed\r\n`);
        } else {
          socket.write(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`);
        }
        return;
      }

      if (!authenticated) {
        socket.write(`${tag} BAD Not authenticated\r\n`);
        return;
      }

      if (upper.startsWith("LIST ")) {
        for (const folder of this.#folders.values()) {
          const encoded = encodeImapUtf7(folder.name);
          socket.write(`* LIST (${folder.attributes.join(" ")}) "/" "${encoded}"\r\n`);
        }
        socket.write(`${tag} OK LIST completed\r\n`);
        return;
      }

      if (upper.startsWith("EXAMINE ") || upper.startsWith("SELECT ")) {
        const verb = upper.startsWith("EXAMINE ") ? "EXAMINE" : "SELECT";
        const args = parseCommandArgs(rest.slice(verb.length + 1));
        const decodedName = decodeImapUtf7(args[0] ?? "INBOX");
        const folder = this.#folders.get(decodedName);
        if (!folder) {
          socket.write(`${tag} NO Mailbox does not exist\r\n`);
          return;
        }
        selected = { folder, readOnly: verb === "EXAMINE" };
        socket.write(`* ${folder.messages.length} EXISTS\r\n`);
        socket.write(`* OK [UIDVALIDITY ${folder.uidValidity}] UIDs valid\r\n`);
        socket.write(`${tag} OK [${verb === "EXAMINE" ? "READ-ONLY" : "READ-WRITE"}] ${verb} completed\r\n`);
        return;
      }

      if (!selected) {
        socket.write(`${tag} BAD No mailbox selected\r\n`);
        return;
      }

      if (upper.startsWith("UID SEARCH ")) {
        let tokens = parseCommandArgs(rest.slice(11));
        if (tokens[0]?.toUpperCase() === "CHARSET") tokens = tokens.slice(2);
        let unseenOnly = false;
        let fromFilter = null;
        let subjectFilter = null;
        let sinceDate = null;
        for (let i = 0; i < tokens.length; i += 1) {
          const kw = tokens[i].toUpperCase();
          if (kw === "UNSEEN") unseenOnly = true;
          else if (kw === "FROM" && i + 1 < tokens.length) fromFilter = tokens[++i].toLowerCase();
          else if (kw === "SUBJECT" && i + 1 < tokens.length) subjectFilter = tokens[++i].toLowerCase();
          else if (kw === "SINCE" && i + 1 < tokens.length) sinceDate = tokens[++i];
        }
        const matched = selected.folder.messages.filter(m => {
          if (unseenOnly && m.flags.some(f => f.toLowerCase() === "\\seen")) return false;
          const { headerBuffer } = splitHeadersAndBody(m.rawBuffer);
          const env = parseEnvelopeFromHeaders(headerBuffer);
          if (fromFilter && !(env.from.address ?? "").toLowerCase().includes(fromFilter)) return false;
          if (subjectFilter && !env.subject.toLowerCase().includes(subjectFilter)) return false;
          if (sinceDate) {
            const sinceMs = Date.parse(sinceDate);
            const mailMs = Date.parse(env.date ?? m.internalDate);
            if (Number.isFinite(sinceMs) && Number.isFinite(mailMs) && mailMs < sinceMs) return false;
          }
          return true;
        });
        socket.write(`* SEARCH${matched.length ? " " + matched.map(m => m.uid).join(" ") : ""}\r\n`);
        socket.write(`${tag} OK UID SEARCH completed\r\n`);
        return;
      }

      if (upper.startsWith("UID FETCH ")) {
        const args = parseCommandArgs(rest.slice(10));
        const uids = new Set(String(args[0] ?? "").split(",").map(Number));
        const spec = String(args[1] ?? "").toUpperCase();
        selected.folder.messages.forEach((msg, idx) => {
          if (!uids.has(msg.uid)) return;
          const seq = idx + 1;
          const { headerBuffer } = splitHeadersAndBody(msg.rawBuffer);
          const prefix = `* ${seq} FETCH (UID ${msg.uid} FLAGS (${msg.flags.join(" ")}) INTERNALDATE "${msg.internalDate}" RFC822.SIZE ${msg.rawBuffer.length}`;
          if (spec.includes("BODY.PEEK[HEADER]")) {
            socket.write(`${prefix} BODY[HEADER] {${headerBuffer.length}}\r\n`);
            socket.write(headerBuffer);
            socket.write(")\r\n");
          } else if (spec.includes("BODY.PEEK[]")) {
            socket.write(`${prefix} BODY[] {${msg.rawBuffer.length}}\r\n`);
            socket.write(msg.rawBuffer);
            socket.write(")\r\n");
          } else {
            socket.write(`${prefix})\r\n`);
          }
        });
        socket.write(`${tag} OK UID FETCH completed\r\n`);
        return;
      }

      if (upper.startsWith("UID STORE ")) {
        if (selected.readOnly) {
          socket.write(`${tag} NO Mailbox is read-only\r\n`);
          return;
        }
        const args = parseCommandArgs(rest.slice(10));
        const uid = Number(args[0]);
        const op = String(args[1] ?? "").toUpperCase();
        const flagList = String(args[2] ?? "").replace(/[()]/gu, "").split(/\s+/u).filter(Boolean);
        const msg = selected.folder.messages.find(m => m.uid === uid);
        if (!msg) {
          socket.write(`${tag} NO UID not found\r\n`);
          return;
        }
        for (const f of flagList) {
          if (op.startsWith("+FLAGS")) {
            if (!msg.flags.includes(f)) msg.flags.push(f);
          } else if (op.startsWith("-FLAGS")) {
            msg.flags = msg.flags.filter(existing => existing.toLowerCase() !== f.toLowerCase());
          }
        }
        socket.write(`${tag} OK UID STORE completed\r\n`);
        return;
      }

      if (upper.startsWith("UID COPY ")) {
        const args = parseCommandArgs(rest.slice(9));
        const uid = Number(args[0]);
        const targetName = decodeImapUtf7(args[1] ?? "");
        const target = this.#folders.get(targetName);
        const msg = selected.folder.messages.find(m => m.uid === uid);
        if (!target || !msg) {
          socket.write(`${tag} NO Copy failed\r\n`);
          return;
        }
        this.addMessage(targetName, { rawBuffer: msg.rawBuffer, flags: msg.flags, internalDate: msg.internalDate });
        if (this.#opts.dropAfterCopy) {
          socket.destroy();
          return;
        }
        socket.write(`${tag} OK UID COPY completed\r\n`);
        return;
      }

      socket.write(`${tag} BAD Unsupported command\r\n`);
    };

    socket.on("data", chunk => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      while (buf.length > 0) {
        if (expectedLiteral > 0) {
          if (buf.length < expectedLiteral) break;
          const litStr = buf.subarray(0, expectedLiteral).toString("utf8");
          buf = buf.subarray(expectedLiteral);
          expectedLiteral = 0;
          const safeTok = !litStr.includes('"') && !litStr.includes("\\") ? `"${litStr}"` : litStr;
          pendingParts.push(safeTok);
          continue;
        }
        const lfIdx = buf.indexOf(0x0a);
        if (lfIdx === -1) break;
        const hasCr = lfIdx > 0 && buf[lfIdx - 1] === 0x0d;
        const line = buf.subarray(0, hasCr ? lfIdx - 1 : lfIdx).toString("utf8");
        buf = buf.subarray(lfIdx + 1);
        const litM = /^(.*)\{(\d+)\}$/u.exec(line);
        if (litM) {
          pendingParts.push(litM[1]);
          expectedLiteral = Number(litM[2]);
          socket.write("+ Ready for literal data\r\n");
          continue;
        }
        pendingParts.push(line);
        const full = pendingParts.join("");
        pendingParts = [];
        processLine(full);
      }
    });
  }
}
