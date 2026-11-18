import {lstatSync} from 'node:fs';
import {join} from 'node:path';
import {CONTEXT_DATABASE_FILE, defaultWeatherPlace, WeatherStore} from './store.js';
import {WEATHER_CACHE_FILE, WeatherCacheStore} from './weather-cache.js';
import type {WeatherBriefStore} from './weather-service.js';

/** Borrow personal facts read-only and isolate all cache I/O from the context database. */
export function openWeatherBriefStore(stateDirectory: string, {readOnly = false} = {}): WeatherBriefStore & {close(): void} {
  let personal: WeatherStore | undefined = readOnly ? new WeatherStore({stateDirectory, readOnly: true}) : undefined;
  let weather: WeatherCacheStore | undefined;

  function cache(): WeatherCacheStore {
    return weather ??= new WeatherCacheStore({stateDirectory, readOnly});
  }

  return {
    getEffectivePlace(atUtc) {
      if (!readOnly && !lstatSync(join(stateDirectory, CONTEXT_DATABASE_FILE), {throwIfNoEntry: false})) {
        return defaultWeatherPlace();
      }
      personal ??= new WeatherStore({stateDirectory, readOnly: true});
      return personal.getEffectivePlace(atUtc);
    },
    getFreshApiCache(key, atUtc) {
      if (readOnly && !weather && !lstatSync(join(stateDirectory, WEATHER_CACHE_FILE), {throwIfNoEntry: false})) return;
      return cache().getFreshApiCache(key, atUtc);
    },
    deleteExpiredApiCache(atUtc) { return readOnly ? 0 : cache().deleteExpiredApiCache(atUtc); },
    deleteApiCache(key) { return readOnly ? false : cache().deleteApiCache(key); },
    putApiCache(entry) { if (!readOnly) cache().putApiCache(entry); },
    close() {
      try { personal?.close(); } finally { weather?.close(); }
    },
  };
}
