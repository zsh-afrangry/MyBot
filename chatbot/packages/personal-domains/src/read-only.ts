import {lstatSync, realpathSync} from 'node:fs';
import {isAbsolute, join, resolve} from 'node:path';
// Opening a background read must never initialize/migrate a business database.
export function readOnlyLocation(directory: string, file: string): {directory: string; file: string} {
  if (!isAbsolute(directory) || realpathSync(directory) !== resolve(directory)
    || !lstatSync(directory).isDirectory() || (lstatSync(directory).mode & 0o077)) throw Error('Unsafe read-only state directory');
  const target=join(directory,file), stat=lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw Error('Unsafe read-only business database');
  return {directory,file:target};
}
