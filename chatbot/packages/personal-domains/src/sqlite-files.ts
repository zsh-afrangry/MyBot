import {chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync} from "node:fs";
import {basename, resolve} from "node:path";
import type {DatabaseSync} from "node:sqlite";

export function prepareStateDirectory(inputPath: string): string {
  if (typeof inputPath !== "string" || inputPath.trim().length === 0) {
    throw new TypeError("stateDirectory must be a non-empty path");
  }

  const stateDirectory = resolve(inputPath);
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });

  const stateDirectoryStat = lstatSync(stateDirectory);
  if (stateDirectoryStat.isSymbolicLink() || !stateDirectoryStat.isDirectory()) {
    throw new Error("stateDirectory must be a real directory, not a symlink");
  }

  chmodSync(stateDirectory, 0o700);
  return stateDirectory;
}

export function prepareDatabaseFile(databasePath: string): void {
  if (existsSync(databasePath)) {
    const databaseStat = lstatSync(databasePath);
    if (databaseStat.isSymbolicLink() || !databaseStat.isFile()) {
      throw new Error(`${basename(databasePath)} must be a regular file, not a symlink`);
    }
  }

  const noFollow = constants.O_NOFOLLOW ?? 0;
  const createFlags = constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | noFollow;
  const existingFlags = constants.O_RDWR | noFollow;
  const fileDescriptor = openSync(
    databasePath,
    existsSync(databasePath) ? existingFlags : createFlags,
    0o600,
  );
  closeSync(fileDescriptor);
  chmodSync(databasePath, 0o600);
}

export function configureDatabase(database: DatabaseSync): void {
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA synchronous = NORMAL");
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec("PRAGMA secure_delete = ON");
  database.exec("PRAGMA temp_store = MEMORY");
}
