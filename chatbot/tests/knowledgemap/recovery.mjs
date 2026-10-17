#!/usr/bin/env node
// 对应文档：docs/23_KnowledgeMap业务能力桥接.md「备份与恢复演练」。
// Offline restore rehearsal: Git bundles/working trees + private SQLite. Temp dirs only.
import {parseArgs} from 'node:util';
import {execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync, mkdtempSync, rmSync, existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join, isAbsolute} from 'node:path';
import assert from 'node:assert/strict';
const {values} = parseArgs({options: {'backup-dir': {type: 'string'}, 'code-only': {type: 'boolean', default: false}}});
const backup = values['backup-dir']; assert.ok(backup && isAbsolute(backup));
const temp = mkdtempSync(join(tmpdir(), 'km-baseline-restore-')), report = {ok: false, repos: {}, sqlite: 0};
try {
  for (const name of ['fusion', 'knowledgemap']) {
    const source = join(backup, name), target = join(temp, name), manifest = JSON.parse(readFileSync(join(source, 'manifest.json')));
    execFileSync('git', ['clone', '--no-checkout', '--quiet', join(source, 'history.bundle'), target], {stdio: 'pipe'});
    execFileSync('git', ['checkout', '--detach', '--quiet', manifest.head], {cwd: target, stdio: 'pipe'});
    // Remove only absent tracked paths inside the disposable restore, then overlay archived files.
    const tracked = execFileSync('git', ['ls-files', '-z'], {cwd: target}).toString().split('\0').filter(Boolean);
    for (const file of tracked) if (!(file in manifest.sha256)) rmSync(join(target, file), {force: true});
    execFileSync('tar', ['-xzf', join(source, 'working-tree.tar.gz'), '-C', target], {stdio: 'pipe'});
    for (const [file, hash] of Object.entries(manifest.sha256)) {
      assert.equal(createHash('sha256').update(readFileSync(join(target, file))).digest('hex'), hash, `restore mismatch: ${name}/${file}`);
    }
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], {cwd: target}).toString().trim(), manifest.head);
    report.repos[name] = {head: manifest.head, verifiedFiles: Object.keys(manifest.sha256).length};
  }
  if (!values['code-only']) {
  const manifest = JSON.parse(readFileSync(join(backup, 'private-state/manifest.json')));
  for (const [file, hash] of Object.entries(manifest.sqlite)) {
    const source = join(backup, 'private-state/fusion', file);
    assert.equal(createHash('sha256').update(readFileSync(source)).digest('hex'), hash);
    const db = new DatabaseSync(source, {readOnly: true});
    try {assert.equal(Object.values(db.prepare('PRAGMA quick_check').get())[0], 'ok');} finally {db.close();}
    report.sqlite++;
  }
  for (const file of manifest.privateFiles) assert.ok(existsSync(join(backup, 'private-state', file)));
  }
  report.codeOnly = values['code-only'];
  report.ok = true; console.log(JSON.stringify(report));
} finally {rmSync(temp, {recursive: true, force: true});}
