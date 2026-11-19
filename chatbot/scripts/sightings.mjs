// Operator only. --collect-bilibili makes anonymous GET requests to Bilibili and records one
// successfully read public description. --withdraw marks a URL withdrawn without network access.
// Both use the sightings SQLite under OPENCLAW_STATE_DIR (default ~/.openclaw-fusion). No model or QQ calls.
import os from 'node:os';
import path from 'node:path';
import {createBilibiliPublicSource} from '../packages/media-source/bilibili.js';
import {createSightingsCollector, createSightingsService} from '../plugins/kurumi-sightings/service.js';
import {sqliteSightings} from '../plugins/kurumi-sightings/store.js';

const [command,...args] = process.argv.slice(2);
const collectBilibili = command === '--collect-bilibili' && args.length === 0;
const withdraw = command === '--withdraw' && args.length === 1;
if (!collectBilibili && !withdraw) {
  console.error('Usage: node chatbot/scripts/sightings.mjs --collect-bilibili | --withdraw <sighting:id>');
  process.exitCode = 2;
} else {
  try {
    const stateRoot = process.env.OPENCLAW_STATE_DIR ?? path.join(os.homedir(),'.openclaw-fusion');
    const store = sqliteSightings(stateRoot);
    let result;
    if (withdraw) result = createSightingsService({store}).withdraw(args[0]);
    else {
      const read = await createBilibiliPublicSource()();
      result = read.status === 'read'
        ? await createSightingsCollector({store, read:() => ({...read, origin:'independent-public'})})()
        : read;
    }
    console.log(JSON.stringify(result));
    if (['not_found','not_read','unavailable'].includes(result.status)) process.exitCode = 1;
  } catch (error) {
    console.error(error.code === 'invalid_query' ? 'invalid_sighting_id'
      : error.code === 'invalid_source' ? 'invalid_public_page' : 'sightings_store_unavailable');
    process.exitCode = 1;
  }
}
