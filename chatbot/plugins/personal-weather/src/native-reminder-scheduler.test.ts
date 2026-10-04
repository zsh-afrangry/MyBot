import {mkdtempSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {describe,it,expect,vi} from 'vitest';
import {createNativeReminderScheduler} from './native-reminder-scheduler.js';
import type {ReminderStore} from './reminder-store.js';
const id='12345678-1234-4234-8234-123456789abc',job='abcdef12-1234-4234-8234-123456789abc';
function fixture(){const dir=mkdtempSync(join(tmpdir(),'reminder-native-'));mkdirSync(join(dir,'dist'));writeFileSync(join(dir,'dist/reminder-cli.js'),'');const db=new DatabaseSync(join(dir,'reminders.sqlite'));db.exec('CREATE TABLE reminders(reminder_id TEXT,cron_job_id TEXT,scheduled_at_utc INTEGER,delivery_channel TEXT,delivery_to TEXT,delivery_account_id TEXT,event_key TEXT,status TEXT)');db.prepare('INSERT INTO reminders VALUES(?,?,?,?,?,?,?,?)').run(id,job,1900000000,'kurumi-qq','user:365999865','default','event-key','scheduling');const request=vi.fn(async(_method:string,_params:Record<string,unknown>)=>({job:{id:job}}));return {dir,db,request,adapter:createNativeReminderScheduler({stateDirectory:dir,ownerId:'365999865',port:18890,pluginRoot:dir,request}),close(){db.close();rmSync(dir,{recursive:true,force:true});}};}
describe('typed native reminder service',()=>{
 it('reads delivered history through public RPC after one-shot job deletion',async()=>{
  const f=fixture();try{
   const delivered=vi.fn(()=>true),failed=vi.fn();
   const store={getNowUtc:()=>1900000300,listReconciliationReminders:()=>[{reminderId:id,cronJobId:job,eventKey:'event-key',status:'delivering',scheduledAtUtc:1900000000,dispatchedAtUtc:1900000000}],getCurrentDeclarationKey:()=>undefined,markReminderDelivered:delivered,markReminderFailed:failed} as unknown as ReminderStore;
   const request=vi.fn(async(method:string)=>method==='cron.list'?{jobs:[],hasMore:false}:{entries:[{status:'ok',deliveryStatus:'delivered',delivered:true,runAtMs:1900000000000}]});
   const adapter=createNativeReminderScheduler({stateDirectory:f.dir,ownerId:'365999865',port:18890,pluginRoot:f.dir,request});
   expect((await adapter.reconcile!(store)).delivered).toBe(1);expect(delivered).toHaveBeenCalledOnce();expect(failed).not.toHaveBeenCalled();
   request.mockRejectedValueOnce(Error('Host offline'));delivered.mockClear();
   expect((await adapter.reconcile!(store)).warnings).toEqual(['gateway_snapshot_unavailable']);expect(delivered).not.toHaveBeenCalled();expect(failed).not.toHaveBeenCalled();
  }finally{f.close();}
 });
 it('builds only fixed command and exact persisted owner delivery',async()=>{const f=fixture();try{await f.adapter.add({reminderId:id,scheduledAtUtc:1900000000,eventKey:'event-key',delivery:{channel:'kurumi-qq',to:'user:365999865',accountId:'default'}});expect(f.request).toHaveBeenCalledOnce();const params=f.request.mock.calls[0]?.[1] as any;expect(params.payload.cwd).toBe(f.dir);expect(params.delivery.to).toBe('user:365999865');expect(params.payload.argv.slice(1)).toEqual(['dist/reminder-cli.js','deliver','--id',id]);}finally{f.close();}});
 it('refuses other targets, wrong times and non-domain job IDs before Gateway I/O',async()=>{const f=fixture();try{for(const to of ['group:365999865','user:123456'])await expect(f.adapter.add({reminderId:id,scheduledAtUtc:1900000000,eventKey:'event-key',delivery:{channel:'kurumi-qq',to,accountId:'default'}})).rejects.toThrow();await expect(f.adapter.remove({jobId:'00000000-0000-4000-8000-000000000000'})).rejects.toThrow();await expect(f.adapter.update!({jobId:job,scheduledAtUtc:1900000001})).rejects.toThrow();expect(f.request).not.toHaveBeenCalled();}finally{f.close();}});
 it('manages only a job bound to an eligible owner domain row',async()=>{const f=fixture();try{f.db.prepare("UPDATE reminders SET status='scheduled'").run();await f.adapter.update!({jobId:job,scheduledAtUtc:1900000000});await f.adapter.remove({jobId:job});expect(f.request).toHaveBeenCalledTimes(2);f.db.prepare("UPDATE reminders SET delivery_to='user:123456'").run();await expect(f.adapter.remove({jobId:job})).rejects.toThrow('Unowned');}finally{f.close();}});
});
