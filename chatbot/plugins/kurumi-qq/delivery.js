// Public outward delivery interface of the QQ channel. Other plugins' composition entries
// import only this file, never kurumi-qq/src/*. Ledger, send limits and target checks stay inside. docs/21, docs/22.
import {sendDocument as uploadDocument} from './src/files.js';
import {sendPayload} from './src/transport.js';

// cfg is a getter so each send uses the current runtime config.
export function createQqDelivery(cfg) {
  return {
    sendDocument: ({to, documentId, key, signal}) => uploadDocument({cfg: cfg(), to, documentId, key, signal}),
    sendText: ({to, text, key, signal}) => sendPayload({cfg: cfg(), to, text, key, signal}),
  };
}
