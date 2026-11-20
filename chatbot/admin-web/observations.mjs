import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {jsonFile, loadModule, optional, realDirectory} from './common.mjs';
import {runningConfig} from './inventory.mjs';

const MANAGED_LIMIT = 80;
const compact = x => typeof x === 'string' && /^[\w.:-]{1,110}$/u.test(x) ? x : null;
const millis = n => Number.isSafeInteger(n) && n >= 0 && n <= 8.64e15 ? n : null;
const instant = value => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value))
  ? new Date(value).toISOString() : null;

function dbRead(file, query) {
  try {
    realDirectory(path.dirname(file));
    if (!fs.lstatSync(file).isFile()) return {available: false, reason: 'unavailable'};
    for (const suffix of ['-shm', '-wal', '-journal']) {
      if (fs.existsSync(file + suffix) && !fs.lstatSync(file + suffix).isFile()) return {available: false, reason: 'unavailable'};
    }
    const db = new DatabaseSync(file, {readOnly: true, timeout: 350});
    try {
      db.exec('PRAGMA query_only=ON; BEGIN');
      return {available: true, ...query(db)};
    } finally {
      db.close();
    }
  } catch (error) {
    return {available: false, reason: error.code === 'ENOENT' ? 'missing' : 'unavailable'};
  }
}

export async function memory({sourceRoot, runtimeRoot}, {withContent = false} = {}) {
  const cfg = runningConfig(runtimeRoot);
  if (!cfg) return {available: false, reason: '配置不可读'};
  const plugin = cfg.plugins?.entries?.['kurumi-memory'];
  const continuity = plugin?.config?.continuity;
  const configuredVersion = plugin?.config?.system?.enabled === true ? 'v3' : continuity?.enabled === true ? 'P2' : null;
  if (configuredVersion !== 'P2' || plugin?.enabled === false) {
    return {available: false, version: configuredVersion, reason: '没有可用的 P2 生产投影'};
  }
  try {
    const {accessPolicy} = await loadModule(sourceRoot, 'chatbot/packages/access-control/index.js');
    const {openContinuityStore} = await loadModule(sourceRoot, 'chatbot/packages/memory-continuity/store.js');
    const owner = accessPolicy(cfg).subjects.find(row => row.role === 'owner');
    const workspace = path.join(runtimeRoot, 'workspace');
    // A configured path elsewhere is not a second memory source for this console.
    if (cfg.agents?.entries?.main?.workspace && cfg.agents.entries.main.workspace !== workspace) {
      return {available: false, version: 'P2', reason: '运行工作区不在已配置的运行根'};
    }
    const store = openContinuityStore({workspace, ownerId: owner.qq, readonly: true});
    let data;
    try { data = store.read(); } finally { store.close(); }
    const now = Date.now(), valid = data.summaries.filter(row => Date.parse(row.expiresAt) > now);
    const row = value => ({
      id: value.id, kind: value.kind, createdAt: value.createdAt, updatedAt: value.updatedAt, expiresAt: value.expiresAt,
      source: value.source.origin, ...(withContent ? {text: value.text} : {}),
    });
    return {
      available: true, version: 'P2', revision: data.revision, generation: data.generation,
      facts: data.facts.length, summaries: valid.length, expired: data.summaries.length - valid.length,
      ttl: continuity.summaryTtlDays ?? 7,
      ...(withContent ? {factItems: data.facts.map(row), summaryItems: valid.map(row)} : {}),
    };
  } catch {
    return {available: false, version: 'P2', reason: '记忆库缺失、正在占用或不符合当前契约'};
  }
}

const tableCount = (db, table) => db.prepare('SELECT count(*) AS n FROM ' + table).get().n;

export function operations({runtimeRoot}, group) {
  const root = part => path.join(runtimeRoot, part);
  const config = runningConfig(runtimeRoot);
  if (group === 'cron') return dbRead(root('state/openclaw.sqlite'), db => ({
    total: tableCount(db, 'cron_jobs'),
    rows: db.prepare('SELECT job_id id, name, enabled, payload_kind payload, state_json state FROM cron_jobs ORDER BY enabled DESC, sort_order, job_id LIMIT ?').all(MANAGED_LIMIT).map(row => {
      const state = optional(() => JSON.parse(row.state)) ?? {};
      return {id: compact(row.id), name: typeof row.name === 'string' ? row.name.slice(0, 120) : null,
        type: compact(row.payload), enabled: Boolean(row.enabled), status: compact(state.lastStatus),
        delivery: compact(state.lastDeliveryStatus), last: millis(state.lastRunAtMs), next: millis(state.nextRunAtMs)};
    }),
  }));
  if (group === 'runs') return dbRead(root('state/openclaw.sqlite'), db => ({
    total: tableCount(db, 'task_runs'),
    rows: db.prepare('SELECT task_id id, runtime, task_kind kind, agent_id agent, status, delivery_status delivery, created_at created, ended_at ended, run_id runId FROM task_runs ORDER BY created_at DESC LIMIT ?').all(MANAGED_LIMIT).map(row => ({
      id: compact(row.id), type: compact(row.runtime), kind: compact(row.kind), agent: compact(row.agent), status: compact(row.status),
      delivery: compact(row.delivery), created: millis(row.created), ended: millis(row.ended), runId: compact(row.runId),
    })),
  }));
  if (group === 'reminders') return dbRead(root('state/personal-reminders/reminders.sqlite'), db => ({
    total: tableCount(db, 'reminders'),
    rows: db.prepare('SELECT reminder_id id, status, scheduled_at_utc scheduled, failure_code code FROM reminders ORDER BY scheduled_at_utc DESC LIMIT ?').all(MANAGED_LIMIT).map(row => ({...row, id: compact(row.id), status: compact(row.status), code: compact(row.code)})),
  }));
  if (group === 'mail') return dbRead(root('state/kurumi-mail/mail.sqlite'), db => ({
    total: tableCount(db, 'mail_drafts'),
    rows: db.prepare('SELECT draft_id id, status, created_at_utc created, sent_at_utc sent FROM mail_drafts ORDER BY created_at_utc DESC LIMIT ?').all(MANAGED_LIMIT).map(row => ({...row, id: compact(row.id), status: compact(row.status)})),
  }));
  if (group === 'coding') {
    const configured = config?.plugins?.entries?.['kurumi-coding']?.config?.root;
    if (typeof configured !== 'string' || !path.isAbsolute(configured)) return {available: false, reason: 'not_configured'};
    return dbRead(path.join(configured, 'coding.sqlite'), db => ({
      total: tableCount(db, 'coding_tasks'),
      rows: db.prepare(`SELECT id, json_extract(facts, '$.status') status, json_extract(facts, '$.projectId') project,
        json_extract(facts, '$.createdAt') created FROM coding_tasks ORDER BY created DESC, id LIMIT ?`).all(MANAGED_LIMIT)
        .map(row => ({...row, id: compact(row.id), status: compact(row.status), project: compact(row.project)})),
    }));
  }
  if (group === 'documents' || group === 'papers') {
    const configured = config?.plugins?.entries?.['kurumi-papers']?.config?.root;
    const directory = path.join(typeof configured === 'string' && path.isAbsolute(configured) ? configured : root('documents'),
      group === 'documents' ? 'records' : 'jobs');
    try {
      realDirectory(directory);
      const matches = group === 'papers' ? /^job_[a-f0-9]{24}\.json$/u : /^(doc|pdf)_[a-f0-9]{32}\.json$/u;
      const entries = fs.readdirSync(directory, {withFileTypes: true}).filter(row => row.isFile() && matches.test(row.name));
      if (group === 'papers') {
        const rows = entries.map(row => [row.name, optional(() => fs.lstatSync(path.join(directory, row.name)).mtimeMs) ?? 0])
          .sort(([a, timeA], [b, timeB]) => timeB - timeA || a.localeCompare(b)).slice(0, MANAGED_LIMIT)
          .map(([file]) => {
            const job = optional(() => jsonFile(directory, file, 1024 * 1024));
            if (job?.id !== file.slice(0, -5)) return null;
            return {id: job.id, document: compact(job.documentId), status: compact(job.status),
              delivery: compact(job.delivery?.status), updated: instant(job.updatedAt)};
          }).filter(Boolean);
        return {available: true, total: entries.length, rows};
      }
      const files = entries
        .map(row => ({id: row.name.slice(0, -5), type: row.name.startsWith('pdf_') ? 'PDF' : '文档'}))
        .sort((a, b) => a.id.localeCompare(b.id));
      return {available: true, total: files.length, rows: files.slice(0, MANAGED_LIMIT)};
    } catch (error) {
      return {available: false, reason: error.code === 'ENOENT' ? 'missing' : 'unavailable'};
    }
  }
  throw Error('Unexpected operations group');
}
