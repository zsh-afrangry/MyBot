import fs from 'node:fs';
import path from 'node:path';
import {insideRoot} from '../../packages/scoped-lease/index.js';
import {fail} from './policy.js';

export const SYSTEM_REDLINE_PATHS = Object.freeze([
  '/boot',
  '/etc/shadow',
  '/etc/gshadow',
  '/etc/sudoers',
  '/etc/sudoers.d',
  '/proc',
  '/sys',
  '/dev',
  '/root',
]);

export const HOME_REDLINE_ENTRIES = Object.freeze([
  '.openclaw-fusion',
  '.openclaw',
  'kurumi-backups',
  'snowluma',
  '.ssh',
  '.gnupg',
  '.pki',
  '.aws',
  '.kube',
  '.config/knowledgemap',
  '.config/gh',
  '.config/git',
  '.config/QQ',
  '.config/google-chrome',
  '.config/google-chrome-beta',
  '.config/google-chrome-for-testing',
  '.config/google-chrome-unstable',
  '.config/google-chrome-headless',
  '.config/microsoft-edge',
  '.config/opera',
  '.config/vivaldi',
  '.config/clash',
  '.config/clash-verge',
  '.config/io.github.clash-verge-rev.clash-verge-rev',
  '.local/share/keyrings',
  '.local/share/kurumi-coding-pilot-20261029',
  '.local/share/kurumi-admin-web',
  '.local/share/kurumi-fusion',
  '.local/share/dsh-launcher-update-20261010',
  '.local/share/knowledgemap',
  '.local/share/opencode',
  '.xwechat',
  '.arkcli',
  '.claude',
  '.claude.json',
  '.claude.json.backup',
  '.copilot',
  '.gemini',
  '.opencode',
  '.cc-switch',
  '.ollama',
  '.vscode-server',
  '.antigravity-ide',
  '.antigravity-ide-server',
  '.codex',
  '.dsh',
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.bash_history',
  '.mysql_history',
  '.Xauthority',
  'kurumi-whitelist-acceptance',
]);

export const HOME_PROTECTED_READONLY_ENTRIES = Object.freeze([
  'miniconda3',
  'snap',
  'Applications',
  'kurumi-archive',
]);

const HOME_PROTECTED_READONLY_SET = new Set(HOME_PROTECTED_READONLY_ENTRIES);

const ALLOWED_ENV_EXAMPLES = /^\.env\.(?:example|sample|template)$/iu;
const ENV_REDLINE = /^\.env(?:\..+)?$/iu;
const SSH_KEY_REDLINE = /^(?:id_(?:rsa|dsa|ecdsa|ed25519|ecdsa_sk|ed25519_sk)|authorized_keys|known_hosts)$/iu;
const SECRET_EXACT_NAMES = new Set([
  'runtime-env.json',
  'paper-credentials.json',
  'assistant-token',
  'http-token',
  'ws-token',
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.bash_history',
  '.mysql_history',
  '.Xauthority',
]);
const SECRET_EXT_REDLINE = /\.(?:pem|p12|pfx|jks|keystore|kdbx)$/iu;

const TIER_PRIORITY = Object.freeze({T0: 1, T1: 2, T2: 3});

export function isRedlineFilename(filePath) {
  const base = path.basename(filePath);
  if (!base || base === '.' || base === '..') return false;
  if (ENV_REDLINE.test(base) && !ALLOWED_ENV_EXAMPLES.test(base)) return true;
  if (SSH_KEY_REDLINE.test(base)) return true;
  if (SECRET_EXACT_NAMES.has(base)) return true;
  if (SECRET_EXT_REDLINE.test(base)) return true;
  return false;
}

export function buildRedlineSet(cfg, stateRoot) {
  const raw = [...SYSTEM_REDLINE_PATHS, ...(cfg.t3Roots ?? [])];
  if (stateRoot) raw.push(stateRoot);
  if (cfg.homeDir) {
    for (const entry of HOME_REDLINE_ENTRIES) {
      raw.push(path.join(cfg.homeDir, entry));
    }
  }
  const set = new Set();
  for (const item of raw) {
    if (typeof item !== 'string' || !path.isAbsolute(item)) continue;
    const normalized = path.resolve(item);
    set.add(normalized);
    try {
      const lstat = fs.lstatSync(normalized);
      if (!lstat.isSymbolicLink()) {
        set.add(fs.realpathSync(normalized));
      }
    } catch { /* Non-existent redline entries remain blocked by logical path. */ }
  }
  return [...set].sort();
}

export function classifyNormalizedPath(normPath, cfg, redlineList) {
  for (const red of redlineList) {
    if (insideRoot(normPath, red)) {
      return {
        tier: 'T3',
        matchedRoot: red,
        label: '不可触碰红线',
        readOnly: true,
        allowLease: false,
      };
    }
  }
  if (isRedlineFilename(normPath)) {
    return {
      tier: 'T3',
      matchedRoot: normPath,
      label: '敏感凭据/密钥文件',
      readOnly: true,
      allowLease: false,
    };
  }

  const candidates = [];
  for (const [tier, roots] of [['T0', cfg.t0Roots], ['T1', cfg.t1Roots], ['T2', cfg.t2Roots]]) {
    for (const root of roots) {
      if (insideRoot(normPath, root.path)) {
        candidates.push({
          tier,
          matchedRoot: root.path,
          label: root.label,
          readOnly: root.readOnly === true,
          allowLease: root.allowLease === true,
        });
      }
    }
  }

  // Dotfiles/dotdirs and known toolchains/archives directly under homeDir never slip into writable T1.
  if (cfg.homeDir && insideRoot(normPath, cfg.homeDir) && normPath !== cfg.homeDir) {
    const relative = path.relative(cfg.homeDir, normPath);
    const firstSeg = relative.split(path.sep)[0];
    const isDotEntry = firstSeg.startsWith('.');
    const isProtectedSubtree = isDotEntry || HOME_PROTECTED_READONLY_SET.has(firstSeg);
    if (isProtectedSubtree) {
      const explicitNonT1 = candidates.some(
        c => (c.tier === 'T0' || c.tier === 'T2') && c.matchedRoot !== cfg.homeDir,
      );
      if (!explicitNonT1) {
        return {
          tier: 'T2',
          matchedRoot: cfg.homeDir,
          label: isDotEntry ? '主目录隐藏配置（默认只读保护）' : '主目录工具链/归档（默认只读保护）',
          readOnly: true,
          allowLease: false,
        };
      }
    }
  }

  if (candidates.length === 0) {
    return {
      tier: 'outside',
      matchedRoot: null,
      label: '未授权路径',
      readOnly: true,
      allowLease: false,
    };
  }

  candidates.sort((a, b) => {
    if (b.matchedRoot.length !== a.matchedRoot.length) {
      return b.matchedRoot.length - a.matchedRoot.length;
    }
    return TIER_PRIORITY[b.tier] - TIER_PRIORITY[a.tier];
  });
  return candidates[0];
}

export function isTierRootPath(canonicalPath, cfg) {
  if (canonicalPath === '/') return true;
  if (cfg.homeDir && canonicalPath === cfg.homeDir) return true;
  for (const roots of [cfg.t0Roots, cfg.t1Roots, cfg.t2Roots]) {
    if (roots.some(root => root.path === canonicalPath)) return true;
  }
  return false;
}

export function assertNotTierRoot(canonicalPath, cfg) {
  if (isTierRootPath(canonicalPath, cfg)) fail('files_tier_root_protected');
}

export function isInsideRedlineTree(dirPath, redlineList) {
  return redlineList.some(red => insideRoot(red, dirPath) || insideRoot(dirPath, red));
}

function classifyChecked(normPath, cfg, redlineList) {
  const info = classifyNormalizedPath(normPath, cfg, redlineList);
  if (info.tier === 'T3') fail('files_redline_denied');
  if (info.tier === 'outside') fail('files_path_outside_policy');
  return info;
}

function checkNoSymlinksUnderRoot(logical, matchedRoot, cfg, redlineList) {
  let rootLstat;
  try {
    rootLstat = fs.lstatSync(matchedRoot);
  } catch (error) {
    if (error.code === 'ENOENT') fail('files_root_unavailable');
    throw error;
  }
  if (rootLstat.isSymbolicLink() || !rootLstat.isDirectory()) fail('files_symlink_not_allowed');
  if (fs.realpathSync(matchedRoot) !== matchedRoot) fail('files_symlink_not_allowed');

  const rel = path.relative(matchedRoot, logical);
  const parts = rel ? rel.split(path.sep).filter(Boolean) : [];
  let cursor = matchedRoot;
  let lastExisting = matchedRoot;
  let lastLstat = rootLstat;

  for (const part of parts) {
    cursor = path.join(cursor, part);
    let lst;
    try {
      lst = fs.lstatSync(cursor);
    } catch (error) {
      if (error.code === 'ENOENT') break;
      throw error;
    }
    if (lst.isSymbolicLink()) fail('files_symlink_not_allowed');
    lastExisting = cursor;
    lastLstat = lst;
  }

  const realLast = fs.realpathSync(lastExisting);
  if (realLast !== lastExisting) fail('files_symlink_not_allowed');
  classifyChecked(realLast, cfg, redlineList);
  return {exists: lastExisting === logical, lstat: lastExisting === logical ? lastLstat : null};
}

export function resolveSafePath(rawPath, cfg, redlineList, {forWrite = false, allowRootItself = true} = {}) {
  if (typeof rawPath !== 'string' || !rawPath || rawPath.length > 4096 || /[\x00-\x1f\x7f]/u.test(rawPath)) {
    fail('invalid_files_path');
  }
  if (!path.isAbsolute(rawPath)) fail('invalid_files_path');

  const logical = path.resolve(rawPath);
  const logicalInfo = classifyChecked(logical, cfg, redlineList);
  if (!allowRootItself) assertNotTierRoot(logical, cfg);

  if (forWrite) {
    const {exists, lstat} = checkNoSymlinksUnderRoot(logical, logicalInfo.matchedRoot, cfg, redlineList);
    return {
      path: logical,
      canonicalPath: logical,
      exists,
      lstat,
      ...logicalInfo,
    };
  }

  let lstat = null;
  try {
    lstat = fs.lstatSync(logical);
  } catch (error) {
    if (error.code === 'ENOENT') {
      // Also guard against symlinks along existing ancestors pointing into redlines.
      checkAncestorsOnRead(logical, redlineList, cfg);
      return {
        path: logical,
        canonicalPath: logical,
        exists: false,
        lstat: null,
        ...logicalInfo,
      };
    }
    throw error;
  }

  const real = fs.realpathSync(logical);
  const realInfo = classifyChecked(real, cfg, redlineList);
  if (!allowRootItself) assertNotTierRoot(real, cfg);
  const chosen = TIER_PRIORITY[realInfo.tier] > TIER_PRIORITY[logicalInfo.tier]
    || (realInfo.tier === logicalInfo.tier && realInfo.readOnly && !logicalInfo.readOnly)
    ? realInfo
    : logicalInfo;

  return {
    path: logical,
    canonicalPath: real,
    exists: true,
    lstat,
    ...chosen,
  };
}

function checkAncestorsOnRead(logical, redlineList, cfg) {
  let cursor = path.dirname(logical);
  while (cursor && cursor !== '/') {
    try {
      const real = fs.realpathSync(cursor);
      classifyChecked(real, cfg, redlineList);
      return;
    } catch (error) {
      if (error instanceof Error && error.code === 'ENOENT') {
        cursor = path.dirname(cursor);
        continue;
      }
      throw error;
    }
  }
}

export function canApplyLeaseToTierInfo(tierInfo) {
  if (!tierInfo || tierInfo.tier === 'T3' || tierInfo.tier === 'outside') return false;
  if (tierInfo.readOnly) return false;
  if (tierInfo.tier === 'T2') return tierInfo.allowLease === true;
  return true;
}
