// Shared QQ transport, document delivery and receipts. Contracts: docs/21, docs/22.
import {sendDocument as uploadDocument} from './files.js';
import {sendImage, sendPayload} from './transport.js';
import {recordImageFeedback} from './image-feedback.js';

export {account, CHANNEL, ownerAuthorized, ownerTarget, token} from './config.js';
export {
  MAX_WORKSPACE_FILE_BYTES,
  OWNER_WORKSPACE_FILE_TYPES,
  qqFileUrl,
  readDocumentDeliveries,
  sendDocument,
  stageAttachment,
  stagePdf,
  traceFile,
} from './files.js';
export {Ledger} from './ledger.js';
export {presentForQQ} from './presentation.js';
export {localImage, onebot, sendImage, sendPayload, sendSegments} from './transport.js';
export {IMAGE_TYPES, imageType, MAX_IMAGE_BYTES} from './image.js';
export {splitForQQ} from './vendor/md-to-plain.js';
export {findSticker, formatStickerList, loadStickerStore} from './vendor/sticker-lib.js';

// cfg is a getter so each send uses the current runtime config.
export function createQqDelivery(cfg) {
  return {
    sendDocument: ({to, documentId, key, signal}) => uploadDocument({cfg: cfg(), to, documentId, key, signal}),
    sendText: ({to, text, key, signal}) => sendPayload({cfg: cfg(), to, text, key, signal}),
    sendImage: options => sendImage({...options, cfg: cfg()}),
    recordImageFeedback: options => recordImageFeedback(cfg(), options),
  };
}
