// Read-only dependency discovery for health checks and isolated recovery.
// 对应文档：docs/23_KnowledgeMap业务能力桥接.md「备份与恢复演练」。
import fs from 'node:fs';
import path from 'node:path';

// Only repository-owned package roots; never scan node_modules or runtime state.
export function lockedPackages(repo) {
  const result = [];
  for (const base of ['chatbot/packages', 'chatbot/plugins']) {
    const root = path.join(repo, base);
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, {withFileTypes: true})) {
      if (!entry.isDirectory()) continue;
      const relative = path.posix.join(base, entry.name), directory = path.join(repo, relative);
      if (!fs.existsSync(path.join(directory, 'package-lock.json'))) continue;
      const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
      result.push({relative, build: typeof manifest.scripts?.build === 'string'});
    }
  }
  return result.sort((a, b) => a.relative.localeCompare(b.relative));
}
