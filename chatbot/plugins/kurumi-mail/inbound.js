// Trusted inbound for kurumi-mail: who is speaking, and in what conversation.
//
// Transport trust only. No language rules, no allowlist decisions and no confirmation protocol live
// here — those are policy and shared-core concerns. The split matters because a replacement policy
// must never be able to mint owner identity, so identity is established before any policy runs.
import { authorizedOwner as ownerAuthorized } from "../../packages/access-control/index.js";
import { scopeFromToolContext } from "@kurumi/confirmation-core";

/**
 * Assert the caller is the owner in a private kurumi-qq conversation.
 *
 * `ownerAuthorized` is a four-part check against trusted channel metadata, and the session key must
 * be the `direct:` conversation — so a group chat or a second party can never satisfy it, whatever
 * the message body claims.
 *
 * @returns the resolved runtime config, so callers do not re-resolve it differently.
 */
export function assertOwnerContext(ctx, config) {
  const resolved = ctx?.getRuntimeConfig?.() ?? config;
  if (!ownerAuthorized(ctx, resolved)) {
    const error = new Error("Mail tools are available in the owner's private chat only");
    error.code = "unauthorized_owner_context";
    throw error;
  }
  return resolved;
}

/** The owner-bound scope a confirmation proposal and its grant are bound to. */
export function requireConfirmationScope(ctx) {
  const scope = scopeFromToolContext(ctx);
  if (!scope) {
    const error = new Error("Mail confirmation requires a trusted owner private-chat context");
    error.code = "untrusted_confirmation_context";
    throw error;
  }
  return scope;
}
