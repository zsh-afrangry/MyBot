// Durable ingress deduplication and bounded egress receipts. Never retry unknown sends.
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
export class Ledger {
 constructor(dir){
  fs.mkdirSync(dir,{recursive:true,mode:0o700});this.db=new DatabaseSync(path.join(dir,'channel.sqlite'));
  this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS inbound(id TEXT PRIMARY KEY, status TEXT NOT NULL, at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS outbound(id TEXT PRIMARY KEY, status TEXT NOT NULL, message_id TEXT, at INTEGER NOT NULL);');
  this.db.exec('BEGIN IMMEDIATE');
  try {if(!this.db.prepare('PRAGMA table_info(inbound)').all().some(x=>x.name==='origin'))this.db.exec("ALTER TABLE inbound ADD COLUMN origin TEXT NOT NULL DEFAULT 'unknown'");this.db.exec('COMMIT');}
  catch(e){this.db.exec('ROLLBACK');throw e;}
 }
 admit(id,origin='unknown'){if(!['unknown','onebot','synthetic'].includes(origin))throw Error('Invalid ingress origin');return this.db.prepare("INSERT OR IGNORE INTO inbound(id,status,at,origin) VALUES(?,'admitted',?,?)").run(id,Date.now(),origin).changes===1;}
 finish(id,status){this.db.prepare('UPDATE inbound SET status=? WHERE id=?').run(status,id);}
 reserve(id,limit,dailyLimit=120,quota,initialReceipt=null,onReserve){
  this.db.exec('BEGIN IMMEDIATE');try{
   const prior=this.db.prepare('SELECT * FROM outbound WHERE id=?').get(id);
   if(prior){this.db.exec('COMMIT');return prior;}
   const n=this.db.prepare('SELECT COUNT(*) n FROM outbound').get().n;
   if(limit!==undefined&&(!Number.isInteger(limit)||limit<0||n>=limit))throw Error('QQ authorized send budget exhausted');
   const now=Date.now(),since=now-86400000;
   const recent=this.db.prepare('SELECT COUNT(*) n FROM outbound WHERE at>=?').get(since).n;
   if(!Number.isInteger(dailyLimit)||dailyLimit<1||recent>=dailyLimit)throw Error('QQ rolling daily send budget exhausted');
   if(quota){
    const {prefix,limit}=quota;
    if(typeof prefix!=='string'||!prefix||!id.startsWith(prefix)||!Number.isInteger(limit)||limit<1)throw Error('Invalid QQ send quota');
    const used=this.db.prepare('SELECT COUNT(*) n FROM outbound WHERE at>=? AND substr(id,1,?)=?').get(since,prefix.length,prefix).n;
    if(used>=limit)throw Object.assign(Error('QQ rolling category send budget exhausted'),{code:'qq_category_daily_limit'});
   }
   onReserve?.(this.db);
   this.db.prepare("INSERT INTO outbound VALUES(?,'unknown',?,?)").run(id,initialReceipt,now);this.db.exec('COMMIT');return null;
  }catch(e){this.db.exec('ROLLBACK');throw e;}
 }
 sent(id,messageId){this.db.prepare("UPDATE outbound SET status='sent',message_id=? WHERE id=?").run(String(messageId),id);}
 failed(id){this.db.prepare("UPDATE outbound SET status='failed' WHERE id=?").run(id);}
 close(){this.db.close();}
}
