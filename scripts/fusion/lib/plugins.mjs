// Declared third-party plugin set for the fusion runtime. Pure data: importing this module
// performs no I/O, so both the installer and the verifier can share one source of truth.
import path from 'node:path';
import { STATE_DIR } from './legacy-source.mjs';

/** Controlled install prefix (its own package.json + package-lock.json live here). */
export const PLUGIN_PREFIX = path.join(STATE_DIR, 'plugins');

/** Pinned third-party plugins. Bump deliberately and re-run acceptance afterwards. */
export const PLUGINS = {
  '@openclaw/tavily-plugin': '2026.9.7'
};
