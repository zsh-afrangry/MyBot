// Registered non-Git directories: private Git baseline, reviewed file plan and reversible exclusive writeback.
// The worker runs under the existing kernel write fence; it never initializes Git in the original directory.
import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {confinedProcess} from '../../packages/coding-runtime/write-fence.js';
const fail = code => Object.assign(Error(code), {code});
const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
function hashFile(file) {
  const h = createHash('sha256'), fd = fs.openSync(file, 'r'), buffer = Buffer.alloc(1024 * 1024);
  try {let n; while ((n = fs.readSync(fd, buffer, 0, buffer.length, null))) h.update(buffer.subarray(0, n));}
  finally {fs.closeSync(fd);} return h.digest('hex');
}
function relative(root, name) {
  if (!name || path.isAbsolute(name) || name.includes('\0') || path.posix.normalize(name) !== name || name.split('/').some(v => ['..', '.', '.git'].includes(v))) throw fail('invalid_directory_path');
  const file = path.join(root, name);
  if (!file.startsWith(root + '/')) throw fail('invalid_directory_path');
  return file;
}
function fact(file, name) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw fail('directory_requires_regular_files');
  return {name, kind: stat.isDirectory() ? 'directory' : 'file', mode: stat.mode & 0o777, ...(stat.isFile() ? {hash: hashFile(file)} : {})};
}
export function directoryState(root, {ignoreGit = false} = {}) {
  if (fs.realpathSync(root) !== root || !fs.statSync(root).isDirectory()) throw fail('invalid_directory_root');
  const rows = [];
  function walk(dir, prefix = '') {
    for (const name of fs.readdirSync(dir).sort()) {
      if (name === '.git') {if (ignoreGit && !prefix) continue; throw fail('directory_contains_git');}
      const rel = prefix ? prefix + '/' + name : name, file = relative(root, rel), row = fact(file, rel);
      rows.push(row); if (row.kind === 'directory') walk(file, rel);
    }
  }
  walk(root); return rows.sort((a, b) => a.name.localeCompare(b.name));
}
export function copyDirectory(root, target, baseline) {
  fs.mkdirSync(target, {mode: 0o700});
  for (const row of baseline) {
    const to = relative(target, row.name);
    if (row.kind === 'directory') fs.mkdirSync(to, {recursive: true, mode: row.mode});
    else {fs.mkdirSync(path.dirname(to), {recursive: true}); fs.copyFileSync(relative(root, row.name), to, fs.constants.COPYFILE_EXCL); fs.chmodSync(to, row.mode);}
  }
  if (digest(directoryState(root)) !== digest(baseline) || digest(directoryState(target)) !== digest(baseline)) throw fail('directory_changed_during_copy');
}
export function directoryPlan(project, task, candidateDir, git) {
  const baseline = directoryState(project.root);
  if (digest(baseline) !== digest(task.directoryBaseline)) throw fail('directory_source_changed');
  directoryState(candidateDir, {ignoreGit: true}); // Reject symlinks/special/embedded Git artifacts before any writeback.
  const before = new Map(baseline.map(row => [row.name, row]));
  const fields = git(candidateDir, 'diff', '--name-status', '--no-renames', '-z', task.base, 'HEAD', '--').split('\0').filter(Boolean), changes = [];
  for (let i = 0; i < fields.length; i += 2) {
    const [status, name] = fields.slice(i, i + 2); relative(project.root, name);
    if (!['A', 'M', 'D', 'T'].includes(status)) throw fail('unsupported_directory_change');
    const prior = before.get(name) ?? null;
    if (prior && prior.kind !== 'file') throw fail('directory_type_change_not_supported');
    const after = status === 'D' ? null : fact(relative(candidateDir, name), name);
    if (after && after.kind !== 'file') throw fail('directory_type_change_not_supported');
    // Git preserves the executable bit; preserve the original's other permission bits for existing files.
    if (after && prior) after.mode = (prior.mode & ~0o111) | (after.mode & 0o111);
    changes.push({name, before: prior, after});
  }
  if (!changes.length) throw fail('no_coding_changes');
  const final = new Map(baseline.map(row => [row.name, row]));
  for (const change of changes) {
    if (change.after) {
      for (let dir = path.posix.dirname(change.name); dir !== '.'; dir = path.posix.dirname(dir)) {
        const existing = final.get(dir);
        if (existing && existing.kind !== 'directory') throw fail('directory_type_change_not_supported');
        if (!existing) final.set(dir, {name: dir, kind: 'directory', mode: 0o700});
      }
      final.set(change.name, change.after);
    } else final.delete(change.name);
  }
  for (const [name, prior] of before) if (final.has(name) && final.get(name).kind !== prior.kind) throw fail('directory_type_change_not_supported');
  return {baseline, changes, expected: [...final.values()].sort((a, b) => a.name.localeCompare(b.name))};
}
function saveJournal(file, value) {
  const temporary = file + '.' + randomUUID();
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
  fs.renameSync(temporary, file);
}
export function prepareDirectoryWriteback(root, project, task, candidateDir, plan) {
  const directory = path.join(root, 'tasks', task.id, 'writeback-' + randomUUID());
  fs.mkdirSync(directory, {recursive: true, mode: 0o700});
  fs.mkdirSync(path.join(directory, 'new')); fs.mkdirSync(path.join(directory, 'old'));
  for (const [i, change] of plan.changes.entries()) if (change.after) {
    const to = path.join(directory, 'new', String(i));
    fs.copyFileSync(relative(candidateDir, change.name), to, fs.constants.COPYFILE_EXCL); fs.chmodSync(to, change.after.mode);
    if (hashFile(to) !== change.after.hash) throw fail('candidate_changed');
  }
  const journal = {schemaVersion: 1, root: project.root, plan, phase: 'prepared', steps: [], createdDirectories: []};
  const file = path.join(directory, 'journal.json'); saveJournal(file, journal);
  return {file, planHash: digest(plan)};
}
export function runDirectoryWriteback(boundary, project, transaction) {
  const command = confinedProcess(boundary, process.execPath, [fileURLToPath(import.meta.url), '--writeback', transaction.file, project.root, transaction.planHash], project.root);
  const result = spawnSync(command.command, command.args, {cwd: project.root, env: {PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', ...command.env}, encoding: 'utf8'});
  let receipt;
  try {receipt = JSON.parse(result.stdout);} catch {throw fail('directory_writeback_requires_reconciliation');}
  if (result.status !== 0 || !receipt.ok) throw fail(receipt.code ?? 'directory_writeback_requires_reconciliation');
  return receipt;
}
function currentFact(root, name) {
  try {return fact(relative(root, name), name);} catch (e) {if (e.code === 'ENOENT') return null; throw e;}
}
function canonicalParents(root, file, journal, journalFile) {
  const names = path.relative(root, path.dirname(file)).split('/').filter(Boolean); let dir = root;
  for (const name of names) {
    dir = path.join(dir, name);
    if (!fs.existsSync(dir)) {fs.mkdirSync(dir, {mode: 0o700}); journal.createdDirectories.push(dir); saveJournal(journalFile, journal);}
    if (fs.realpathSync(dir) !== dir || !fs.lstatSync(dir).isDirectory()) throw fail('directory_source_changed');
  }
}
function applyDirectoryWriteback(file, root, planHash) {
  const directory = path.dirname(file), journal = JSON.parse(fs.readFileSync(file));
  if (fs.realpathSync(directory) !== directory || fs.realpathSync(root) !== root || journal.root !== root || journal.schemaVersion !== 1
    || journal.phase !== 'prepared' || digest(journal.plan) !== planHash) throw fail('invalid_directory_writeback');
  const {plan} = journal;
  if (digest(directoryState(root)) !== digest(plan.baseline)) throw fail('directory_source_changed');
  journal.phase = 'applying'; saveJournal(file, journal);
  try {
    for (const [i, change] of plan.changes.entries()) {
      const to = relative(root, change.name), old = path.join(directory, 'old', String(i)), staged = path.join(directory, 'new', String(i));
      canonicalParents(root, to, journal, file);
      if (digest(currentFact(root, change.name)) !== digest(change.before)) throw fail('directory_source_changed');
      const step = {i, moved: false, linked: false}; journal.steps.push(step); saveJournal(file, journal);
      // Move the actual preimage aside first. Never overwrite a concurrent writer's newly-created path.
      if (change.before) {
        fs.renameSync(to, old); step.moved = true; saveJournal(file, journal);
        if (digest(fact(old, change.name)) !== digest(change.before)) throw fail('directory_source_changed');
      }
      if (change.after) {
        if (fs.realpathSync(staged) !== staged || digest(fact(staged, change.name)) !== digest(change.after)) throw fail('candidate_changed');
        fs.linkSync(staged, to); step.linked = true; saveJournal(file, journal);
      }
    }
    if (digest(directoryState(root)) !== digest(plan.expected)) throw fail('directory_source_changed');
    for (const step of journal.steps) if (step.moved && digest(fact(path.join(directory, 'old', String(step.i)), plan.changes[step.i].name)) !== digest(plan.changes[step.i].before)) throw fail('directory_source_changed');
    journal.phase = 'applied'; saveJournal(file, journal); return {ok: true, state: 'written_back', directoryHash: digest(plan.expected)};
  } catch (error) {
    let restored = true;
    for (const step of journal.steps.toReversed()) {
      const change = plan.changes[step.i], to = relative(root, change.name), old = path.join(directory, 'old', String(step.i));
      try {
        if (step.linked) {
          if (digest(currentFact(root, change.name)) !== digest(change.after)) {restored = false; continue;}
          fs.renameSync(to, path.join(directory, 'new', 'failed-' + step.i));
        }
        if (step.moved) fs.linkSync(old, to); // Exclusive: preserve a concurrent file rather than overwriting it.
      } catch {restored = false;}
    }
    for (const dir of journal.createdDirectories.toReversed()) try {fs.rmdirSync(dir);} catch {restored = false;}
    journal.phase = restored ? 'rolled_back' : 'needs_reconciliation'; journal.code = error.code ?? 'directory_writeback_failed'; saveJournal(file, journal);
    throw fail(restored ? 'directory_writeback_rolled_back' : 'directory_writeback_requires_reconciliation');
  }
}
export function directoryWritebackState(transaction, project) {
  const journal = JSON.parse(fs.readFileSync(transaction.file));
  if (journal.root !== project.root || digest(journal.plan) !== transaction.planHash) throw fail('invalid_directory_writeback');
  const current = digest(directoryState(project.root));
  if (journal.phase === 'applied' && current === digest(journal.plan.expected)) return 'written_back';
  if (['prepared', 'rolled_back'].includes(journal.phase) && current === digest(journal.plan.baseline)) return 'ready';
  throw fail('directory_writeback_requires_reconciliation');
}
if (process.argv[2] === '--writeback' && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {console.log(JSON.stringify(applyDirectoryWriteback(process.argv[3], process.argv[4], process.argv[5])));}
  catch (error) {console.log(JSON.stringify({ok: false, code: error.code ?? 'directory_writeback_failed'})); process.exitCode = 1;}
}
