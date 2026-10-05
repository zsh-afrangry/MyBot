// Fresh, never-reused message ids for acceptance scripts.
//
// Why this exists: the channel keeps a durable ingress dedup ledger (channel.sqlite `inbound`).
// An id that was already admitted is ignored on purpose. The acceptance scripts used to hardcode
// ids such as -1900100001, so once the original acceptance run consumed them, every later run hit
// the dedup guard and the script looked like a failure while actually doing nothing.
//
// A negative id keeps these synthetic events clearly distinguishable from real OneBot ids.
let seq = 0;

/** A message id guaranteed not to collide with a previous acceptance run. */
export function freshMessageId() {
  // Date.now() * 1000 stays well inside Number.MAX_SAFE_INTEGER, and the counter covers
  // multiple ids created within the same millisecond.
  return -(Date.now() * 1000 + (seq++ % 1000));
}
