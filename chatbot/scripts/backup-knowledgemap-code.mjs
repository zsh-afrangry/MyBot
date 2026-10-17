#!/usr/bin/env node
// 对应文档：docs/23_KnowledgeMap业务能力桥接.md「第二轮开发与验收」。
// Reads both main Git worktrees; writes only a NEW private backup directory.
// No runtime/database capture, service changes, remote writes or QQ delivery.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {parseArgs} from 'node:util';

const {values} = parseArgs({options: {'output-dir': {type: 'string'}}});
const output = values['output-dir'];
if (!output || !path.isAbsolute(output) || fs.existsSync(output)) throw Error('Requires a new absolute --output-dir');
process.umask(0o077);
fs.mkdirSync(output, {recursive: true, mode: 0o700});
fs.writeFileSync(path.join(output, 'INCOMPLETE'), 'Code capture not verified yet\n');
const hash = data => createHash('sha256').update(data).digest('hex');
const report = {at: new Date().toISOString(), repos: {}, boundary: 'Code/index only, excludes ignored files, dependencies, credentials and databases. Not a cross-system quiesced snapshot.'};
for (const [name, repo] of [['fusion', '/home/afrangry/kurumi-fusion'], ['knowledgemap', '/home/afrangry/repository']]) {
  const run = (...args) => execFileSync('git', args, {cwd: repo, maxBuffer: 128 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe']});
  const dest = path.join(output, name); fs.mkdirSync(dest, {mode: 0o700});
  const head = run('rev-parse', 'HEAD').toString().trim();
  const status = run('status', '--porcelain=v1', '-z');
  const indexPath = path.resolve(repo, run('rev-parse', '--git-path', 'index').toString().trim());
  const index = fs.readFileSync(indexPath);
  const files = [...new Set(run('ls-files', '--cached', '--others', '--exclude-standard', '-z').toString().split('\0').filter(Boolean))].filter(file => fs.existsSync(path.join(repo, file)));
  const sha256 = Object.fromEntries(files.map(file => [file, hash(fs.readFileSync(path.join(repo, file)))]));
  run('bundle', 'create', path.join(dest, 'history.bundle'), '--all');
  run('bundle', 'verify', path.join(dest, 'history.bundle'));
  execFileSync('tar', ['-czf', path.join(dest, 'working-tree.tar.gz'), '-C', repo, '--null', '-T', '-'], {input: files.join('\0') + '\0', stdio: ['pipe', 'pipe', 'pipe']});
  fs.writeFileSync(path.join(dest, 'index'), index);
  fs.writeFileSync(path.join(dest, 'staged.patch'), run('diff', '--cached', '--binary', '--full-index'));
  fs.writeFileSync(path.join(dest, 'unstaged.patch'), run('diff', '--binary', '--full-index'));
  fs.writeFileSync(path.join(dest, 'status.txt'), run('-c', 'core.quotePath=false', 'status', '--short', '--branch'));
  if (head !== run('rev-parse', 'HEAD').toString().trim() || !status.equals(run('status', '--porcelain=v1', '-z')) || !index.equals(fs.readFileSync(indexPath)) || files.some(file => sha256[file] !== hash(fs.readFileSync(path.join(repo, file))))) throw Error('Concurrent changes during capture; preserve INCOMPLETE and retry in new directory');
  const artifacts = Object.fromEntries(fs.readdirSync(dest).map(file => [file, hash(fs.readFileSync(path.join(dest, file)))]));
  fs.writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify({repo, head, sha256, artifacts}, null, 2) + '\n');
  report.repos[name] = {head, files: files.length, stable: true};
}
fs.writeFileSync(path.join(output, 'README.md'), '# Document23 code baseline\n\n' + report.boundary + '\n\nRestore into a NEW directory: clone history.bundle, checkout manifest.head, remove tracked paths absent from manifest.sha256, overlay working-tree.tar.gz, then compare every hash. index and separate staged/unstaged patches preserve staging evidence; never replace the index of a live concurrent checkout. Shared database and runtime configuration require separate private backup.\n');
fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(report, null, 2) + '\n');
fs.unlinkSync(path.join(output, 'INCOMPLETE'));
console.log(JSON.stringify({ok: true, backup: output, ...report}));
