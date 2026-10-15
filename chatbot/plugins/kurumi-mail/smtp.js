// Minimal SMTP client for kurumi-mail.
//
// Scope: exactly what delivering one message needs — implicit TLS on 465 (the verified path for QQ
// Mail), EHLO, AUTH LOGIN, MAIL FROM / RCPT TO / DATA / QUIT. No dependency beyond node:net and
// node:tls, because the runtime pins its own dependency set.
//
// Two properties this module is responsible for:
//   * credentials never appear in thrown errors or log output. Errors carry protocol codes and short
//     reason phrases only; the username and authorization code are never interpolated into a message.
//   * the envelope sender comes from the built message (never empty). An earlier prototype emitted
//     `MAIL FROM:<>`, which some servers accept and silently misattribute.
import net from "node:net";
import tls from "node:tls";

const DEFAULT_TIMEOUT_MS = 30_000;

/** Protocol-level failure. `detail` is always safe to show: it never contains credentials. */
export class SmtpError extends Error {
  constructor(code, message, {stage, responseCode, permanent = false} = {}) {
    super(message);
    this.name = "SmtpError";
    this.code = code;
    this.stage = stage;
    this.responseCode = responseCode;
    this.permanent = permanent;
  }
}

/** One response line: `250-text` continues, `250 text` ends the reply. */
function parseResponseLines(chunk, carry) {
  const text = carry + chunk;
  const lines = text.split(/\r?\n/);
  const rest = lines.pop() ?? "";
  return { lines, rest };
}

/**
 * Take one complete reply from the front of the buffer.
 *
 * A reply is one or more lines; lines with "-" after the code continue it and the first line with a
 * space ends it. Returns how many lines were consumed so the caller can drop exactly those — an
 * earlier version only inspected the first line and therefore never resolved a multi-line EHLO
 * greeting (the mock server exposed this immediately).
 */
function takeReply(lines) {
  if (lines.length === 0) return undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\d{3})([ -])(.*)$/.exec(lines[index]);
    if (!match) return undefined; // not a reply line yet; wait for more
    if (match[2] === " ") {
      const text = lines.slice(0, index + 1).map((line) => line.slice(4)).join("\n");
      return { reply: { code: Number(match[1]), text }, consumed: index + 1 };
    }
  }
  return undefined; // continuation lines only so far
}

/**
 * A single SMTP conversation over an already-connected socket.
 * Tests drive this against a local mock server; production drives it over TLS to the mail host.
 */
export class SmtpClient {
  #socket;
  #buffer = "";
  #lines = [];
  #waiter;
  #closed = false;
  #timeoutMs;

  constructor(socket, {timeoutMs = DEFAULT_TIMEOUT_MS} = {}) {
    this.#socket = socket;
    this.#timeoutMs = timeoutMs;
    socket.setEncoding?.("utf8");
    socket.on("data", (chunk) => {
      const { lines, rest } = parseResponseLines(String(chunk), this.#buffer);
      this.#buffer = rest;
      this.#lines.push(...lines);
      this.#drain();
    });
    socket.on("error", (error) => {
      this.#fail(new SmtpError("connection_error", `SMTP connection failed: ${error.code ?? "error"}`, {stage: "transport"}));
    });
    socket.on("close", () => {
      this.#closed = true;
      this.#drain();
    });
  }

  #fail(error) {
    const waiter = this.#waiter;
    this.#waiter = undefined;
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  #drain() {
    if (!this.#waiter) return;
    const taken = takeReply(this.#lines);
    if (taken) {
      this.#lines = this.#lines.slice(taken.consumed);
      const waiter = this.#waiter;
      this.#waiter = undefined;
      clearTimeout(waiter.timer);
      waiter.resolve(taken.reply);
      return;
    }
    if (this.#closed) {
      this.#fail(new SmtpError("connection_closed", "SMTP server closed the connection", {stage: "transport"}));
    }
  }

  /** Wait for the next complete reply. */
  #reply(stage) {
    const taken = takeReply(this.#lines);
    if (taken) {
      this.#lines = this.#lines.slice(taken.consumed);
      return Promise.resolve(taken.reply);
    }
    if (this.#closed) {
      return Promise.reject(new SmtpError("connection_closed", "SMTP server closed the connection", {stage}));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiter = undefined;
        reject(new SmtpError("timeout", `SMTP ${stage} timed out`, {stage}));
      }, this.#timeoutMs);
      timer.unref?.();
      this.#waiter = { resolve, reject, timer };
    });
  }

  #write(line) {
    this.#socket.write(`${line}\r\n`);
  }

  /** Read the server greeting. */
  async greeting() {
    const reply = await this.#reply("greeting");
    if (reply.code !== 220) throw new SmtpError("bad_greeting", `unexpected greeting ${reply.code}`, {stage: "greeting", responseCode: reply.code});
    return reply;
  }

  async ehlo(hostname = "localhost") {
    this.#write(`EHLO ${hostname}`);
    const reply = await this.#reply("ehlo");
    if (reply.code !== 250) throw new SmtpError("ehlo_rejected", `EHLO rejected with ${reply.code}`, {stage: "ehlo", responseCode: reply.code});
    return reply;
  }

  /**
   * AUTH LOGIN. Credentials are sent base64-encoded as the protocol requires; on failure the error
   * carries only the server's status code, never the credentials.
   */
  async authLogin(user, pass) {
    if (typeof user !== "string" || typeof pass !== "string" || !user || !pass) {
      throw new SmtpError("missing_credentials", "SMTP username and authorization code are required", {stage: "auth"});
    }
    this.#write("AUTH LOGIN");
    const challengeUser = await this.#reply("auth");
    if (challengeUser.code !== 334) throw new SmtpError("auth_unsupported", `AUTH LOGIN not accepted (${challengeUser.code})`, {stage: "auth", responseCode: challengeUser.code});
    this.#write(Buffer.from(user, "utf8").toString("base64"));
    const challengePass = await this.#reply("auth");
    if (challengePass.code !== 334) throw new SmtpError("auth_failed", `authentication rejected (${challengePass.code})`, {stage: "auth", responseCode: challengePass.code, permanent: challengePass.code >= 500});
    this.#write(Buffer.from(pass, "utf8").toString("base64"));
    const result = await this.#reply("auth");
    if (result.code !== 235) {
      throw new SmtpError("auth_failed", `authentication failed (${result.code})`, {stage: "auth", responseCode: result.code, permanent: result.code >= 500});
    }
    return result;
  }

  async mailFrom(address) {
    if (!address) throw new SmtpError("missing_sender", "envelope sender is required", {stage: "mail"});
    this.#write(`MAIL FROM:<${address}>`);
    const reply = await this.#reply("mail");
    if (reply.code !== 250) throw new SmtpError("sender_rejected", `sender rejected (${reply.code})`, {stage: "mail", responseCode: reply.code, permanent: reply.code >= 500});
    return reply;
  }

  async rcptTo(address) {
    this.#write(`RCPT TO:<${address}>`);
    const reply = await this.#reply("rcpt");
    return { address, code: reply.code, accepted: reply.code === 250 || reply.code === 251 };
  }

  /** DATA phase. `raw` must already be a complete RFC 5322 message. */
  async data(raw) {
    this.#write("DATA");
    const ready = await this.#reply("data");
    if (ready.code !== 354) throw new SmtpError("data_rejected", `DATA refused (${ready.code})`, {stage: "data", responseCode: ready.code, permanent: ready.code >= 500});
    // Dot-stuffing: a line consisting of "." alone would end the message early.
    const stuffed = String(raw)
      .split("\r\n")
      .map((line) => (line.startsWith(".") ? `.${line}` : line))
      .join("\r\n")
      .replace(/\r\n?$/, "");
    this.#socket.write(`${stuffed}\r\n.\r\n`);
    const reply = await this.#reply("data");
    if (reply.code !== 250) throw new SmtpError("message_rejected", `message rejected (${reply.code})`, {stage: "data", responseCode: reply.code, permanent: reply.code >= 500});
    return reply;
  }

  async quit() {
    try {
      this.#write("QUIT");
      await this.#reply("quit");
    } catch {
      // A server that drops the connection after accepting the message is not a delivery failure.
    } finally {
      this.close();
    }
  }

  close() {
    this.#closed = true;
    try {
      this.#socket.end();
    } catch {
      // already gone
    }
  }
}

/** Default connector: implicit TLS on 465, or plain TCP when `secure` is false (tests only). */
export function defaultConnector({host, port, secure, tlsOptions = {}, timeoutMs = DEFAULT_TIMEOUT_MS}) {
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(new SmtpError("connection_error", `cannot reach ${host}:${port} (${error.code ?? "error"})`, {stage: "connect"}));
    const socket = secure
      ? tls.connect({host, port, servername: tlsOptions.servername ?? host, ...tlsOptions}, () => resolve(socket))
      : net.connect({host, port}, () => resolve(socket));
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      reject(new SmtpError("timeout", `connection to ${host}:${port} timed out`, {stage: "connect"}));
    });
    socket.once("error", onError);
  });
}

/**
 * Deliver one message.
 *
 * @param {object} input
 * @param {object} input.message  result of buildMessage(): raw + envelope fields
 * @param {object} input.credentials `{user, pass}` — never logged, never returned
 * @param {Function} [input.connector] injectable for tests
 */
export async function deliver(input) {
  const {
    host, port = 465, secure = true, credentials, message,
    timeoutMs = DEFAULT_TIMEOUT_MS, tlsOptions = {}, connector = defaultConnector, clientHostname = "localhost",
  } = input ?? {};
  if (!message?.raw) throw new SmtpError("missing_message", "message.raw is required", {stage: "build"});
  if (!message.envelopeFrom) throw new SmtpError("missing_sender", "envelope sender is required", {stage: "build"});
  const recipients = Array.isArray(message.envelopeTo) ? message.envelopeTo : [];
  if (recipients.length === 0) throw new SmtpError("missing_recipient", "at least one recipient is required", {stage: "build"});

  const socket = await connector({host, port, secure, tlsOptions, timeoutMs});
  const client = new SmtpClient(socket, {timeoutMs});
  try {
    await client.greeting();
    await client.ehlo(clientHostname);
    await client.authLogin(credentials?.user, credentials?.pass);
    await client.mailFrom(message.envelopeFrom);
    const results = [];
    for (const address of recipients) results.push(await client.rcptTo(address));
    const accepted = results.filter((entry) => entry.accepted).map((entry) => entry.address);
    const rejected = results.filter((entry) => !entry.accepted).map((entry) => ({address: entry.address, code: entry.code}));
    if (accepted.length === 0) {
      throw new SmtpError("all_recipients_rejected", "every recipient was rejected", {stage: "rcpt", permanent: true});
    }
    const confirmation = await client.data(message.raw);
    await client.quit();
    return {ok: true, accepted, rejected, responseCode: confirmation.code, response: confirmation.text};
  } catch (error) {
    client.close();
    throw error;
  }
}
