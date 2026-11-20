import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {SightingsError, shanghaiDay} from './policy.js';

function checkedPath(dir, {create}) {
  if (!path.isAbsolute(dir) || fs.realpathSync(dir) !== path.resolve(dir)) throw new SightingsError('store_unavailable');
  for (const name of ['state','shared-sightings']) {
    dir = path.join(dir, name);
    const stat = fs.lstatSync(dir, {throwIfNoEntry:false});
    if (!stat) {
      if (!create) return null;
      fs.mkdirSync(dir, {mode:0o700});
    } else if (!stat.isDirectory()) throw new SightingsError('store_unavailable');
  }
  const file = path.join(dir, 'sightings.sqlite');
  const stat = fs.lstatSync(file, {throwIfNoEntry:false});
  if (stat && !stat.isFile()) throw new SightingsError('store_unavailable');
  return stat || create ? file : null;
}

export function sqliteSightings(stateRoot) {
  function withDB({write = false, create = false} = {}, fn) {
    const file = checkedPath(stateRoot,{create});
    if (!file) return null;
    const db = new DatabaseSync(file,{readOnly:!write});
    try {
      if (create) {
        fs.chmodSync(file,0o600);
        db.exec(fs.readFileSync(new URL('./schema.sql', import.meta.url),'utf8'));
      }
      db.exec('PRAGMA busy_timeout=2000');
      if (write) db.exec('BEGIN IMMEDIATE');
      const value = fn(db);
      if (write) db.exec('COMMIT');
      return value;
    } finally { db.close(); }
  }

  return {
    initialize() { withDB({write:true,create:true}, () => undefined); },
    record(page, at) {
      return withDB({write:true,create:true}, db => {
        if (db.prepare('SELECT 1 FROM sightings WHERE url=? AND withdrawn_at IS NOT NULL LIMIT 1').get(page.url)) {
          return {status:'ignored', reason:'withdrawn'};
        }
        const date = shanghaiDay(at);
        const id = 'sighting:' + createHash('sha256').update(JSON.stringify([page.url,date])).digest('hex').slice(0,32);
        const result = db.prepare(`INSERT INTO sightings (id,platform,url,title,excerpt,seen_at,seen_date) VALUES (?,?,?,?,?,?,?)
          ON CONFLICT (url,seen_date) DO NOTHING`).run(id,page.platform,page.url,page.title,page.excerpt,at,date);
        return {status:result.changes ? 'recorded' : 'already_recorded', id, date};
      });
    },
    list({date,limit,offset}) {
      return withDB({}, db => {
        const rows = db.prepare(`SELECT id,platform,url,title,excerpt,seen_at AS seenAt FROM sightings
          WHERE seen_date=? AND withdrawn_at IS NULL ORDER BY seen_at DESC,id LIMIT ? OFFSET ?`).all(date,limit+1,offset);
        return {items:rows.slice(0,limit).map(row=>({...row,seenAt:new Date(row.seenAt).toISOString()})),
          nextOffset:rows.length > limit ? offset + limit : null};
      });
    },
    withdraw(id, at) {
      return withDB({write:true}, db => {
        const row = db.prepare('SELECT url FROM sightings WHERE id=?').get(id);
        if (!row) return {status:'not_found'};
        const result = db.prepare('UPDATE sightings SET withdrawn_at=? WHERE url=? AND withdrawn_at IS NULL').run(at,row.url);
        return {status:result.changes ? 'withdrawn' : 'already_withdrawn', affected:result.changes};
      });
    },
  };
}
