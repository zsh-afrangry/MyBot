// Rebuildable upper-layer weather cache. No personal tables or cross-database foreign keys.
import {chmodSync} from "node:fs";
import {createHash} from "node:crypto";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {readOnlyLocation} from "./read-only.js";
import {configureDatabase, prepareDatabaseFile, prepareStateDirectory} from "./sqlite-files.js";
import type {UnixSeconds} from "./store.js";

export const WEATHER_CACHE_FILE = "weather-cache.sqlite";
const CACHE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS api_cache (
    cache_key TEXT PRIMARY KEY CHECK (length(cache_key) BETWEEN 1 AND 500),
    endpoint_kind TEXT NOT NULL CHECK (length(endpoint_kind) BETWEEN 1 AND 100),
    metadata_tag TEXT CHECK (length(metadata_tag) <= 500),
    payload_hash TEXT CHECK (length(payload_hash) BETWEEN 32 AND 128),
    fetched_at_utc INTEGER NOT NULL CHECK (fetched_at_utc >= 0),
    expires_at_utc INTEGER NOT NULL CHECK (expires_at_utc > fetched_at_utc),
    response_size_bytes INTEGER NOT NULL
      CHECK (response_size_bytes BETWEEN 2 AND 1048576),
    response_json TEXT NOT NULL CHECK (json_valid(response_json)),
    created_at_utc INTEGER NOT NULL CHECK (created_at_utc >= 0),
    updated_at_utc INTEGER NOT NULL CHECK (updated_at_utc >= created_at_utc)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS api_cache_expiry_index ON api_cache(expires_at_utc);
`;

export interface CachedApiResponse {
  cacheKey: string;
  endpointKind: string;
  metadataTag: string | null;
  fetchedAtUtc: UnixSeconds;
  expiresAtUtc: UnixSeconds;
  payload: unknown;
}

export class WeatherCacheStore {
  readonly databasePath: string;
  readonly #database: DatabaseSync;
  readonly #readOnly: boolean;
  readonly #now: () => UnixSeconds;
  #closed = false;

  constructor({stateDirectory, readOnly = false, now = () => Math.floor(Date.now() / 1000)}:
    {stateDirectory: string; readOnly?: boolean; now?: () => UnixSeconds}) {
    this.#readOnly = readOnly;
    this.#now = now;
    if (readOnly) {
      this.databasePath = readOnlyLocation(stateDirectory, WEATHER_CACHE_FILE).file;
      this.#database = new DatabaseSync(this.databasePath, {readOnly: true});
      this.#database.exec("PRAGMA busy_timeout = 5000");
      return;
    }
    this.databasePath = join(prepareStateDirectory(stateDirectory), WEATHER_CACHE_FILE);
    prepareDatabaseFile(this.databasePath);
    this.#database = new DatabaseSync(this.databasePath);
    try {
      configureDatabase(this.#database);
      this.#database.exec(CACHE_SCHEMA);
      chmodSync(this.databasePath, 0o600);
    } catch (error) {
      this.close();
      throw error;
    }
  }

  close(): void {
    if (!this.#closed) {
      this.#database.close();
      this.#closed = true;
    }
  }

  getFreshApiCache(
    cacheKey: string,
    atUtc: UnixSeconds = normalizeUnixSeconds(this.#now()),
  ): CachedApiResponse | undefined {
    assertCacheKey(cacheKey);
    const normalizedAtUtc = normalizeUnixSeconds(atUtc);
    this.#assertOpen();

    const row = this.#database.prepare(`
      SELECT cache_key, endpoint_kind, metadata_tag,
             fetched_at_utc, expires_at_utc, response_json
      FROM api_cache
      WHERE cache_key = ? AND ? < expires_at_utc
    `).get(cacheKey, normalizedAtUtc) as
      | {
          cache_key: string;
          endpoint_kind: string;
          metadata_tag: string | null;
          fetched_at_utc: number;
          expires_at_utc: number;
          response_json: string;
        }
      | undefined;

    if (!row) {
      return undefined;
    }
    try {
      return {
        cacheKey: row.cache_key,
        endpointKind: row.endpoint_kind,
        metadataTag: row.metadata_tag,
        fetchedAtUtc: row.fetched_at_utc,
        expiresAtUtc: row.expires_at_utc,
        payload: JSON.parse(row.response_json) as unknown,
      };
    } catch {
      if (!this.#readOnly) {
        this.#database.prepare("DELETE FROM api_cache WHERE cache_key = ?").run(cacheKey);
      }
      return undefined;
    }
  }

  putApiCache(input: {
    cacheKey: string;
    endpointKind: string;
    metadataTag?: string;
    fetchedAtUtc: UnixSeconds;
    expiresAtUtc: UnixSeconds;
    payload: unknown;
  }): void {
    assertCacheKey(input.cacheKey);
    assertShortText(input.endpointKind, "endpointKind", 100);
    if (input.metadataTag !== undefined) {
      assertShortText(input.metadataTag, "metadataTag", 500);
    }
    const fetchedAtUtc = normalizeUnixSeconds(input.fetchedAtUtc);
    const expiresAtUtc = normalizeUnixSeconds(input.expiresAtUtc);
    if (expiresAtUtc <= fetchedAtUtc) {
      throw new TypeError("expiresAtUtc must be later than fetchedAtUtc");
    }
    const responseJson = JSON.stringify(input.payload);
    if (responseJson === undefined) {
      throw new TypeError("API cache payload must be JSON serializable");
    }
    const responseSizeBytes = Buffer.byteLength(responseJson, "utf8");
    if (responseSizeBytes < 2 || responseSizeBytes > 1024 * 1024) {
      throw new TypeError("API cache payload is outside the allowed size range");
    }
    const payloadHash = createHash("sha256").update(responseJson).digest("hex");
    this.#assertOpen();

    this.#database.prepare(`
      INSERT INTO api_cache (
        cache_key, endpoint_kind, metadata_tag, payload_hash,
        fetched_at_utc, expires_at_utc, response_size_bytes, response_json,
        created_at_utc, updated_at_utc
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET
        endpoint_kind = excluded.endpoint_kind,
        metadata_tag = excluded.metadata_tag,
        payload_hash = excluded.payload_hash,
        fetched_at_utc = excluded.fetched_at_utc,
        expires_at_utc = excluded.expires_at_utc,
        response_size_bytes = excluded.response_size_bytes,
        response_json = excluded.response_json,
        updated_at_utc = excluded.updated_at_utc
    `).run(
      input.cacheKey,
      input.endpointKind,
      input.metadataTag ?? null,
      payloadHash,
      fetchedAtUtc,
      expiresAtUtc,
      responseSizeBytes,
      responseJson,
      fetchedAtUtc,
      fetchedAtUtc,
    );
  }

  deleteExpiredApiCache(
    atUtc: UnixSeconds = normalizeUnixSeconds(this.#now()),
  ): number {
    const normalizedAtUtc = normalizeUnixSeconds(atUtc);
    this.#assertOpen();
    return Number(
      this.#database
        .prepare("DELETE FROM api_cache WHERE expires_at_utc <= ?")
        .run(normalizedAtUtc).changes,
    );
  }

  deleteApiCache(cacheKey: string): boolean {
    assertCacheKey(cacheKey);
    this.#assertOpen();
    return (
      Number(
        this.#database.prepare("DELETE FROM api_cache WHERE cache_key = ?").run(cacheKey)
          .changes,
      ) > 0
    );
  }

  #assertOpen(): void {
    if (this.#closed) throw Error("Weather cache is closed");
  }
}

function normalizeUnixSeconds(value: number): UnixSeconds {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("Invalid cache timestamp");
  return value;
}

function assertShortText(value: string, name: string, maximum: number): void {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value.includes("\u0000")) {
    throw new TypeError(`${name} is outside the allowed size range`);
  }
}

function assertCacheKey(cacheKey: string): void {
  assertShortText(cacheKey, "cacheKey", 500);
}
