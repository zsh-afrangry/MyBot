import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test, vi } from "vitest";

import { readActiveReminders, readPlanning, readWeatherBrief } from "./read-model.js";
import { WeatherCacheStore } from "./weather-cache.js";
import { weatherCacheIdentity } from "./weather-service.js";
import { openWeatherBriefStore } from "./weather-query-store.js";
import { WeatherStore } from "./store.js";
import { alertFixture, currentFixture, dailyFixture, hourlyFixture } from "./test-fixtures.js";

const temporaryRoots: string[] = [];

function createStateRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kurumi-read-model-")));
  temporaryRoots.push(root);
  return root;
}

test('weather can initialize and refresh its cache without creating or writing personal state', () => {
  const stateDirectory = join(createStateRoot(), 'state', 'personal-weather');
  const contextPath = join(stateDirectory, 'weather.sqlite');
  const cachePath = join(stateDirectory, 'weather-cache.sqlite');
  const weather = openWeatherBriefStore(stateDirectory);
  try {
    const now = Math.floor(Date.now() / 1000), place = weather.getEffectivePlace(now);
    assert.equal(place.source, 'default');
    weather.putApiCache({cacheKey:'fixture:current', endpointKind:'current', fetchedAtUtc:now,
      expiresAtUtc:now+60, payload:{fixture:true}});
    assert(existsSync(cachePath));
    assert(!existsSync(contextPath));

    const context = new WeatherStore({stateDirectory});
    const expected = context.getCurrentLocation().place;
    context.close();
    const before = readFileSync(contextPath);
    assert.deepEqual(weather.getEffectivePlace(now).place, expected);
    weather.deleteApiCache('fixture:current');
    assert.deepEqual(readFileSync(contextPath), before);
  } finally {
    weather.close();
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("read-only queries report missing databases without creating directories or files", async () => {
  const stateRoot = createStateRoot();
  async function assertMissing() {
    assert.throws(() => readPlanning(stateRoot), { code: "ENOENT" });
    assert.throws(() => readActiveReminders(stateRoot), { code: "ENOENT" });
    await assert.rejects(readWeatherBrief({ stateRoot, config: {} }), { code: "ENOENT" });
  }

  await assertMissing();
  assert.deepEqual(readdirSync(stateRoot), []);

  const weatherDirectory = join(stateRoot, "state", "personal-weather");
  const reminderDirectory = join(stateRoot, "state", "personal-reminders");
  for (const directory of [weatherDirectory, reminderDirectory]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  await assertMissing();
  for (const directory of [weatherDirectory, reminderDirectory]) {
    assert.deepEqual(readdirSync(directory), []);
  }
});

test("a weather brief refreshes a corrupt cache entry from upstream without changing cache rows", async () => {
  const stateRoot = createStateRoot();
  const now = Date.parse("2026-08-06T02:30:00.000Z");
  const nowUtc = now / 1000;
  vi.spyOn(Date, "now").mockReturnValue(now);
  vi.stubEnv("OPENCLAW_STATE_DIR", undefined);
  const responses: Record<string, unknown> = {
    "/api/assistant/weather/current": currentFixture,
    "/api/assistant/weather/daily": dailyFixture,
    "/api/assistant/weather/hourly": hourlyFixture,
    "/api/assistant/weather/alerts": alertFixture,
  };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const pathname = new URL(input instanceof Request ? input.url : input).pathname;
    return pathname in responses ? Response.json(responses[pathname]) : new Response(null, { status: 404 });
  });
  const tokenFile = join(stateRoot, "fixture-token");
  writeFileSync(tokenFile, "synthetic-weather-credential-for-tests", { mode: 0o600 });

  const store = new WeatherStore({ stateDirectory: join(stateRoot, "state", "personal-weather") });
  const cacheKey = "v1:current:" + weatherCacheIdentity(store.getDefaultPlace());
  store.close();
  const cache = new WeatherCacheStore({stateDirectory: store.stateDirectory});
  try {
    cache.putApiCache({
      cacheKey,
      endpointKind: "current",
      fetchedAtUtc: nowUtc - 60,
      expiresAtUtc: nowUtc + 60,
      payload: currentFixture,
    });
    cache.putApiCache({
      cacheKey: "v1:expired",
      endpointKind: "current",
      fetchedAtUtc: nowUtc - 600,
      expiresAtUtc: nowUtc - 60,
      payload: currentFixture,
    });
  } finally {
    cache.close();
  }

  const database = new DatabaseSync(cache.databasePath);
  try {
    // Normal writes enforce valid JSON. Simulate corruption in the test fixture.
    database.exec("PRAGMA ignore_check_constraints = ON");
    database.prepare("UPDATE api_cache SET response_json = ? WHERE cache_key = ?").run("invalid JSON", cacheKey);
    database.exec("PRAGMA ignore_check_constraints = OFF");
    const cacheRows = database.prepare("SELECT * FROM api_cache ORDER BY cache_key");
    const before = cacheRows.all();

    const brief = await readWeatherBrief({
      stateRoot,
      config: {
        weatherBackend: "knowledgemap",
        bridgeBaseUrl: "http://127.0.0.1:1",
        bridgeTokenFile: tokenFile,
      },
    });
    assert.equal(brief.quality.current.state, "fresh");
    assert.equal(brief.current.temperature.value, currentFixture.temperature.value);
    assert.deepEqual(cacheRows.all(), before);
  } finally {
    database.close();
  }
});
