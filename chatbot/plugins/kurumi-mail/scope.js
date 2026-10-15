// Re-exported confirmation helpers.
//
// The plugin owns the dependency on @kurumi/confirmation-core (declared in its package.json and
// linked under its own node_modules). Acceptance scripts live outside that tree, so they import the
// helpers through this module instead of hard-coding a node_modules path.
export {
  buildConfirmationInstruction,
  confirmationBackendIds,
  scopeFromInboundEvent,
  scopeFromToolContext,
} from "@kurumi/confirmation-core";
