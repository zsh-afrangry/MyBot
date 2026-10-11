// Read-only guard for acceptance/deployment. No private rows are emitted.
// Compare logical user state, allowing normal WAL checkpoints/delivery audits.
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
export function productionSnapshot(root) {
  const domains = [
    ['list', 'personal-reminder-list/list.sqlite', ['items', 'settings', 'requests']],
    ['oneoff', 'personal-reminders/reminders.sqlite', ['reminder_proposals', 'reminders']],
  ];
  const result = {};
  for (const [label, file, tables] of domains) {
    const path = join(root, 'state', file);
    if (!existsSync(path)) {result[label] = 'absent'; continue;}
    const db = new DatabaseSync(path, {readOnly: true});
    try {
      db.exec('BEGIN');
      const rows = Object.fromEntries(tables.map(table => [table, db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()]));
      result[label] = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
    } finally {db.close();}
  }
  return JSON.stringify(result);
}
