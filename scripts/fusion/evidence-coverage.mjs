// Verify that every file under docs/verification/ is classified by the index's rules.
//
// Why this exists: 清单 C05 记录“验证目录基线为 124 个文件，现有索引声称全部覆盖”，但当时没有可执行的
// 覆盖检查，9 个顶层文件实际落在已列分类之外。这个脚本把索引里的分类规则变成可运行断言：
//   1. 每个文件必须命中"恰好一个"分类（同时命中当前有效与历史，或两个历史类，都视为规则不明确）；
//   2. 未被任何分类命中的文件以非零码退出，逼索引先更新。
//
// Usage:
//   node scripts/fusion/evidence-coverage.mjs          # 报告并校验
//   node scripts/fusion/evidence-coverage.mjs --list   # 逐文件列出所属分类
import fs from 'node:fs';
import path from 'node:path';
import {REPO_ROOT} from './lib/legacy-source.mjs';

const DIR = path.join(REPO_ROOT, 'docs/verification');

// Two rule sets, on purpose: directory/date rules are strong (they win), the bare `*.json` rule is
// only a fallback for top-level historical receipts. A file matching both a strong and the fallback
// rule is NOT ambiguous; a file matching two strong rules is.
const STRONG = [
  ['当前有效', (r) => r === 'INDEX.md'],
  ['当前有效', (r) => r === 'SCRIPTS.md'],
  ['当前有效', (r) => r === 'recovery-2026-10-06/README.md'],
  ['当前有效', (r) => r.startsWith('recovery-2026-10-06/')],
  ['当前有效', (r) => r.startsWith('recovery-2026-10-10/')],
  ['当前有效', (r) => r === '2026-10-10_projects-fusion-sync.md'],
  ['当前有效', (r) => r.startsWith('fusion/')],
  ['当前有效', (r) => r.startsWith('deepseek-whale/')],
  ['历史领域验收', (r) => r.startsWith('migration/')],
  ['历史领域验收', (r) => r.startsWith('step6-2026-10-05/')],
  // Date-prefixed top-level notes are historical *unless* listed as current above.
  ['历史领域验收', (r) => /^2026-\d\d-\d\d_/.test(r) && !CURRENT_NOTES.has(r)],
  ['历史领域验收', (r) => /-(acceptance|deployment)(-\w+)?\.json$/.test(r)],
];
/** Top-level notes that stay current evidence despite the date prefix. */
const CURRENT_NOTES = new Set(['2026-10-10_projects-fusion-sync.md']);
const FALLBACK = [
  ['历史领域验收', (r) => /\.json$/.test(r)],
];

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
const ambiguous = [];
for (const rel of files) {
  const strong = STRONG.filter(([, test]) => test(rel)).map(([name]) => name);
  const weak = FALLBACK.filter(([, test]) => test(rel)).map(([name]) => name);
  if (new Set(strong).size > 1) ambiguous.push([rel, strong]);
  else if (strong.length) classified.push([rel, strong[0]]);
  else if (weak.length) classified.push([rel, weak[0]]);
  else unmatched.push(rel);
}

const counts = {};
for (const [, group] of classified) counts[group] = (counts[group] ?? 0) + 1;

if (process.argv.includes('--list')) for (const [rel, group] of classified) console.log(`${group}\t${rel}`);

console.log('evidence coverage');
for (const [group, n] of Object.entries(counts).sort()) console.log(`  ${group}: ${n}`);
console.log(`  total: ${files.length}`);
if (ambiguous.length) {
  console.log('\nambiguous (matched several categories — tighten the rules):');
  for (const [rel, hits] of ambiguous) console.log(`  ${rel}: ${hits.join(' + ')}`);
}
if (unmatched.length) {
  console.log('\nunclassified files (add a rule and update INDEX.md):');
  for (const rel of unmatched) console.log(`  ${rel}`);
}
if (unmatched.length || ambiguous.length) {
  console.log('\nFAILED: docs/verification is not fully classified.');
  process.exit(1);
}
console.log('OK: every file is classified exactly once.');
