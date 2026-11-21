import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { realpathSync, statSync } from 'node:fs';
import { createManagedCron, type CronRequest } from '@kurumi/host-scheduling';
import { buildReminderCronAddParams, buildReminderCronUpdateParams } from './reminder-gateway.js';
import type { ReminderCronScheduler } from './reminders.js';
import { applyReminderObservation, type ReminderReconcileResult } from './reminder-reconciler.js';

type NativeJob = {
  id: string;
  declarationKey?: string;
  enabled?: boolean;
  schedule?: {kind?: string; at?: string};
  delivery?: {mode?: string; channel?: string; to?: string; accountId?: string};
  failureAlert?: unknown;
  state?: {lastStatus?: string; lastDeliveryStatus?: string; lastDelivered?: boolean; lastError?: string};
};
type NativeRun = {
  jobId?: string;
  status?: string;
  deliveryStatus?: string;
  delivered?: boolean;
  runAtMs?: number;
  error?: string;
  deliveryError?: string;
};

/** Trusted native service, never a generic model-facing Gateway tool.
 * The operator installs this backend. Every effect must refer to an existing
 * owner-only domain row; command, route and Gateway address are service-owned.
 * No Gateway URL, token, argv or recipient is accepted from tool parameters.
 */
export function createNativeReminderScheduler(options: {
  stateDirectory: string;
  ownerId: string;
  port: number;
  pluginRoot: string;
  request?: CronRequest;
}): ReminderCronScheduler {
  if (!/^[0-9]{5,12}$/u.test(options.ownerId) || !Number.isInteger(options.port)
    || options.port < 1024 || options.port > 65535) throw new Error('Invalid service configuration');
  const pluginRoot=realpathSync(options.pluginRoot);
  if(!statSync(join(pluginRoot,'dist/reminder-cli.js')).isFile())throw new Error('Missing installed reminder runner');
  const cron = createManagedCron<NativeJob, NativeRun>({port: options.port, ...(options.request ? {request: options.request} : {})});
  const read = (column: 'reminder_id' | 'cron_job_id', value: string) => {
    if (!/^[0-9a-f-]{36}$/u.test(value)) throw new Error('Invalid managed reminder identity');
    const db = new DatabaseSync(join(options.stateDirectory,'reminders.sqlite'),{readOnly:true});
    try {
      const row = db.prepare(`SELECT reminder_id, scheduled_at_utc, delivery_channel,
        delivery_to, delivery_account_id, event_key, status FROM reminders WHERE ${column}=?`).get(value);
      if (!row || row.delivery_channel !== 'kurumi-qq' || row.delivery_to !== `user:${options.ownerId}`
        || (row.delivery_account_id !== null && row.delivery_account_id !== 'default')) throw new Error('Unowned reminder');
      return row;
    } finally { db.close(); }
  };
  return {
    async inspectSchedule(reminder, declarationKey) {
      const jobs = await cron.listJobs();
      const candidates = jobs.filter(job => job.id === reminder.cronJobId || job.declarationKey === declarationKey);
      if (!candidates.length) return {status:'absent'};
      const job = candidates[0];
      if (candidates.length !== 1 || !job || (reminder.cronJobId && job.id !== reminder.cronJobId)
        || typeof job.id !== 'string' || !job.id || job.enabled !== true || job.schedule?.kind !== 'at'
        || job.delivery?.mode !== 'announce' || job.delivery.channel !== reminder.delivery.channel
        || job.delivery.to !== reminder.delivery.to
        || (job.delivery.accountId ?? 'default') !== (reminder.delivery.accountId ?? 'default')) {
        return {status:'mismatch'};
      }
      const scheduledAtUtc = Date.parse(job.schedule.at ?? '') / 1000;
      return Number.isSafeInteger(scheduledAtUtc)
        ? {status:'active', cronJobId:job.id, scheduledAtUtc}
        : {status:'mismatch'};
    },
    async inspectRun(reminder) {
      if (!reminder.cronJobId) return undefined;
      const [run] = await cron.runs(reminder.cronJobId, 1);
      if (!run || run.jobId !== reminder.cronJobId || typeof run.runAtMs !== 'number'
        || !Number.isSafeInteger(run.runAtMs) || run.runAtMs < reminder.scheduledAtUtc * 1000) return undefined;
      return {
        cronJobId: reminder.cronJobId,
        runAtMs: run.runAtMs,
        executionStatus: run.status === 'ok' ? 'succeeded' : run.status === 'error' ? 'failed'
          : run.status === 'skipped' ? 'skipped' : 'unknown',
        hostDeliveryStatus: run.deliveryStatus === 'delivered' && run.delivered === true ? 'reported_sent'
          : run.deliveryStatus === 'not-delivered' ? 'not_delivered'
            : run.deliveryStatus === 'not-requested' ? 'not_requested' : 'unknown',
      };
    },
    async reconcile(store,nowUtc=store.getNowUtc()) {
      const reminders=store.listReconciliationReminders();
      const result:ReminderReconcileResult={scanned:reminders.length,jobsAdopted:0,delivered:0,failed:0,warnings:[]};
      if(!reminders.length)return result;
      try {
        const jobs = await cron.listJobs();
        // Fetch every observation before changing domain state. Failed reads never imply delivery failure.
        const observations=[];
        for(const reminder of reminders){
          const key=store.getCurrentDeclarationKey(reminder.reminderId)??reminder.eventKey;
          const job=jobs.find(j=>j.declarationKey===key||j.id===reminder.cronJobId);
          const id=job?.id??reminder.cronJobId;
          const run=id?(await cron.runs(id,1))[0]:undefined;
          observations.push({reminder,job,run,key});
        }
        for(const {reminder,job,run,key} of observations){
          if(job?.declarationKey===key && job.failureAlert!==false)await cron.update(job.id,{failureAlert:false});
          applyReminderObservation(store,reminder,job?{job_id:job.id,declaration_key:job.declarationKey??null,last_run_status:job.state?.lastStatus??null,last_delivery_status:job.state?.lastDeliveryStatus??null,last_delivered:job.state?.lastDelivered===undefined?null:Number(job.state.lastDelivered),last_error:job.state?.lastError??null}:undefined,
            run?{status:run.status??null,delivery_status:run.deliveryStatus??null,delivered:run.delivered===undefined?null:Number(run.delivered),run_at_ms:run.runAtMs??null,error:run.error??null,delivery_error:run.deliveryError??null}:undefined,nowUtc,result);
        }
      }catch{result.warnings.push('gateway_snapshot_unavailable');}
      return result;
    },
    async add(input) {
      const row=read('reminder_id',input.reminderId);
      if(row.status!=='scheduling' || row.scheduled_at_utc!==input.scheduledAtUtc
        || row.event_key!==input.eventKey || input.delivery.channel!=='kurumi-qq'
        || input.delivery.to!==row.delivery_to || (input.delivery.accountId??null)!==row.delivery_account_id)
        throw new Error('Reminder registration does not match approved domain state');
      // The fixed builder obtains executable/cwd from this installed plugin.
      const params=buildReminderCronAddParams(input);
      params.payload={...params.payload as Record<string,unknown>,cwd:pluginRoot,env:{OPENCLAW_GATEWAY_PORT:String(options.port)}};
      return {jobId: await cron.add(params)};
    },
    async update(input) {
      const row=read('cron_job_id',input.jobId);
      if(row.scheduled_at_utc!==input.scheduledAtUtc || !['scheduled','scheduling'].includes(String(row.status)))
        throw new Error('Reminder update does not match approved domain state');
      const {id, patch} = buildReminderCronUpdateParams(input);
      await cron.update(id, patch);
    },
    async remove(input) {
      const row=read('cron_job_id',input.jobId);
      if(!['scheduled','failed'].includes(String(row.status)))throw new Error('Reminder is not cancellable');
      await cron.remove(input.jobId);
    },
  };
}
