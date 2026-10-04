import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {account} from '../../chatbot/plugins/kurumi-qq/src/config.js';
import {onebot} from '../../chatbot/plugins/kurumi-qq/src/transport.js';
const cfg=JSON.parse(fs.readFileSync('/home/afrangry/.openclaw-fusion/openclaw.json'));
const a=account(cfg),db=new DatabaseSync(`${a.stateDir}/channel.sqlite`,{readOnly:true});
const receipts=db.prepare('SELECT * FROM outbound ORDER BY at').all();
for(const r of receipts){if(r.status==='sent'){try{const m=await onebot(a,'get_msg',{message_id:Number(r.message_id)});r.readback={messageId:m.message_id,type:m.message_type,segments:m.message?.map(x=>x.type)};}catch{r.readback={error:'Unavailable'};}}}
db.close();
fs.writeFileSync('/home/afrangry/kurumi-fusion/docs/verification/fusion/receipts.json',JSON.stringify({limit:10,reserved:receipts.length,receipts},null,2));console.log(JSON.stringify({reserved:receipts.length,statuses:receipts.map(x=>x.status)}));
