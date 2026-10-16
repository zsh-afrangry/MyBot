import {createAdapterRegistry} from '../../packages/domain-adapters/index.js';
import {defaultMailPolicy} from './policy.js';
import {MailStore} from './store.js';

// Persistent composition root: register additional implementations HERE so any other entry point
// (the acceptance script, or a future second transport) resolves the same IDs.
//
// The store method list is the full confirmation-backend surface as well as the draft surface,
// because the host's inbound router holds the store returned by openStore() and calls the two
// confirmation methods on it directly.
/**
 * @returns {import('../../packages/domain-adapters/index.js').AdapterRegistry<import('./contracts.js').Policy, import('./contracts.js').Store, import('./contracts.js').StoreOptions>}
 */
export function createMailRegistry() {
  const registry = createAdapterRegistry({domain: 'mail',
    policyMethods: ['normalizeDraft', 'normalizeSend', 'normalizeOutbox', 'assertRecipientsAllowed'],
    storeMethods: ['nowUtc', 'close', 'createDraft', 'getDraft', 'readAttachments', 'listDrafts', 'listAudit', 'consumeApproval',
      'markSent', 'markFailed', 'cancelDraft', 'listInboundConfirmationCandidates', 'recordInboundConfirmation'],
  });
  registry.registerPolicy('default', defaultMailPolicy);
  registry.registerStore('sqlite', options => new MailStore(options));
  return registry;
}
