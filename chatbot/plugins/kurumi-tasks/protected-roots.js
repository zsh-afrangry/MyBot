// Single source of truth for "roots a background worker must never own".
//
// Why this is a separate module: the rule is enforced in two places that must not drift —
//   1. the runtime, when it loads the operator-owned project registry (projects.js);
//   2. the operator CLI that maintains that registry (scripts/fusion/register-project.mjs).
// Before this module existed the CLI had its own copy of the list, and that copy missed
// /home/afrangry/kurumi-archive, so an archived legacy tree could be registered as a worker
// workspace (found by the 2026-10-10 second re-verification, V01).
//
// The list protects preserved originals, recovery material, the pinned SDK, the live source tree
// and the isolated runtime state. Extend at runtime with KURUMI_PROTECTED_ROOTS (colon-separated).
import path from 'node:path';

export const RUNTIME_STATE = '/home/afrangry/.openclaw-fusion';

export const PROTECTED_ROOTS = [
  '/home/afrangry/.openclaw',        // legacy original path (may reappear during a rollback)
  '/home/afrangry/kurumi-archive',   // archived legacy trees and unit originals: never a workspace
  '/home/afrangry/kurumi-backups',   // recovery points: a worker must never rewrite them
  '/home/afrangry/kurumi-baselines', // legacy rollback snapshots
  '/home/afrangry/snowluma',         // retained transport component
  '/home/afrangry/桌面/qq-bridge',    // bridge original
  '/home/afrangry/.npm-global',      // pinned OpenClaw SDK installation
  '/home/afrangry/kurumi-fusion',    // live source tree (workers use their own copy)
];

/** Extra roots from the environment, for operators who need to extend the list at runtime. */
export function protectedRoots(env = process.env) {
  return [...PROTECTED_ROOTS, ...(env.KURUMI_PROTECTED_ROOTS ?? '').split(':').filter(Boolean)];
}

/**
 * Throw when `root` may not be a background worker workspace. Shared by the runtime and the CLI so
 * both reject exactly the same set. `root` is expected to be canonical (the callers check that).
 */
export function assertNotProtectedRoot(root, env = process.env) {
  for (const original of protectedRoots(env)) {
    if (root === original || root.startsWith(`${original}/`)) {
      throw new Error('Preserved original cannot be a project worker root');
    }
  }
  // The isolated runtime is protected too, except the worker workspaces under projects/.
  if ((root === RUNTIME_STATE || root.startsWith(`${RUNTIME_STATE}/`)) && !root.startsWith(`${RUNTIME_STATE}/projects/`)) {
    throw new Error('Fusion runtime state cannot be a project worker root');
  }
}

/** The directory the registry lives in, and the registry file itself. */
export function registryPaths(stateDir = RUNTIME_STATE) {
  return {dir: stateDir, file: path.join(stateDir, 'projects.json')};
}
