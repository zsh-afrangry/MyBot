// Verify that every file under docs/verification/ is classified by a NAMED rule.
//
// Why this exists: 清单 C05 记录验证目录曾声称“全部覆盖”，但 9 个顶层文件落在已列分类之外，
// 当时没有可执行的覆盖检查。本脚本把索引里的分类规则变成可运行断言。
//
// Corrected per R02: the first version had a generic `*.json` fallback, which silently absorbed any
// new JSON file in any directory and therefore could not prove that a new file had been registered.
// The fallback is gone; every pattern below is named and intentional, so a file matching none of
// them fails the check until someone classifies it on purpose. New directories are reported too.
//
// Usage:
//   node scripts/fusion/evidence-coverage.mjs          # report and verify
//   node scripts/fusion/evidence-coverage.mjs --list   # list each file with its category and rule
import fs from 'node:fs';
import path from 'node:path';
import {REPO_ROOT} from './lib/legacy-source.mjs';

const DIR = path.join(REPO_ROOT, 'docs/verification');

/** Top-level notes that stay current evidence despite the date prefix. */
const CURRENT_NOTES = new Set(['2026-10-10_projects-fusion-sync.md']);
const CURRENT_FILES = new Set(['INDEX.md', 'SCRIPTS.md']);

// Directories holding current evidence (whole subtree), by explicit name.
const CURRENT_DIRS = ['recovery-2026-10-06/', 'recovery-2026-10-10/', 'fusion/', 'deepseek-whale/'];
// Directories holding historical material (whole subtree), by explicit name.
const HISTORICAL_DIRS = ['migration/', 'step6-2026-10-05/'];
// Named patterns for top-level historical receipts — deliberate conventions, not a catch-all.
// `initial`/`fixed`/`-a/-b` record attempts and corrections; `acceptance`/`deployment` are domain
// receipts; `probe` is provider/API probing output.
const HISTORICAL_PATTERNS = [
  [/^[a-z0-9-]+-acceptance\.json$/, '顶层领域验收回执'],
  [/^[a-z0-9-]+-deployment\.json$/, '部署/迁移回执'],
  [/^[a-z0-9-]+-initial\.json$/, '首次尝试（失败保留）'],
  [/^[a-z0-9-]+-fixed\.json$/, '修正后复验'],
  [/^[a-z0-9-]+-[ab]\.json$/, 'A/B 对照样本'],
  [/^[a-z0-9-]+-probe\.json$/, 'provider/API 探测输出'],
  [/^retrieval-review-[0-9]+\.json$/, '检索现状复核汇总证据'],
];

function classify(rel) {
  if (CURRENT_FILES.has(rel)) return ['当前有效', '索引/清单文件'];
  for (const dir of CURRENT_DIRS) if (rel.startsWith(dir)) return ['当前有效', `当前证据目录 ${dir}`];
  if (CURRENT_NOTES.has(rel)) return ['当前有效', '当前收尾证据（显式登记）'];
  for (const dir of HISTORICAL_DIRS) if (rel.startsWith(dir)) return ['历史领域验收', `历史目录 ${dir}`];
  if (/^2026-\d\d-\d\d_/.test(rel)) return ['历史领域验收', '阶段复核记录（日期前缀）'];
  for (const [re, why] of HISTORICAL_PATTERNS) if (re.test(rel)) return ['历史领域验收', why];
  return null;
}

function walk(dir, base = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

const files = walk(DIR).sort();
const classified = [];
const unmatched = [];
for (const rel of files) {
  const hit = classify(rel);
  if (hit) classified.push([rel, hit[0], hit[1]]);
  else unmatched.push(rel);
}

const counts = {};
for (const [, group] of classified) counts[group] = (counts[group] ?? 0) + 1;

if (process.argv.includes('--list')) {
  for (const [rel, group, why] of classified) console.log(`${group}\t${why}\t${rel}`);
}

// Report the directories actually present, so a brand-new directory is visible even if its files
// happen to match a top-level pattern.
const dirs = [...new Set(files.filter((f) => f.includes('/')).map((f) => f.split('/')[0]))].sort();
const knownDirs = new Set([...CURRENT_DIRS, ...HISTORICAL_DIRS].map((d) => d.replace(/\/$/, '')));
const unknownDirs = dirs.filter((d) => !knownDirs.has(d));

console.log('evidence coverage');
for (const [group, n] of Object.entries(counts).sort()) console.log(`  ${group}: ${n}`);
console.log(`  total: ${files.length}`);
if (unknownDirs.length) {
  console.log('\ndirectories with no named rule:');
  for (const d of unknownDirs) console.log(`  ${d}/`);
}
if (unmatched.length) {
  console.log('\nunclassified files (add a named rule and register it in INDEX.md):');
  for (const rel of unmatched) console.log(`  ${rel}`);
}
if (unmatched.length || unknownDirs.length) {
  console.log('\nFAILED: docs/verification is not fully classified by named rules.');
  process.exit(1);
}
console.log('OK: every file is classified by a named rule.');
