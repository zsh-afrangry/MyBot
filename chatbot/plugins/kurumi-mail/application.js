// Composition entry for kurumi-mail.
//
// Resolves one policy and one store from the registry and hands the selected interfaces to the
// service. Nothing here imports a concrete store: the confirmation backend, the tools and the
// acceptance script all receive `openStore` from this object, so replacing the store is a matter of
// registering another implementation rather than editing callers.
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createMailRegistry } from "./adapters.js";
import { createMailService } from "./service.js";

/** Environment keys, expanded from runtime-env.json by run-gateway.mjs. */
export const ENV_USER = "KURUMI_MAIL_USER";
export const ENV_AUTH_CODE = "KURUMI_MAIL_AUTH_CODE";
export const ENV_HOST = "KURUMI_MAIL_HOST";
export const ENV_PORT = "KURUMI_MAIL_PORT";
const DEFAULT_HOST = "smtp.qq.com";
const DEFAULT_PORT = 465;

export function openClawStateDirectory(env = process.env) {
  return env.OPENCLAW_STATE_DIR?.trim() ? resolve(env.OPENCLAW_STATE_DIR) : join(homedir(), ".openclaw-fusion");
}

export function mailStateDirectory(env = process.env) {
  return join(openClawStateDirectory(env), "state", "kurumi-mail");
}

/** Read configuration without ever exposing the authorization code. */
export function readMailConfig(env = process.env) {
  const user = env[ENV_USER]?.trim() ?? "";
  const authCode = env[ENV_AUTH_CODE]?.trim() ?? "";
  const host = env[ENV_HOST]?.trim() || DEFAULT_HOST;
  const parsedPort = Number(env[ENV_PORT] ?? DEFAULT_PORT);
  const port = Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort < 65_536 ? parsedPort : DEFAULT_PORT;
  return { user, authCode, host, port, configured: Boolean(user && authCode) };
}

export function createMailApplication({ policyAdapter = "default", storeAdapter = "sqlite", registry = createMailRegistry(), resolveAttachment } = {}) {
  const selected = registry.resolve({ policy: policyAdapter, store: storeAdapter });
  return Object.freeze({ ...selected, directives: createMailService(selected.policy, {resolveAttachment}) });
}

// Explicit default composition for offline callers (tests, the acceptance script). It is the same
// wiring the plugin uses, not a second implementation.
export const mailDirectives = createMailApplication().directives;
