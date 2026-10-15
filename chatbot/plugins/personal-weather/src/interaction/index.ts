// Presentation/turn policy only. These hooks never issue or consume a grant.
import {registerClarificationGate} from './clarification-gate.js';
import {registerControlledReplies} from './controlled-replies.js';

export function registerInteractionHooks(api: unknown) {
  registerClarificationGate(api, new Set(['personal_profile_change_propose']));
  registerControlledReplies(api, new Set([
    'personal_profile_change_propose', 'personal_planning_change_propose',
    'personal_reminder_propose', 'personal_reminder_change_propose', 'personal_reminder_cancel_propose',
  ]));
}
