// Install the third-party OpenClaw plugins the fusion runtime loads, into a controlled location.
//
// Why a dedicated prefix instead of the legacy .openclaw/npm/projects cache:
//   - the legacy trees are archived and must not be a runtime dependency;
//   - the prefix has its own manifest + lockfile, so the exact plugin version AND its transitive
//     tree are declared and reproducible.
//
// The manifest and lockfile are versioned in the repository (config/plugins.package.json and
// config/plugins.package-lock.json), so a lost runtime directory can be rebuilt from Git alone.
// `npm ci` — not `npm install` — is used: it installs exactly the locked tree and refuses to drift
// when the lockfile and manifest disagree, which `npm install` would silently "fix" by re-resolving.
//
// Output: /home/afrangry/.openclaw-fusion/plugins/{package.json,package-lock.json,node_modules}
// Runtime config (openclaw.json plugins.load.paths) points at node_modules/<plugin>.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PLUGIN_PREFIX, PLUGINS } from './lib/plugins.mjs';
import { REPO_ROOT } from './lib/legacy-source.mjs';

const CANONICAL_MANIFEST = path.join(REPO_ROOT, 'config/plugins.package.json');
const CANONICAL_LOCK = path.join(REPO_ROOT, 'config/plugins.package-lock.json');

const manifest = {
  name: 'kurumi-fusion-plugins',
  version: '0.0.0',
  private: true,
  description:
    '受控的第三方 OpenClaw 插件安装位置。仓库中的 config/plugins.package.json 与 config/plugins.package-lock.json 是权威来源，本文件由 scripts/fusion/install-plugins.mjs 生成。运行态 openclaw.json 的 plugins.load.paths 指向这里的 node_modules。',
  dependencies: PLUGINS
};

// The versioned manifest must agree with the code-level pin table, otherwise the lockfile being
// installed would not describe what this script claims to install.
if (fs.existsSync(CANONICAL_MANIFEST)) {
  const canonical = JSON.parse(fs.readFileSync(CANONICAL_MANIFEST, 'utf8'));
  const a = JSON.stringify(canonical.dependencies ?? {});
  const b = JSON.stringify(PLUGINS);
  if (a !== b) {
    throw new Error(
      `config/plugins.package.json (${a}) disagrees with lib/plugins.mjs (${b}).\n` +
        'Update both, refresh the lockfile with `npm install --package-lock-only` in the prefix, and copy it back to config/.'
    );
  }
} else {
  fs.mkdirSync(path.dirname(CANONICAL_MANIFEST), { recursive: true });
  fs.writeFileSync(CANONICAL_MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`seeded ${CANONICAL_MANIFEST}`);
}
if (!fs.existsSync(CANONICAL_LOCK)) {
  throw new Error(
    `Missing ${CANONICAL_LOCK}. A lockfile is required for a reproducible install; generate it with\n` +
      '  cd ' + PLUGIN_PREFIX + ' && npm install --package-lock-only && cp package-lock.json ' + CANONICAL_LOCK
  );
}

fs.mkdirSync(PLUGIN_PREFIX, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(PLUGIN_PREFIX, 'package.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
fs.copyFileSync(CANONICAL_LOCK, path.join(PLUGIN_PREFIX, 'package-lock.json'));

const run = spawnSync('npm', ['ci', '--no-audit', '--no-fund'], {
  cwd: PLUGIN_PREFIX,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe']
});
if (run.status !== 0) {
  process.stderr.write(run.stdout ?? '');
  process.stderr.write(run.stderr ?? '');
  throw new Error(`npm ci failed in ${PLUGIN_PREFIX}`);
}

const installed = {};
for (const [name, expected] of Object.entries(PLUGINS)) {
  const pkg = path.join(PLUGIN_PREFIX, 'node_modules', name, 'package.json');
  if (!fs.existsSync(pkg)) throw new Error(`Plugin missing after install: ${name}`);
  const version = JSON.parse(fs.readFileSync(pkg, 'utf8')).version;
  if (version !== expected) throw new Error(`${name}: expected ${expected}, installed ${version}`);
  installed[name] = version;
}
console.log(JSON.stringify({ prefix: PLUGIN_PREFIX, installed, from: 'config/plugins.package-lock.json', mode: 'npm ci' }, null, 2));
