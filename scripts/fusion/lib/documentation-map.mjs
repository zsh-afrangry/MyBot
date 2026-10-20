// Read-only documentation ownership and maintenance-source discovery (docs/16).
// These helpers inspect repository files only; they never import or execute discovered scripts.
import fs from 'node:fs';
import path from 'node:path';

const SECTIONS = ['scriptOwners', 'runtimeSources', 'archivedScripts', 'evidenceOwners'];
const OMIT = new Set(['.git', 'node_modules', 'dist', '.venv', '.venvs', 'venvs', '__pycache__', '.cache']);

function repositoryPath(root, rel) {
  if (typeof rel !== 'string' || !rel || path.isAbsolute(rel) || rel.split('/').includes('..')) {
    throw new Error(`Invalid repository-relative path: ${rel}`);
  }
  return path.join(root, rel);
}

export function loadDocumentationMap(root) {
  const map = JSON.parse(fs.readFileSync(path.join(root, 'scripts/fusion/documentation-map.json'), 'utf8'));
  if (map.version !== 1) throw new Error(`Unsupported documentation map version: ${map.version}`);
  for (const section of SECTIONS) {
    if (!Array.isArray(map[section]) || !map[section].length) throw new Error(`Missing ownership rules: ${section}`);
    const seen = new Set();
    for (const rule of map[section]) {
      const keys = ['path', 'prefix'].filter((key) => rule[key] !== undefined);
      if (keys.length !== 1) throw new Error(`Exactly one path/prefix required in ${section}`);
      const selector = rule[keys[0]];
      const key = `${keys[0]}:${selector}`;
      if (seen.has(key)) throw new Error(`Duplicate ownership selector in ${section}: ${key}`);
      seen.add(key);
      const base = section === 'evidenceOwners' ? path.join(root, 'docs/verification') : root;
      const selected = repositoryPath(base, selector);
      if (!fs.existsSync(selected)) throw new Error(`Ownership selector has no target: ${section}/${selector}`);
      const stat = fs.statSync(selected);
      if (keys[0] === 'prefix' ? !selector.endsWith('/') || !stat.isDirectory() : !stat.isFile()) {
        throw new Error(`Ownership selector has wrong file/directory type: ${key}`);
      }
      if (!Array.isArray(rule.documents) || !rule.documents.length) throw new Error(`Missing documents: ${key}`);
      for (const ref of [...rule.documents, ...(rule.evidence ?? [])]) {
        if (!fs.statSync(repositoryPath(root, ref), {throwIfNoEntry: false})?.isFile()) {
          throw new Error(`Missing documentation/evidence target: ${ref} (${key})`);
        }
      }
      if (section === 'evidenceOwners' && !['当前有效', '历史领域验收'].includes(rule.category)) {
        throw new Error(`Unknown evidence category: ${key}`);
      }
    }
  }
  return map;
}

// Suite rules may be overridden by a longer prefix or an exact file. Evidence uses exclusive=true
// because each receipt must belong to exactly one named group, without first-match fallbacks.
export function ownerFor(rel, rules, {exclusive = false} = {}) {
  const hits = rules.filter((rule) => rule.path === rel || (rule.prefix && rel.startsWith(rule.prefix)));
  if (exclusive && hits.length > 1) throw new Error(`Overlapping ownership rules: ${rel}`);
  const score = (rule) => rule.path ? Number.MAX_SAFE_INTEGER : rule.prefix.length;
  return hits.sort((a, b) => score(b) - score(a))[0] ?? null;
}

export function walkFiles(root, base = '', {omit = OMIT} = {}) {
  const out = [];
  for (const entry of fs.readdirSync(path.join(root, base), {withFileTypes: true})) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!omit.has(entry.name)) out.push(...walkFiles(root, rel, {omit}));
    } else if (entry.isFile()) out.push(rel);
  }
  return out.sort();
}

export function discoverMaintenanceSources(root) {
  return walkFiles(root).filter((rel) => {
    if (/\.(?:mjs|cjs|sh|py)$/.test(rel)) return true;
    if (!/\.[cm]?[jt]sx?$/.test(rel)) return false;
    if (/(?:^|\/)(?:scripts|tests?|spec)(?:\/|\.)|\.(?:test|spec)\.|(?:^|\/)test-fixtures\./.test(rel)) return true;
    return fs.readFileSync(path.join(root, rel), 'utf8').startsWith('#!');
  });
}
