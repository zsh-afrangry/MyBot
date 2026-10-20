// Explicit v1 -> v2 migration with private rollback materials. Never runs in tool discovery.
import fs from 'node:fs';
import path from 'node:path';
import {readLegacyMemory} from '../store.js';
import {canonical, digest, emptyState, MEMORY_NOTICE} from './model.js';
import {memoryPaths, initializeContinuity, replaceNotice, openContinuityStore} from './store.js';
export function migrateMemory({workspace, ownerId, backupRoot, apply = false}) {
  if (!/^\d{5,12}$/.test(ownerId)) throw Error('Explicit primary owner required');
  const paths = memoryPaths(workspace), exists = fs.existsSync(paths.notice), original = exists ? fs.readFileSync(paths.notice) : Buffer.alloc(0);
  if (original.toString('utf8') === MEMORY_NOTICE) {
    const store = openContinuityStore({workspace, ownerId, readonly: true});
    try {const data = store.read(); return {ok: true, alreadyMigrated: true, revision: data.revision, facts: data.facts.length};} finally {store.close();}
  }
  const legacy = readLegacyMemory(workspace), sha256 = digest(original), data = emptyState(ownerId, legacy.revision), stamp = new Date().toISOString();
  data.importedFrom = {sha256, revision: legacy.revision, entries: legacy.entries.length};
  data.facts = legacy.entries.map(entry => ({id: entry.id, text: entry.text, kind: 'fact', createdAt: entry.updatedAt ?? stamp, updatedAt: entry.updatedAt ?? stamp,
    source: {origin: 'legacy_explicit', messageId: 'legacy:' + entry.id, runId: 'legacy-import', sessionId: 'legacy-import',
      sessionKey: `agent:main:kurumi-qq:direct:${ownerId}`, at: entry.updatedAt ?? stamp, rawHash: digest(entry.text), evidence: entry.text}}));
  const result = {ok: true, alreadyMigrated: false, applied: apply, originalSha256: sha256, revision: legacy.revision, facts: data.facts.length};
  if (!apply) return result;
  if (!path.isAbsolute(backupRoot) || fs.realpathSync(backupRoot) !== path.resolve(backupRoot) || fs.lstatSync(backupRoot).isSymbolicLink()) throw Error('Private absolute backup root required');
  const backup = path.join(backupRoot, 'before-memory-p2-' + stamp.replace(/[:.]/g, '-'));
  fs.mkdirSync(backup, {mode: 0o700});
  if (exists) fs.writeFileSync(path.join(backup, 'MEMORY.md'), original, {mode: 0o600, flag: 'wx'});
  fs.writeFileSync(path.join(backup, 'migration.json'), JSON.stringify({version: 1, ...result, ownerId, originalExisted: exists}), {mode: 0o600, flag: 'wx'});
  if (fs.existsSync(paths.file)) {
    const store = openContinuityStore({workspace, ownerId, requireNotice: false, readonly: true});
    try {
      const pending = store.read();
      if (canonical(pending.importedFrom) !== canonical(data.importedFrom) || pending.revision !== data.revision || pending.generation !== 0
        || pending.summaries.length || pending.receipts.length || pending.barriers.length
        || canonical(pending.facts.map(e=>({id:e.id,text:e.text,kind:e.kind,origin:e.source.origin})))
          !== canonical(data.facts.map(e=>({id:e.id,text:e.text,kind:e.kind,origin:e.source.origin})))) throw Error('An unrelated memory database exists; refusing to overwrite');
    } finally {store.close();}
  } else initializeContinuity(workspace, data);
  replaceNotice(workspace);
  return {...result, backup};
}
