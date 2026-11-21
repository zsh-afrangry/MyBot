import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {isAbsolute, join} from 'node:path';
import {businessFeedback} from '../feedback-core/index.js';
import {readQqCronFeedback} from '../qq-delivery/cron-text-feedback.js';
import {messageText, readHostRecords} from '../session-records/index.js';
import {database} from './log-query-diagnostics.mjs';
import {normalizeToolResult} from './log-query-result.mjs';

const weatherTool = 'personal_weather_get_brief';
const listDeclaration = 'kurumi.reminder-list.daily:';
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const segmentPreviewLimit = 20;
const localMinute = ms => new Date(ms + 8 * 3600000).toISOString().slice(0, 16);
const digestHash = text => createHash('sha256').update(text.trim()).digest('hex');

function readListSlot(runtimeRoot, slot, at, ownerId, now) {
  return database(join(runtimeRoot, 'state', 'personal-reminder-list', 'list.sqlite'), db => {
    const settings = db.prepare('SELECT owner_id, enabled, times_json FROM settings WHERE singleton=1').get();
    if (settings?.owner_id !== ownerId) return {};
    const ledger = db.prepare('SELECT status, text, cron_job_id FROM deliveries WHERE slot_key=? AND slot_ms=?').get(slot, at);
    if (!ledger) {
      if (at > now && (!settings.enabled || !JSON.parse(settings.times_json).includes(slot.slice(11)))) {
        return {shouldSend: 'no', bodyStatus: 'not_generated', reason: 'schedule_inactive'};
      }
      return {};
    }
    const observations = db.prepare(`SELECT action, details_json FROM audit
      WHERE action IN ('digest.prepared','digest.skipped','notice.settings_changed','notice.generation_failed','notice.generated')
        AND json_extract(details_json,'$.slotKey')=? ORDER BY id`).all(slot);
    const recorded = observations.at(-1);
    const details = recorded && JSON.parse(recorded.details_json);
    const fact = {jobId: ledger.cron_job_id, listObservation: recorded?.action};
    if (ledger.status === 'skipped' && recorded?.action === 'digest.skipped' && details.count === 0) {
      return {...fact, shouldSend: 'no', bodyStatus: 'not_generated', reason: 'empty_list'};
    }
    if (ledger.status === 'skipped' && recorded?.action === 'notice.settings_changed') {
      return {...fact, shouldSend: 'no', bodyStatus: 'not_generated', reason: 'settings_changed'};
    }
    if (recorded?.action === 'notice.generation_failed') {
      return {...fact, shouldSend: 'yes', bodyStatus: 'failed', reason: 'generation_failed'};
    }
    if (recorded?.action === 'notice.generated' && ledger.text?.trim()
      && (details.bodySha256 === undefined || details.bodySha256 === createHash('sha256').update(ledger.text).digest('hex'))) {
      return {...fact, shouldSend: 'yes', bodyStatus: 'generated', digest: digestHash(ledger.text)};
    }
    return observations.some(row => row.action === 'digest.prepared') ? {...fact, shouldSend: 'yes'} : fact;
  });
}

function readOccurrence(db, job, at, agentTurn) {
  // The released OpenClaw slot ID encodes the original planned time. The
  // actual start in the same record supplies the distinct QQ delivery ID.
  const receiptId = 'cron-slot-v1.' + Buffer.from(JSON.stringify([job.store_key, job.job_id, at])).toString('base64url');
  const receipt = db.prepare('SELECT * FROM cron_run_receipts WHERE receipt_id=? AND store_key=? AND job_id=?')
    .get(receiptId, job.store_key, job.job_id);
  const prefix = `cron:${job.job_id}:`;
  const history = db.prepare(`SELECT task_id, started_at, ended_at, child_session_key, detail_json, run_id
    FROM task_runs WHERE runtime='cron' AND source_id=? AND run_id GLOB ?`).all(job.job_id, prefix + '*:' + receiptId)
    .filter(row => row.started_at >= at && row.run_id === prefix + row.started_at + ':' + receiptId);
  const terminal = history.length === 1 ? history[0] : undefined;
  const detail = terminal && JSON.parse(terminal.detail_json);
  const record = detail?.kind === 'cron-run' && detail.storeKey === job.store_key
    && detail.runAtMs === terminal.started_at && (!receipt || receipt.started_at_ms === terminal.started_at);
  // Native agentTurn uses the prompt execution start in its delivery ID. That
  // start falls within its exclusive Cron occurrence, including on queue replay.
  const deliveryWindowEnd = record && agentTurn && terminal.ended_at > terminal.started_at &&
    !db.prepare(`SELECT 1 FROM task_runs WHERE runtime='cron' AND source_id=? AND task_id<>?
      AND started_at<? AND (ended_at IS NULL OR ended_at>?) LIMIT 1`)
      .get(job.job_id, terminal.task_id, terminal.ended_at, terminal.started_at) ? terminal.ended_at : undefined;
  return {
    cronJobId: job.job_id,
    scheduleStatus: record ? 'finished' : receipt ? 'claimed' : JSON.parse(job.state_json).nextRunAtMs === at && job.enabled
      ? 'scheduled' : 'unknown',
    ...(record && {runId: prefix + terminal.started_at, started: terminal.started_at, ended: terminal.ended_at,
      sessionKey: terminal.child_session_key, deliveryWindowEnd, detail}),
  };
}

function findOccurrence(root, query, ownerId, listJobId) {
  const list = query.broadcast === 'reminder-list';
  const slot = localMinute(query.at);
  return database(join(root, 'state', 'openclaw.sqlite'), db => {
    let jobs = list
      ? db.prepare('SELECT * FROM cron_jobs WHERE declaration_key=?').all(listDeclaration + slot.slice(11))
      : db.prepare("SELECT * FROM cron_jobs WHERE payload_kind='agentTurn'").all();
    jobs = jobs.filter(row => {
      if (query.cronJobId && row.job_id !== query.cronJobId) return false;
      const job = JSON.parse(row.job_json);
      if (job.delivery?.channel !== 'kurumi-qq' || job.delivery?.to !== 'user:' + ownerId
        || ![undefined, 'default'].includes(job.delivery.accountId) || job.delivery.mode !== 'announce') return false;
      return list ? job.payload?.kind === 'command' : job.agentId === 'main' && job.sessionTarget === 'isolated'
        && job.schedule?.kind === 'cron' && job.payload?.toolsAllow?.includes(weatherTool);
    });
    if (listJobId && (!query.cronJobId || query.cronJobId === listJobId) && !jobs.some(row => row.job_id === listJobId)) {
      // A removed list job can still be named by the owner's delivery ledger.
      jobs.push({job_id: listJobId, store_key: join(root, 'cron', 'jobs.json'), state_json: '{}'});
    }
    const matches = jobs.map(job => readOccurrence(db, job, query.at, !list)).filter(run => run.scheduleStatus !== 'unknown');
    if (matches.length > 1) return {reason: 'ambiguous_schedule', cronJobIds: matches.map(run => run.cronJobId)};
    return matches[0] ?? {};
  });
}

function weatherResult(root, run) {
  const id = run.detail?.sessionId;
  if (!uuid.test(id ?? '') || run.sessionKey !== `agent:main:cron:${run.cronJobId}:run:${id}`) return {};
  const {rows} = readHostRecords(join(root, 'agents', 'main', 'agent', 'openclaw-agent.sqlite'), {
    sessionId: id, from: run.started, to: run.ended, archives: true,
  });
  const message = rows.map(row => row.record.message).filter(value => ['toolResult', 'tool'].includes(value?.role))
    .findLast(value => {
      if ((value.toolName ?? value.name) === weatherTool) return true;
      if (!['tool_call', 'dispatch_action'].includes(value.toolName ?? value.name)) return false;
      let wrapper;
      try { wrapper = JSON.parse(messageText(value.content)); } catch { return false; }
      const name = wrapper?.tool?.name ?? wrapper?.tool ?? value.details?.tool?.name;
      return typeof name === 'string' && name.split(':').at(-1) === weatherTool;
    });
  if (!message) return {};
  const result = normalizeToolResult(message);
  if (result.businessOutcome === 'error' && result.summary.ok === false && !result.resultConflict) {
    return {bodyStatus: 'failed', weatherDataStatus: 'unavailable', reason: 'weather_tool_failed', code: result.summary.code};
  }
  if (result.businessOutcome === 'ok' && result.summary.ok === true && !result.resultConflict) {
    return {bodyStatus: run.detail.status === 'ok' && hasNotice(run) ? 'generated' : 'unknown', weatherDataStatus: 'available'};
  }
  return {};
}

function hasNotice(run) {
  const summary = run.detail?.summary;
  return typeof summary === 'string' && !!summary.trim() && !/^NO_REPLY$/iu.test(summary.trim());
}

function readNotification(channel, run, business, broadcast) {
  const target = run.detail?.delivery?.resolved;
  const routeMatches = !target || (target.channel === 'kurumi-qq' && [channel.ownerId, 'user:' + channel.ownerId].includes(target.to)
    && [undefined, 'default'].includes(target.accountId));
  const deliveryBound = run.runId && (broadcast === 'reminder-list' || run.deliveryWindowEnd !== undefined);
  const segments = deliveryBound && routeMatches && isAbsolute(channel.stateDir ?? '')
    ? readEvidence(() => readQqCronFeedback(channel.stateDir, run.runId, channel.ownerId, run.deliveryWindowEnd), []) : [];
  const first = segments[0];
  const complete = first && segments.length === first.parts
    && segments.every((part, i) => part.parts === first.parts && part.part === i + 1 && part.deliveryKey === first.deliveryKey);
  const accepted = segments.filter(segment => segment.platformStatus === 'accepted' && /^-?[1-9]\d*$/u.test(segment.messageId));
  const suppressed = routeMatches && ['empty', 'silent'].includes(run.detail?.deliverySuppressionReason) && !segments.length;
  let platformStatus = 'unknown';
  if (complete && new Set(accepted.map(segment => segment.messageId)).size === segments.length) platformStatus = 'accepted';
  else if (accepted.length) platformStatus = 'partially_accepted';
  else if (complete && segments.every(part => ['rejected', 'not_attempted'].includes(part.platformStatus))) {
    platformStatus = segments.some(part => part.platformStatus === 'rejected') ? 'rejected' : 'not_attempted';
  } else if (suppressed || (business.reason === 'schedule_inactive' && !run.runId)) platformStatus = 'not_attempted';
  let kind = 'unknown';
  if (platformStatus === 'not_attempted' && !segments.length) kind = 'none';
  else if (routeMatches && (hasNotice(run) || segments.length)) {
    if (run.detail?.status === 'error' || business.bodyStatus === 'failed') kind = 'error';
    else if (business.bodyStatus === 'generated'
      && (broadcast === 'weather' || (hasNotice(run) && business.digest === digestHash(run.detail.summary)))) {
      kind = 'business';
    }
  }
  return {kind, platformStatus, hostDeliveryStatus: routeMatches ? run.detail?.deliveryStatus ?? 'unknown' : 'unknown',
    ...(first && {deliveryRunId: first.runId, totalParts: first.parts, acceptedParts: accepted.length}),
    ...(segments.length > segmentPreviewLimit && {segmentsTruncated: true}), segments: segments.slice(0, segmentPreviewLimit)};
}

function readEvidence(read, fallback = {}) {
  try { return read(); } catch { return fallback; }
}

export function readDailyFeedback(runtimeRoot, query, now = Date.now()) {
  const {broadcast, at} = query;
  const list = broadcast === 'reminder-list';
  const channel = readEvidence(() => JSON.parse(readFileSync(join(runtimeRoot, 'openclaw.json'), 'utf8')).channels?.['kurumi-qq']) ?? {};
  const ownerKnown = typeof channel.ownerId === 'string' && /^\d{5,12}$/u.test(channel.ownerId);
  const listFact = ownerKnown && list ? readEvidence(() => readListSlot(runtimeRoot, localMinute(at), at, channel.ownerId, now)) : {};
  const run = ownerKnown ? readEvidence(() => findOccurrence(runtimeRoot, query, channel.ownerId, listFact.jobId)) : {};
  const listMatches = !query.cronJobId || (listFact.jobId ?? run.cronJobId) === query.cronJobId;
  const business = list ? (listMatches ? listFact : {}) : readEvidence(() => weatherResult(runtimeRoot, run));
  const scheduleStatus = run.scheduleStatus ?? (business.reason === 'schedule_inactive' ? 'inactive' : 'unknown');
  const shouldSend = business.shouldSend ?? (!list && run.scheduleStatus ? 'yes' : 'unknown');
  const bodyStatus = business.bodyStatus ?? 'unknown';
  const evidence = {scheduledAt: new Date(at).toISOString(), scheduleStatus, shouldSend, bodyStatus,
    cronJobId: run.cronJobId ?? business.jobId, runId: run.runId, runAtMs: run.started, cronStatus: run.detail?.status,
    reason: run.reason ?? business.reason, cronJobIds: run.cronJobIds,
    listObservation: business.listObservation, weatherDataStatus: business.weatherDataStatus, code: business.code};
  const status = ({generated: 'succeeded', failed: 'failed', not_generated: 'skipped'})[bodyStatus] ?? 'unknown';
  return {schemaVersion: 1, view: 'daily-feedback', total: 1, shown: 1,
    feedback: businessFeedback(broadcast + '.daily', status, evidence), notification: readNotification(channel, run, business, broadcast)};
}
