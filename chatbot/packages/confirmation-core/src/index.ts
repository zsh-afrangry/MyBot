// Public package API. Internal helpers stay private to their owning module.
export * from "./types.js";
export { CONFIRMATION_GATE_SCHEMA_SQL, ensureConfirmationGateSchema } from "./schema.js";
export { scopeFromToolContext, scopeFromInboundEvent } from "./scope.js";
export { parseConfirmationText, buildConfirmationInstruction } from "./protocol.js";
export * from "./store.js";
export { registerConfirmationBackend, confirmationBackendIds, recordRegisteredConfirmation } from './registry.js';
export type { ConfirmationBackend, ConfirmationBackendProvider, ConfirmationOutcome, ConfirmationDiagnostic } from './registry.js';
export * from "./public-id.js";
export { createNaturalConfirmationBackend, narrowNaturalConfirmationBackend } from './natural-store.js';
export { listNaturalConfirmations, confirmNaturalProposal, confirmNaturalProposals, MAX_CONFIRMATION_TARGETS, naturalConfirmationTextAllowed } from './natural-service.js';
export { freezeConfirmationFacts, prepareConfirmationPreview, recordConfirmationDelivery } from './presentation.js';
export { captureNaturalConfirmationRequest, clearNaturalConfirmationRequest } from './current-request.js';
