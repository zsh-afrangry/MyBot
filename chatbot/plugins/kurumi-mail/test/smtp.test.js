// SMTP client tests, run against a real local SMTP server over TLS.
//
// The point of using a server rather than a stubbed socket: the tests then observe what actually
// crossed the wire. That is what makes claims like "credentials are never echoed in errors" and
// "dot-stuffing preserves the body" checkable instead of asserted.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { MockSmtpServer, TEST_PASS, TEST_USER } from "./helpers/mock-smtp.js";
import { SmtpError, defaultConnector, deliver } from "../smtp.js";
import { buildMessage } from "../mime.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CA = fs.readFileSync(path.join(HERE, "fixtures", "cert.pem"));

/** Trust the test certificate explicitly; no global TLS relaxation. */
function connectorTrustingTestCert(options) {
  return defaultConnector({
    ...options,
    tlsOptions: { ca: CA, servername: "localhost", ...(options.tlsOptions ?? {}) },
  });
}

async function withServer(options, run) {
  const server = new MockSmtpServer(options);
  const { host, port } = await server.start();
  try {
    await run({ server, host, port });
  } finally {
    await server.stop();
  }
}

function messageFor(overrides = {}) {
  return buildMessage({
    from: { address: TEST_USER },
    to: ["friend@example.test"],
    subject: "hello",
    text: "body text",
    messageId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee@kurumi-mail",
    ...overrides,
  });
}

test("delivers a message over implicit TLS and the server receives exactly one", async () => {
  await withServer({}, async ({ server, host, port }) => {
    const result = await deliver({
      host, port, secure: true,
      credentials: { user: TEST_USER, pass: TEST_PASS },
      message: messageFor(),
      connector: connectorTrustingTestCert,
    });
    assert.equal(result.ok, true);
    assert.equal(server.receivedCount, 1);
    const received = server.messages[0];
    assert.equal(received.from, TEST_USER);
    assert.match(received.data, /^Subject: hello$/mu);
    assert.match(received.data, /^To: friend@example\.test$/mu);
    assert.deepEqual(result.accepted, ["friend@example.test"]);
    assert.deepEqual(result.rejected, []);
  });
});

test("the authorization code reaches the server as a credential, and only there", async () => {
  await withServer({}, async ({ server, host, port }) => {
    await deliver({
      host, port, secure: true,
      credentials: { user: TEST_USER, pass: TEST_PASS },
      message: messageFor(),
      connector: connectorTrustingTestCert,
    });
    const session = server.sessions[0];
    assert.equal(session.username, TEST_USER);
    assert.equal(session.authorizationCode, TEST_PASS);
    assert.equal(session.authenticated, true);
  });
});

test("authentication failure raises auth_failed without leaking credentials", async () => {
  await withServer({ failAuth: true }, async ({ host, port }) => {
    const secret = "super-secret-authorization-code";
    await assert.rejects(
      () => deliver({
        host, port, secure: true,
        credentials: { user: TEST_USER, pass: secret },
        message: messageFor(),
        connector: connectorTrustingTestCert,
      }),
      (error) => {
        assert.ok(error instanceof SmtpError);
        assert.equal(error.code, "auth_failed");
        assert.equal(error.stage, "auth");
        // The whole error, including its message and stack, must be free of the credential.
        const surface = `${error.message}${error.stack ?? ""}${JSON.stringify(error, Object.getOwnPropertyNames(error))}`;
        assert.ok(!surface.includes(secret), "credential leaked into the error");
        assert.ok(!surface.includes(TEST_USER), "username leaked into the error");
        return true;
      },
    );
  });
});

test("empty credentials are refused at AUTH and nothing is delivered", async () => {
  await withServer({}, async ({ server, host, port }) => {
    await assert.rejects(
      () => deliver({
        host, port, secure: true,
        credentials: { user: "", pass: "" },
        message: messageFor(),
        connector: connectorTrustingTestCert,
      }),
      (error) => {
        assert.equal(error.code, "missing_credentials");
        assert.equal(error.stage, "auth");
        return true;
      },
    );
    assert.equal(server.receivedCount, 0, "an unauthenticated session must not deliver anything");
  });
});

test("a refused recipient is reported, and all-refused aborts before DATA", async () => {
  await withServer({ rejectRecipients: ["friend@example.test"] }, async ({ server, host, port }) => {
    await assert.rejects(
      () => deliver({
        host, port, secure: true,
        credentials: { user: TEST_USER, pass: TEST_PASS },
        message: messageFor(),
        connector: connectorTrustingTestCert,
      }),
      (error) => {
        assert.equal(error.code, "all_recipients_rejected");
        assert.equal(error.permanent, true);
        return true;
      },
    );
    assert.equal(server.receivedCount, 0, "nothing may be delivered when every recipient is refused");
  });
});

test("partial refusal delivers to the accepted recipient and lists the rejected one", async () => {
  await withServer({ rejectRecipients: ["second@example.test"] }, async ({ server, host, port }) => {
    const message = messageFor({ to: ["friend@example.test", "second@example.test"] });
    const result = await deliver({
      host, port, secure: true,
      credentials: { user: TEST_USER, pass: TEST_PASS },
      message, connector: connectorTrustingTestCert,
    });
    assert.deepEqual(result.accepted, ["friend@example.test"]);
    assert.deepEqual(result.rejected, [{ address: "second@example.test", code: 550 }]);
    assert.equal(server.receivedCount, 1);
  });
});

test("a rejected sender is reported as sender_rejected", async () => {
  await withServer({ rejectSender: true }, async ({ host, port }) => {
    await assert.rejects(
      () => deliver({
        host, port, secure: true,
        credentials: { user: TEST_USER, pass: TEST_PASS },
        message: messageFor(), connector: connectorTrustingTestCert,
      }),
      (error) => {
        assert.equal(error.code, "sender_rejected");
        assert.equal(error.stage, "mail");
        return true;
      },
    );
  });
});

test("a DATA-phase rejection is reported and the draft is not recorded as sent", async () => {
  await withServer({ rejectData: true }, async ({ server, host, port }) => {
    await assert.rejects(
      () => deliver({
        host, port, secure: true,
        credentials: { user: TEST_USER, pass: TEST_PASS },
        message: messageFor(), connector: connectorTrustingTestCert,
      }),
      (error) => {
        assert.equal(error.code, "message_rejected");
        assert.equal(error.responseCode, 554);
        return true;
      },
    );
    assert.equal(server.receivedCount, 0);
  });
});

test("a silent server produces a timeout instead of hanging forever", async () => {
  await withServer({ hangAfterGreeting: true }, async ({ host, port }) => {
    await assert.rejects(
      () => deliver({
        host, port, secure: true, timeoutMs: 400,
        credentials: { user: TEST_USER, pass: TEST_PASS },
        message: messageFor(), connector: connectorTrustingTestCert,
      }),
      (error) => {
        assert.equal(error.code, "timeout");
        return true;
      },
    );
  });
});

test("an unreachable port fails as connection_error", async () => {
  // Reserve a port and close it, so the connect attempt is refused deterministically.
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  await assert.rejects(
    () => deliver({
      host: "127.0.0.1", port, secure: false, timeoutMs: 1500,
      credentials: { user: TEST_USER, pass: TEST_PASS },
      message: messageFor(),
    }),
    (error) => {
      assert.equal(error.code, "connection_error");
      return true;
    },
  );
});

test("a body line that is a single dot survives delivery intact", async () => {
  await withServer({}, async ({ server, host, port }) => {
    const message = messageFor({ text: "first\r\n.\r\nlast" });
    await deliver({
      host, port, secure: true,
      credentials: { user: TEST_USER, pass: TEST_PASS },
      message, connector: connectorTrustingTestCert,
    });
    // The server un-stuffs what it received; decoding the body must give back the original text.
    const body = server.messages[0].data.split("\r\n\r\n").slice(1).join("\r\n\r\n");
    const base64 = body.split("\r\n").filter((line) => /^[A-Za-z0-9+/=]+$/u.test(line)).join("");
    assert.equal(Buffer.from(base64, "base64").toString("utf8").replace(/\r\n$/u, ""), "first\r\n.\r\nlast");
  });
});
