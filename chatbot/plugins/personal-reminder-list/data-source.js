// Persisted cutover authority for fixed runners, including already-declared legacy jobs.
import {existsSync, readFileSync} from 'node:fs';
import {join, isAbsolute} from 'node:path';
export const sourceFile = root => join(root, 'state', 'personal-reminder-list', 'data-source.json');
export function readListSource(root) {
  const file = sourceFile(root);
  if (!existsSync(file)) return;
  const value = JSON.parse(readFileSync(file, 'utf8'));
  if (value.dataSource !== 'knowledgemap' || !/^http:\/\/127\.0\.0\.1:\d+$/.test(value.baseUrl ?? '') || !isAbsolute(value.tokenFile ?? '')) throw Error('Invalid reminder-list cutover authority');
  return value;
}
