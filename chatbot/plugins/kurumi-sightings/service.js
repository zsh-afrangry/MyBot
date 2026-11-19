import {listOptions, publicPage, sightingId, SightingsError} from './policy.js';

export function createSightingsService({store, now = Date.now}) {
  return {
    list(args) {
      const {date,timeZone,limit,offset} = listOptions(args, now());
      const result = store.list({date,limit,offset});
      if (result === null) return {status:'unavailable', reason:'source_not_connected', date, timeZone};
      return {status:'ok', date, timeZone, ...result};
    },
    withdraw(id) {
      if (typeof id !== 'string' || !sightingId.test(id)) throw new SightingsError('invalid_query');
      return store.withdraw(id, now()) ?? {status:'not_found'};
    },
  };
}

// This is an integration point for trusted adapters, not an RPC or a tool. The
// read envelope's origin/status must come from the host, never the page or model.
// No selected URL, query, history or private conversation data is passed in.
export function createSightingsCollector({read, store, now = Date.now}) {
  if (typeof read !== 'function') throw new SightingsError('source_not_connected');
  return async ({signal} = {}) => {
    signal?.throwIfAborted();
    const result = await read({signal});
    signal?.throwIfAborted();
    if (result?.origin !== 'independent-public') return {status:'ignored', reason:'not_independent'};
    if (result.status !== 'read') return {status:'ignored', reason:'not_read'};
    return store.record(publicPage(result.page), now());
  };
}
