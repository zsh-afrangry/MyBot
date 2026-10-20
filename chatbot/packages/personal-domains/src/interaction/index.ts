// Presentation/turn policy only. These hooks never issue or consume a grant.
import { registerClarificationGate } from './clarification-gate.js';
import { registerControlledReplies } from './controlled-replies.js';
export function registerInteractionHooks(api: unknown, options: {
    clarificationTools?: readonly string[];
    proposalTools?: readonly string[];
}) {
    if (options.clarificationTools?.length)
        registerClarificationGate(api, new Set(options.clarificationTools));
    if (options.proposalTools?.length)
        registerControlledReplies(api, new Set(options.proposalTools));
}
