import { createHmac, timingSafeEqual } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAbsolute } from 'node:path';
import { WeatherStore } from './store.js';

// The underlying credential is already shared by the two local services. A
// purpose-derived key cannot be used to call the KnowledgeMap assistant API.
const KEY_PURPOSE = 'kurumi:shared-default-city:v1';
export const SHARED_LOCATION_PATH = '/plugins/personal-profile/current-location';

type RouteHandler = (request: IncomingMessage, response: ServerResponse) => boolean;
type RouteHost = {registerHttpRoute(params: {path: string; auth: 'plugin'; match: 'exact'; handler: RouteHandler}): void};

function scopedKey(tokenFile: string | undefined): string {
  if (!tokenFile || !isAbsolute(tokenFile)) throw new Error('Missing service credential');
  const stat = lstatSync(tokenFile);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.size > 512) throw new Error('Unsafe service credential');
  const token = readFileSync(tokenFile, 'utf8').trim();
  if (!/^[\x21-\x7e]{32,256}$/.test(token)) throw new Error('Invalid service credential');
  return createHmac('sha256', token).update(KEY_PURPOSE).digest('hex');
}

function send(response: ServerResponse, status: number, body: object): boolean {
  response.writeHead(status, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff'});
  response.end(JSON.stringify(body));
  return true;
}

export function createSharedLocationHandler(options: {stateDirectory: string; tokenFile: string | undefined}): RouteHandler {
  return (request, response) => {
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? ''))
      return send(response, 403, {ok: false});
    if (request.method !== 'GET') return send(response, 405, {ok: false});
    if (request.url !== SHARED_LOCATION_PATH) return send(response, 404, {ok: false});
    let expected: string;
    try { expected = scopedKey(options.tokenFile); }
    catch { return send(response, 503, {ok: false}); }
    const supplied = request.headers.authorization ?? '';
    const expectedHeader = Buffer.from(`Bearer ${expected}`);
    const suppliedHeader = Buffer.from(supplied);
    if (suppliedHeader.length !== expectedHeader.length || !timingSafeEqual(suppliedHeader, expectedHeader))
      return send(response, 401, {ok: false});
    let store: WeatherStore | undefined;
    try {
      store = new WeatherStore({stateDirectory: options.stateDirectory, readOnly: true, readOnlyBusyTimeoutMs: 100});
      const current = store.getCurrentLocation();
      if (current.source !== 'owner_confirmed' && current.source !== 'migrated_from_weather_default')
        return send(response, 503, {ok: false});
      const {place} = current;
      if (!Number.isFinite(place.latitude) || Math.abs(place.latitude) > 90 || !Number.isFinite(place.longitude) || Math.abs(place.longitude) > 180)
        throw new Error('Invalid coordinates');
      if (!place.displayName.trim() || place.displayName.length > 200 || /[\u0000-\u001f\u007f]/u.test(place.displayName))
        throw new Error('Invalid location name');
      const id = place.qweatherLocationId;
      const location = id && /^[a-zA-Z0-9_-]{1,64}$/.test(id)
        ? id : `${place.longitude.toFixed(2)},${place.latitude.toFixed(2)}`;
      return send(response, 200, {ok: true, location, displayName: place.displayName, revision: current.revision});
    } catch {
      return send(response, 503, {ok: false});
    } finally {store?.close();}
  };
}

export function registerSharedLocationRoute(api: RouteHost, options: {stateDirectory: string; tokenFile: string | undefined}): void {
  api.registerHttpRoute({path: SHARED_LOCATION_PATH, auth: 'plugin', match: 'exact', handler: createSharedLocationHandler(options)});
}
