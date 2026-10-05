// Resolve the pre-fusion (legacy OpenClaw) source tree for the one-shot migration scripts.
//
// Why there is no implicit default:
// The migration into /home/afrangry/.openclaw-fusion is COMPLETE and verified. These scripts
// bootstrap a *new* isolated runtime from the old one, so they only make sense when pointed at
// an explicit, known-good legacy tree. Defaulting to the live /home/afrangry/.openclaw would mean
// the new system still depends on the old directory surviving, which is exactly what we removed.
//
// To re-run any migration script, extract the archived legacy tree and point at it:
//
//   mkdir -p /tmp/legacy
//   zstd -dc /home/afrangry/kurumi-backups/2026-10-05-pre-consolidation/state/legacy-openclaw-full.tar.zst \
//     | tar -C /tmp/legacy -xf -
//   KURUMI_LEGACY_SOURCE=/tmp/legacy node scripts/fusion/prepare.mjs
//
// No secret value is ever printed by this module.
import fs from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';

export const STATE_DIR = '/home/afrangry/.openclaw-fusion';
export const REPO_ROOT = '/home/afrangry/kurumi-fusion';
export const LEGACY_ARCHIVE =
  '/home/afrangry/kurumi-backups/2026-10-05-pre-consolidation/state/legacy-openclaw-full.tar.zst';

/** Absolute path of the legacy tree to import from. Throws with recovery instructions when unset. */
export function legacySource() {
  const explicit = process.env.KURUMI_LEGACY_SOURCE;
  if (!explicit) {
    throw new Error(
      'KURUMI_LEGACY_SOURCE is not set.\n' +
        'This is a one-shot migration script and the migration is already complete, so there is no\n' +
        'implicit legacy path (the new system must not depend on /home/afrangry/.openclaw existing).\n' +
        'To re-run against the archived legacy tree:\n' +
        '  mkdir -p /tmp/legacy\n' +
        `  zstd -dc ${LEGACY_ARCHIVE} | tar -C /tmp/legacy -xf -\n` +
        '  KURUMI_LEGACY_SOURCE=/tmp/legacy node <script>'
    );
  }
  if (!fs.existsSync(explicit)) throw new Error(`KURUMI_LEGACY_SOURCE does not exist: ${explicit}`);
  return path.resolve(explicit);
}

/** Read the isolated runtime environment (already-migrated credentials). */
export function runtimeEnv(file = path.join(STATE_DIR, 'runtime-env.json')) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Read the isolated runtime config. */
export function runtimeConfig(file = path.join(STATE_DIR, 'openclaw.json')) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Parse a legacy `gateway.systemd.env`, reading it from the explicit legacy source. */
export function legacyEnv(name) {
  return parseEnv(fs.readFileSync(path.join(legacySource(), 'gateway.systemd.env'), 'utf8'))[name];
}

/**
 * Resolve a credential for a migration re-run.
 *
 * Preference order matters: the isolated runtime already holds every migrated credential, so a
 * re-run on this host never touches the legacy tree. Only a genuine first-run bootstrap (runtime
 * value absent) falls back to the explicit legacy source.
 */
export function credential(name, { env = runtimeEnv() } = {}) {
  const current = env[name];
  if (typeof current === 'string' && current.length > 0) return current;
  const legacy = legacyEnv(name);
  if (!legacy) throw new Error(`Credential ${name} unavailable in runtime env or legacy source`);
  return legacy;
}
