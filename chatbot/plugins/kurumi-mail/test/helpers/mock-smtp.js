// A local SMTP server for tests.
//
// Why a real server instead of a fake socket: the property that matters most — "before the owner
// approves, the server receives nothing" — is only meaningful if the server is a separate process
// boundary that actually speaks SMTP. Mocking the client side would let a client bug pass unnoticed.
//
// It also lets the tests exercise the TLS path for real, using a self-signed certificate generated
// for tests only (test/fixtures/cert.pem, valid to 2036). No external network is involved.
//
// Configurable failures make the error paths testable: authentication rejection, recipient refusal,
// DATA refusal, and a server that hangs mid-conversation.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CERT_FILE = path.join(HERE, "..", "fixtures", "cert.pem");
const KEY_FILE = path.join(HERE, "..", "fixtures", "key.pem");

export const TEST_USER = "owner@example.test";
export const TEST_PASS = "test-authorization-code";

export class MockSmtpServer {
  #server;
  #sockets = new Set();
  #sessions = [];
  #messages = [];
  #opts;

  constructor(options = {}) {
    this.#opts = {
      useTls: true,
      user: TEST_USER,
      pass: TEST_PASS,
      failAuth: false,
      rejectRecipients: [],
      rejectSender: false,
      rejectData: false,
      dropAfterData: false,
      hangAfterGreeting: false,
      ...options,
    };
  }

  get messages() {
    return this.#messages;
  }

  get sessions() {
    return this.#sessions;
  }

  /** Number of messages the server actually accepted. */
  get receivedCount() {
    return this.#messages.length;
  }

  async start() {
    const handler = (socket) => this.#handle(socket);
    this.#server = this.#opts.useTls
      ? tls.createServer({ cert: fs.readFileSync(CERT_FILE), key: fs.readFileSync(KEY_FILE) }, handler)
      : net.createServer(handler);
    await new Promise((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(0, "127.0.0.1", resolve);
    });
    return { host: "127.0.0.1", port: this.#server.address().port };
  }

  async stop() {
    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();
    if (!this.#server) return;
    await new Promise((resolve) => this.#server.close(resolve));
    this.#server = undefined;
  }

  #handle(socket) {
    const opts = this.#opts;
    const session = { commands: [], authenticated: false, messages: [] };
    this.#sessions.push(session);
    this.#sockets.add(socket);
    socket.setEncoding("utf8");

    let buffer = "";
    let inData = false;
    let dataLines = [];
    let awaitingUser;
    let awaitingPass = false;
    let envelopeFrom;

    const send = (line) => socket.write(`${line}\r\n`);
    send("220 mock.test ESMTP ready");

    if (opts.hangAfterGreeting) return; // deliberately silent: the client must time out

    socket.on("error", () => {});
    socket.on("close", () => this.#sockets.delete(socket));

    socket.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);

        if (inData) {
          if (line === ".") {
            inData = false;
            session.messages.push(dataLines.join("\r\n"));
            if (!opts.rejectData) {
              this.#messages.push({ from: envelopeFrom, data: dataLines.join("\r\n"), session });
            }
            dataLines = [];
            session.commands.push(".");
            if (opts.dropAfterData) {
              socket.destroy();
              return;
            }
            if (opts.rejectData) return send("554 message rejected by policy");
            return send(`250 2.0.0 Ok: queued as MOCK${this.#messages.length}`);
          }
          dataLines.push(line.startsWith("..") ? line.slice(1) : line);
          continue;
        }

        // AUTH LOGIN exchanges bare base64 lines, so they must be consumed before command dispatch.
        if (awaitingUser) {
          awaitingUser = false;
          awaitingPass = true;
          session.username = Buffer.from(line, "base64").toString("utf8");
          return send("334 UGFzc3dvcmQ6");
        }
        if (awaitingPass) {
          awaitingPass = false;
          session.authorizationCode = Buffer.from(line, "base64").toString("utf8");
          if (opts.failAuth
            || session.username !== opts.user
            || session.authorizationCode !== opts.pass) {
            session.authenticated = false;
            return send("535 5.7.8 authentication failed");
          }
          session.authenticated = true;
          return send("235 2.7.0 authentication successful");
        }

        session.commands.push(line);
        const [verbRaw, ...rest] = line.split(" ");
        const verb = String(verbRaw).toUpperCase();

        switch (verb) {
          case "EHLO":
          case "HELO":
            send("250-mock.test");
            send("250-AUTH LOGIN PLAIN");
            return send("250 8BITMIME");
          case "AUTH": {
            if (String(rest[0]).toUpperCase() !== "LOGIN") return send("504 unimplemented auth mechanism");
            awaitingUser = true;
            return send("334 VXNlcm5hbWU6");
          }
          case "*":
            return;
          case "MAIL":
            if (!session.authenticated) return send("530 5.7.0 authentication required");
            if (opts.rejectSender) return send("550 5.1.1 sender rejected");
            envelopeFrom = line.slice(line.indexOf("<") + 1, line.lastIndexOf(">"));
            session.from = envelopeFrom;
            return send("250 2.1.0 sender ok");
          case "RCPT": {
            if (!session.authenticated) return send("530 5.7.0 authentication required");
            const address = line.slice(line.indexOf("<") + 1, line.lastIndexOf(">"));
            session.rcpt = [...(session.rcpt ?? []), address];
            if (opts.rejectRecipients.includes(address)) return send("550 5.1.1 recipient rejected");
            return send("250 2.1.5 recipient ok");
          }
          case "DATA":
            if (!session.authenticated) return send("530 5.7.0 authentication required");
            inData = true;
            dataLines = [];
            return send("354 end data with <CR><LF>.<CR><LF>");
          case "QUIT":
            send("221 2.0.0 bye");
            socket.end();
            return;
          case "RSET":
            return send("250 2.0.0 ok");
          default:
            return send("500 5.5.2 unrecognised command");
        }
      }
    });
  }
}
