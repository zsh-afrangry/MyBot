import { parseConfirmationText, scopeFromInboundEvent, type ConfirmationInboundEvent, type ConfirmationProposalRow } from "./gate.js";

/** Business storage stays with its domain, including grant/commit transactions. */
export interface ConfirmationBackend {
  listInboundConfirmationCandidates(event: ConfirmationInboundEvent): ConfirmationProposalRow[];
  recordInboundConfirmation(event: ConfirmationInboundEvent, expectedProposalId: string): boolean;
  close(): void;
}
export interface ConfirmationBackendProvider {
  id: string;
  open(): ConfirmationBackend;
}

// Host plugin loaders may evaluate different copies of this package. A versioned
// process-local symbol shares registrations without coupling plugins by imports.
const key = Symbol.for("kurumi.confirmation.backends.v1");
const host = globalThis as typeof globalThis & { [key]?: Map<string, ConfirmationBackendProvider> };
function registry(): Map<string, ConfirmationBackendProvider> {
  return host[key] ??= new Map();
}
export function registerConfirmationBackend(provider: ConfirmationBackendProvider): () => void {
  if (registry().has(provider.id)) throw new Error(`Confirmation backend already registered: ${provider.id}`);
  registry().set(provider.id, provider);
  return () => { if (registry().get(provider.id) === provider) registry().delete(provider.id); };
}
export function confirmationBackendIds(): string[] { return [...registry().keys()].sort(); }

export type ConfirmationOutcome = "ignored" | "no_backends" | "no_match" | "ambiguous" | "recorded" | "rejected" | "storage_error";
export type ConfirmationDiagnostic = { outcome: ConfirmationOutcome; backend?: string };

/** Synchronous, fail-closed routing before model execution; never claims a reply. */
export function recordRegisteredConfirmation(
  event: ConfirmationInboundEvent,
  report: (diagnostic: ConfirmationDiagnostic) => void,
  providers: readonly ConfirmationBackendProvider[] = [...registry().values()],
): ConfirmationOutcome {
  if (!event.messageId || !["qqbot", "kurumi-qq"].includes(event.channel) || event.isGroup || event.replyToIsQuote
    || !scopeFromInboundEvent(event) || !parseConfirmationText(event.content)) return "ignored";
  const opened: ConfirmationBackend[] = [];
  let diagnostic: ConfirmationDiagnostic = { outcome: "no_match" };
  try {
    if (providers.length === 0) diagnostic = { outcome: "no_backends" };
    else {
      const candidates: Array<{ backend: ConfirmationBackend; id: string; proposal: ConfirmationProposalRow }> = [];
      for (const provider of providers) {
        const backend = provider.open();
        opened.push(backend);
        for (const proposal of backend.listInboundConfirmationCandidates(event)) candidates.push({ backend, id: provider.id, proposal });
      }
      // Do not deduplicate matching IDs across stores: duplicate ownership is ambiguous.
      if (candidates.length > 1) diagnostic = { outcome: "ambiguous" };
      const only = candidates.length === 1 ? candidates[0] : undefined;
      if (only) diagnostic = {
        outcome: only.backend.recordInboundConfirmation(event, only.proposal.proposalId) ? "recorded" : "rejected",
        backend: only.id,
      };
    }
  } catch {
    // Do not log exception text: it may contain paths, SQL, or personal data.
    diagnostic = { outcome: "storage_error" };
  } finally {
    for (const backend of opened.reverse()) {
      try { backend.close(); } catch { diagnostic = { outcome: "storage_error" }; }
    }
  }
  report(diagnostic);
  return diagnostic.outcome;
}
