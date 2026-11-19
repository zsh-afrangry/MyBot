// Operator only. --withdraw marks the supplied record's URL withdrawn in the existing sightings
// SQLite DB under OPENCLAW_STATE_DIR (default ~/.openclaw-fusion); retains rows, never fetches or sends.
import os from 'node:os';
import path from 'node:path';
import {createSightingsService} from '../plugins/kurumi-sightings/service.js';
import {sqliteSightings} from '../plugins/kurumi-sightings/store.js';

const [command,id,...extra] = process.argv.slice(2);
if (command !== '--withdraw' || !id || extra.length) {
  console.error('Usage: node chatbot/scripts/sightings.mjs --withdraw <sighting:id>');
  process.exitCode = 2;
} else {
  try {
    const stateRoot = process.env.OPENCLAW_STATE_DIR ?? path.join(os.homedir(),'.openclaw-fusion');
    const service = createSightingsService({store:sqliteSightings(stateRoot)});
    const result = service.withdraw(id);
    console.log(JSON.stringify(result));
    if (result.status === 'not_found') process.exitCode = 1;
  } catch (error) {
    console.error(error.code === 'invalid_query' ? 'invalid_sighting_id' : 'sightings_store_unavailable');
    process.exitCode = 1;
  }
}
