// Install the third-party OpenClaw plugins the fusion runtime loads, into a controlled location.
//
// Why a dedicated prefix instead of the legacy .openclaw/npm/projects cache:
//   - the legacy tree is archived and must not be a runtime dependency;
//   - this prefix has its own package.json + package-lock.json, so the exact plugin version is
//     declared and reproducible instead of being whatever happened to be in a cache directory.
//
// Output: /home/afrangry/.openclaw-fusion/plugins/{package.json,package-lock.json,node_modules}
// Runtime config (openclaw.json plugins.load.paths) points at node_modules/<plugin>.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PLUGIN_PREFIX, PLUGINS } from './lib/plugins.mjs';

const manifest = {
  name: 'kurumi-fusion-plugins',
  version: '0.0.0',
  private: true,
  description:
    '受控的第三方 OpenClaw 插件安装位置。由 kurumi-fusion/scripts/fusion/install-plugins.mjs 生成，不要手工编辑。运行态 openclaw.json 的 plugins.load.paths 指向这里的 node_modules。',
  dependencies: PLUGINS
};

fs.mkdirSync(PLUGIN_PREFIX, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(PLUGIN_PREFIX, 'package.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });

const run = spawnSync('npm', ['install', '--no-audit', '--no-fund'], {
  cwd: PLUGIN_PREFIX,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe']
});
if (run.status !== 0) {
  process.stderr.write(run.stdout ?? '');
  process.stderr.write(run.stderr ?? '');
  throw new Error(`npm install failed in ${PLUGIN_PREFIX}`);
}

const installed = {};
for (const [name, expected] of Object.entries(PLUGINS)) {
  const pkg = path.join(PLUGIN_PREFIX, 'node_modules', name, 'package.json');
  if (!fs.existsSync(pkg)) throw new Error(`Plugin missing after install: ${name}`);
  const version = JSON.parse(fs.readFileSync(pkg, 'utf8')).version;
  if (version !== expected) throw new Error(`${name}: expected ${expected}, installed ${version}`);
  installed[name] = version;
}
console.log(JSON.stringify({ prefix: PLUGIN_PREFIX, installed, lockfile: true }, null, 2));
