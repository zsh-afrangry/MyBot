// Each plugin owns one registration. Shared historical tables do not imply
// shared ownership: both listing and recording must enforce the domain.
import { registerConfirmationBackend, narrowNaturalConfirmationBackend, type ConfirmationBackend, type ConfirmationProposalRow } from '@kurumi/confirmation-core';
type ServiceHost = {
    registerService(service: {
        id: string;
        start(): void;
        stop(): void;
    }): void;
};
export function registerDomainBackend(api: ServiceHost, provider: {
    id: string;
    domain: ConfirmationProposalRow['domain'];
    open(): ConfirmationBackend;
}): void {
    let unregister: (() => void) | undefined;
    api.registerService({
        id: `${provider.id}-confirmation-backend`,
        start() {
            if (unregister)
                return;
            unregister = registerConfirmationBackend({
                id: provider.id,
                open() {
                    const store = provider.open();
                    return {
                        ...(store.natural ? {natural: narrowNaturalConfirmationBackend(store.natural, provider.domain)} : {}),
                        listInboundConfirmationCandidates: event => store.listInboundConfirmationCandidates(event)
                            .filter(proposal => proposal.domain === provider.domain),
                        recordInboundConfirmation(event, id) {
                            if (!store.listInboundConfirmationCandidates(event)
                                .some(proposal => proposal.domain === provider.domain && proposal.proposalId === id))
                                return false;
                            return store.recordInboundConfirmation(event, id);
                        },
                        close: () => store.close(),
                    };
                },
            });
        },
        stop() { unregister?.(); unregister = undefined; },
    });
}
