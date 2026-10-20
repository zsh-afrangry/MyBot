// Read-only evidence classification and document ownership verification (docs/16).
// Named files/directories are declared once in documentation-map.json. Directory descendants inherit
// ownership; this does not prove test coverage or require a fresh row for every receipt in a suite.
// Usage: node scripts/fusion/evidence-coverage.mjs [--list | --json]
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadDocumentationMap, ownerFor, walkFiles} from './lib/documentation-map.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const map = loadDocumentationMap(ROOT);
const files = walkFiles(path.join(ROOT, 'docs/verification'), '', {omit: new Set()});
const classified = [];
const unmatched = [];
for (const rel of files) {
  const rule = ownerFor(rel, map.evidenceOwners, {exclusive: true});
  if (rule) classified.push({path: rel, category: rule.category, rule: rule.path ?? rule.prefix, documents: rule.documents});
  else unmatched.push(rel);
}
const counts = {};
for (const {category} of classified) counts[category] = (counts[category] ?? 0) + 1;
const result = {ok: !unmatched.length, total: files.length, counts, unmatched, classified};
if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
else {
  if (process.argv.includes('--list')) {
    for (const r of classified) console.log(`${r.category}\t${r.rule}\t${r.documents.join('、')}\t${r.path}`);
  }
  console.log('evidence coverage');
  for (const [group, n] of Object.entries(counts).sort()) console.log(`  ${group}: ${n}`);
  console.log(`  total: ${files.length}`);
  for (const rel of unmatched) console.error(`  unclassified file/directory: ${rel}`);
  console.log(unmatched.length ? 'FAILED: add a named ownership rule and register it in INDEX.md.' : 'OK: every file belongs to exactly one named group with valid documents.');
}
if (unmatched.length) process.exitCode = 1;
