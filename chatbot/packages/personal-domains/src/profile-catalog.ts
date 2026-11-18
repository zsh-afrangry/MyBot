import type {Static} from 'typebox';
import {WeatherError} from './errors.js';
import type {profileCatalogEntrySchema} from './geo-config-schema.js';
import type {ProfileLocationRecord, ProfilePlaceResolver} from './weather-location.js';

type CatalogEntry = Static<typeof profileCatalogEntrySchema>;
const normalize = (value: string) => value.normalize('NFKC').trim().toLowerCase();

export function createProfileCatalog(entries: readonly CatalogEntry[]): ProfilePlaceResolver {
  if (!entries.length || entries.length > 512) throw new WeatherError('CONFIG_INVALID');
  const ids = new Set<string>();
  const trimmed = (value: string, maximum: number): string => {
    const text = value.trim();
    if (!text || text.length > maximum || /[\u0000-\u001f\u007f]/u.test(text)) throw new WeatherError('CONFIG_INVALID');
    return text;
  };

  const places = entries.map(entry => {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(entry.id) || ids.has(entry.id) || !/^[A-Z]{2}$/.test(entry.countryCode)
      || !Number.isFinite(entry.latitude) || Math.abs(entry.latitude) > 90
      || !Number.isFinite(entry.longitude) || Math.abs(entry.longitude) > 180
      || !['city', 'district', 'point'].includes(entry.precision)) throw new WeatherError('CONFIG_INVALID');
    ids.add(entry.id);
    const localityName = trimmed(entry.name, 80);
    const adm1 = entry.adm1 === undefined ? null : trimmed(entry.adm1, 50);
    const adm2 = entry.adm2 === undefined ? null : trimmed(entry.adm2, 50);
    const timezone = trimmed(entry.timezone, 100);
    try { new Intl.DateTimeFormat('en', {timeZone: timezone}); } catch { throw new WeatherError('CONFIG_INVALID'); }
    const place: ProfileLocationRecord = {
      placeKey: 'catalog:' + entry.id,
      displayName: [...new Set([adm1, adm2, localityName].filter(Boolean))].join(''),
      countryCode: entry.countryCode, adm1, adm2, district: entry.precision === 'district' ? localityName : null,
      localityName, latitude: entry.latitude, longitude: entry.longitude, timezone,
      precision: entry.precision, qweatherLocationId: null,
    };
    return place;
  });

  return async ({location, administrativeArea}, signal) => {
    signal?.throwIfAborted();
    const name = normalize(location), area = administrativeArea === undefined ? undefined : normalize(administrativeArea);
    const matching = places.filter(place => [place.localityName, place.displayName].some(value => normalize(value) === name)
      && (area === undefined || [place.adm1 ?? '', place.adm2 ?? '', (place.adm1 ?? '') + (place.adm2 ?? '')].some(value => normalize(value) === area)));
    const match = matching[0];
    if (!match) return {kind: 'not_found'};
    if (matching.length === 1) return {kind: 'resolved', location: {location: {...match}, attributions: ['operator_location_catalog']}};
    return {kind: 'ambiguous', candidates: matching.slice(0, 5).map(place => ({
      displayName: place.displayName, administrativeArea: [place.adm1, place.adm2].filter(Boolean).join('、'),
      country: place.countryCode, timezone: place.timezone,
    }))};
  };
}
