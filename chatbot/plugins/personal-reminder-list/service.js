// The only reminder-list mutation entry used by tools and acceptance runners.
// Keep policy checks and transactional execution explicit, rather than hiding
// language rules inside a storage method.
import {createHash} from 'node:crypto';
import {validateCommand, validateScheduleCommand, prepareAddedItem, prepareItemChange} from './model.js';
import {checkPermit, checkTextSource, checkScheduleSource, checkItemFacts, checkTargetSource, listRequestKey, checkRequestReplay} from './policy.js';

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])]));
  return value;
}

export function manageList(store, args, permit, context = {}) {
  validateCommand(args);
  checkPermit(permit, args.action, store.now());
  store.expire();
  const payloadHash = createHash('sha256').update(JSON.stringify(stable(args))).digest('hex');
  const key = listRequestKey(permit), auditContext = {messageId: permit.messageId, sessionKey: permit.sessionKey, ...context};
  return store.transaction(() => {
    const previous = store.request(key);
    if (previous) {
      checkRequestReplay(previous.payload_hash, payloadHash);
      return {...JSON.parse(previous.result_json), idempotent: true};
    }
    let result;
    if (['schedule', 'pause', 'resume'].includes(args.action)) {
      validateScheduleCommand(args);
      if (args.action === 'schedule') checkScheduleSource(permit);
      result = store.changeSchedule(args, auditContext);
    } else if (args.action === 'add') {
      const fields = prepareAddedItem(args, store.now());
      for (const field of ['title', 'content', 'note']) checkTextSource(fields[field], permit);
      checkItemFacts(fields, permit);
      result = store.addItem(fields, auditContext);
    } else if (['update', 'complete', 'void', 'reopen'].includes(args.action)) {
      if ('times' in args) throw Error('Invalid item parameters');
      const row = store.select(args);
      if (row.ok === false) return row;
      checkTargetSource(args, row, permit);
      const fields = prepareItemChange(args, row, store.now());
      if (args.action === 'update' || args.action === 'reopen') {
        for (const field of ['title', 'content', 'note']) if (field in args) checkTextSource(fields[field], permit);
        checkItemFacts(fields, permit, 'ddl' in args);
      }
      result = store.changeItem(args, row, fields, auditContext);
    } else throw Error('Unsupported list action');
    store.recordRequest(key, payloadHash, result);
    return result;
  });
}
