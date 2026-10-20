// Document 25 P2: explicit owner memory migration. Preview by default; --apply writes state.
// No chat/model/QQ calls. Private backup contains the original MEMORY.md, never printed.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {migrateMemory} from '../plugins/kurumi-memory/continuity/migration.js';
const args = process.argv.slice(2), value = flag => {const n = args.indexOf(flag); return n < 0 ? undefined : args[n + 1];};
const root = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const config = JSON.parse(fs.readFileSync(path.join(root, 'config/runtime.config.json'), 'utf8'));
const workspace = value('--workspace') ?? config.agents.entries.main.workspace;
const ownerId = value('--owner') ?? JSON.parse(fs.readFileSync(path.join(root, 'config/access-control.json'), 'utf8')).subjects.find(s => s.role === 'owner').qq;
const backupRoot = value('--backup-root') ?? path.join(path.dirname(workspace), 'migration');
console.log(JSON.stringify(migrateMemory({workspace, ownerId, backupRoot, apply: args.includes('--apply')}), null, 2));
