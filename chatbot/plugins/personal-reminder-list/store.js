// SQLite facts, invariants and delivery ledger. No chat admission rules.
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync, readFileSync, chmodSync} from 'node:fs';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {TIMEZONE, DEFAULT_TIMES, localTime, normalizeTimes, dueSlot} from './time.js';
import {normalize, item} from './model.js';
import {formatDigest} from './formatter.js';

export class ListStore {
  constructor({root, ownerId, defaultTimes = DEFAULT_TIMES, now = Date.now}) {
    if (!/^\d{5,12}$/.test(ownerId)) throw Error('Invalid owner');
    this.now = now;
    const dir = join(root, 'state', 'personal-reminder-list');
    mkdirSync(dir, {recursive: true, mode: 0o700});
    this.file = join(dir, 'list.sqlite');
    this.db = new DatabaseSync(this.file);
    try {
      chmodSync(this.file, 0o600);
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;');
      this.transaction(() => {
        const version = this.db.prepare('PRAGMA user_version').get().user_version;
        if (version === 0) this.db.exec(readFileSync(new URL('./sql/001_init.sql', import.meta.url), 'utf8'));
        else if (version !== 1) throw Error('Unsupported reminder-list schema');
      });
      if (!this.db.prepare('SELECT singleton FROM settings WHERE singleton=1').get()) {
        this.db.prepare('INSERT OR IGNORE INTO settings VALUES(1,?,?,1,1,?)').run(ownerId, JSON.stringify(normalizeTimes(defaultTimes)), this.now());
      }
      if (this.settings().ownerId !== ownerId) throw Error('Reminder-list owner changed; explicit migration required');
    } catch (error) {this.db.close(); throw error;}
  }
  close() { this.db.close(); }
  transaction(work) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  settings() {
    const r = this.db.prepare('SELECT * FROM settings WHERE singleton=1').get();
    return {ownerId: r.owner_id, times: JSON.parse(r.times_json), enabled: !!r.enabled, version: r.version, timezone: TIMEZONE};
  }
  audit(action, itemId, details, context = {}) {
    this.db.prepare('INSERT INTO audit(at_ms,action,item_id,qq_message_id,session_key,run_id,details_json) VALUES(?,?,?,?,?,?,?)')
      .run(this.now(), action, itemId ?? null, context.messageId ?? null, context.sessionKey ?? null, context.runId ?? null, JSON.stringify(details));
  }
  expire() {
    return this.transaction(() => {
      const rows = this.db.prepare("SELECT * FROM items WHERE status='active' AND deadline_ms<=?").all(this.now());
      for (const row of rows) {
        this.db.prepare("UPDATE items SET status='expired',version=version+1,updated_ms=? WHERE id=? AND status='active'").run(this.now(), row.id);
        this.audit('expired', row.id, {ddl: row.ddl, previousVersion: row.version});
      }
      return rows.length;
    });
  }
  get({history = false, query = ''} = {}) {
    this.expire();
    if (typeof history !== 'boolean' || typeof query !== 'string' || query.length > 200) throw Error('Invalid list query');
    const rows = this.db.prepare(`SELECT * FROM items ${history ? '' : "WHERE status='active'"} ORDER BY deadline_ms IS NULL,deadline_ms,created_ms,id`).all();
    return {ok: true, now: localTime(this.now()), timezone: TIMEZONE, settings: this.settings(), items: rows.filter(r => !query || normalize(r.title).includes(normalize(query)) || r.id === query).map(item)};
  }
  select(args) {
    const all = this.db.prepare('SELECT * FROM items').all();
    if (!args.id && (!args.query || typeof args.query !== 'string' || args.query.trim().length < 2)) throw Error('请提供事项 ID 或至少两个字的标题');
    const matches = args.id ? all.filter(r => r.id === args.id) : all.filter(r => normalize(r.title).includes(normalize(args.query)));
    if (matches.length !== 1) return {ok: false, error: {code: matches.length ? 'ambiguous_target' : 'not_found', message: matches.length ? '有多个匹配事项，请说明标题或 ID' : '未找到事项'}, candidates: matches.map(item)};
    const row = matches[0];
    if (!Number.isSafeInteger(args.expectedVersion) || args.expectedVersion !== row.version) throw Error('事项版本已变化或未提供版本；先查询后重试');
    return row;
  }
  request(key) {
    return this.db.prepare('SELECT * FROM requests WHERE message_key=?').get(key);
  }
  recordRequest(key, payloadHash, result) {
    this.db.prepare('INSERT INTO requests VALUES(?,?,?,?)').run(key, payloadHash, JSON.stringify(result), this.now());
  }
  // Mutation methods are internal domain operations. service.js supplies the
  // enclosing transaction, idempotency and policy checks before calling them.
  changeSchedule(args, context) {
    const times = args.action === 'schedule' ? normalizeTimes(args.times) : this.settings().times;
    const enabled = args.action === 'pause' ? 0 : args.action === 'resume' ? 1 : Number(this.settings().enabled);
    this.db.prepare('UPDATE settings SET times_json=?,enabled=?,version=version+1,updated_ms=? WHERE singleton=1').run(JSON.stringify(times), enabled, this.now());
    const result = {ok: true, action: args.action, settings: this.settings()};
    this.audit(args.action, null, {settings: result.settings}, context);
    return result;
  }
  addItem(fields, context) {
    const {title, content, note, ddl, deadlineMs} = fields;
    const count = this.db.prepare("SELECT COUNT(*) n FROM items WHERE status='active'").get().n;
    if (count >= 100) throw Error('有效事项上限为 100，请先完成或作废已有事项');
    if (this.db.prepare("SELECT id FROM items WHERE status='active' AND title=?").get(title)) throw Error('已有相同标题的有效事项；请查询或使用可区分的标题');
    const id = randomBytes(6).toString('hex'), now = this.now();
    this.db.prepare("INSERT INTO items VALUES(?,?,?,?,?,?,'active',1,?,?)").run(id, title, content, note, ddl, deadlineMs, now, now);
    const result = {ok: true, action: 'add', item: item(this.db.prepare('SELECT * FROM items WHERE id=?').get(id))};
    this.audit('add', id, {after: result.item}, context);
    return result;
  }
  changeItem(args, row, fields, context) {
    const {title, content, note, ddl, deadlineMs, status} = fields;
    if (args.action === 'reopen' && this.db.prepare("SELECT COUNT(*) n FROM items WHERE status='active'").get().n >= 100 && row.status !== 'active') throw Error('有效事项上限为 100');
    if (['update', 'reopen'].includes(args.action) && status === 'active' && this.db.prepare("SELECT id FROM items WHERE status='active' AND title=? AND id<>?").get(title, row.id)) throw Error('已有相同标题的有效事项');
    this.db.prepare('UPDATE items SET title=?,content=?,note=?,ddl=?,deadline_ms=?,status=?,version=version+1,updated_ms=? WHERE id=? AND version=?').run(title, content, note, ddl, deadlineMs, status, this.now(), row.id, row.version);
    const result = {ok: true, action: args.action, item: item(this.db.prepare('SELECT * FROM items WHERE id=?').get(row.id))};
    this.audit(args.action, row.id, {before: item(row), after: result.item}, context);
    return result;
  }
  claimDigest(time) {
    this.expire();
    return this.transaction(() => {
      const settings = this.settings(), slot = dueSlot(time, this.now());
      if (!settings.enabled || !settings.times.includes(time) || !slot) return undefined;
      if (this.db.prepare('SELECT slot_key FROM deliveries WHERE slot_key=?').get(slot.key)) return undefined;
      const items = this.db.prepare("SELECT * FROM items WHERE status='active' ORDER BY deadline_ms IS NULL,deadline_ms,created_ms,id").all().map(item);
      const output = formatDigest(items, slot.at), status = output ? 'prepared' : 'skipped';
      this.db.prepare('INSERT INTO deliveries VALUES(?,?,?,?,?,?,?,NULL)').run(slot.key, slot.at, settings.version, status, JSON.stringify(items.map(i => i.id)), output, this.now());
      this.audit('digest.' + status, null, {slotKey: slot.key, count: items.length});
      return {slotKey: slot.key, text: output, count: items.length};
    });
  }
  observeDeliveries(jobId, runs) {
    this.transaction(() => {
      for (const row of this.db.prepare("SELECT * FROM deliveries WHERE status IN ('prepared','failed','unknown')").all()) {
        const time = row.slot_key.slice(11);
        const matches = runs.filter(r => r.runAtMs >= row.slot_ms && r.runAtMs < row.slot_ms + 300000);
        const run = matches.find(r => r.delivered === true || r.deliveryStatus === 'delivered')
          ?? matches.sort((a, b) => a.runAtMs - b.runAtMs)[0];
        if (!run || jobId.time !== time) continue;
        const status = run.delivered === true || run.deliveryStatus === 'delivered' ? 'delivered'
          : run.status === 'error' || run.deliveryStatus === 'failed' ? 'failed' : 'unknown';
        if (row.status === status && row.cron_job_id === jobId.id) continue;
        this.db.prepare('UPDATE deliveries SET status=?,updated_ms=?,cron_job_id=? WHERE slot_key=?').run(status, this.now(), jobId.id, row.slot_key);
        this.audit('digest.' + status, null, {slotKey: row.slot_key, cronJobId: jobId.id});
      }
    });
  }
  markUnobserved() {
    this.transaction(() => {
      for (const row of this.db.prepare("SELECT * FROM deliveries WHERE status='prepared' AND slot_ms<?").all(this.now() - 300000)) {
        this.db.prepare("UPDATE deliveries SET status='unknown',updated_ms=? WHERE slot_key=?").run(this.now(), row.slot_key);
        this.audit('digest.unknown', null, {slotKey: row.slot_key, reason: 'no_matching_cron_observation'});
      }
    });
  }
}
