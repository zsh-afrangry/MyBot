import {existsSync} from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {account,ownerTarget} from './config.js';
import {Ledger} from './ledger.js';
import {onebot,sendPayload} from './transport.js';
import {privateTextFeedback,readCronDeliveryParts,replyFeedbackData} from './private-text-feedback.js';

const cronIntentPattern = /^cron-direct-delivery:v1:(cron:[0-9a-f-]{36}:\d+):kurumi-qq:(?:default)?:([^:]+):$/u;

// OpenClaw passes the durable intent from native announce, including the exact
// occurrence and recipient. A generic outbound session only identifies a peer.
function cronIntentRunId(queueId, peer) {
  const match = cronIntentPattern.exec(queueId ?? '');
  if (!match) return undefined;
  const [,runId,target] = match;
  return [peer, encodeURIComponent('user:'+peer)].includes(target) ? runId : undefined;
}

export async function sendQueuedText(args) {
  if (!args.deliveryQueueId || args.deliveryPartIndex > 0 || args.mediaUrl || args.onTextPlan) return sendPayload(args);
  const a = account(args.cfg), peer = ownerTarget(args.to,a);
  const runId = cronIntentRunId(args.deliveryQueueId,peer);
  if (!runId || a.privateTextFeedback === false) return sendPayload(args);

  let ledger;
  try {
    let feedback;
    try {
      const login = await onebot(a,'get_login_info',{},args.signal,{timeoutMs:1000});
      const selfId = String(login?.user_id);
      if (/^\d{5,12}$/u.test(selfId) && selfId !== peer) {
        ledger = new Ledger(a.stateDir);
        feedback = privateTextFeedback(ledger.db,{selfId,peer,sourceMessage:runId});
      }
    } catch { /* Preserve normal delivery when the extra evidence cannot be prepared. */ }
    return await sendPayload({...args,onTextPlan:feedback?.plan});
  } finally { ledger?.close(); }
}

function readParts(stateDir, runId, peer, endedAtMs) {
  const file = path.join(stateDir,'channel.sqlite');
  if (!existsSync(file)) return [];
  const db = new DatabaseSync(file,{readOnly:true});
  try {
    db.exec('PRAGMA busy_timeout=1000; BEGIN');
    return readCronDeliveryParts(db,runId,peer,endedAtMs);
  } finally { db.close(); }
}

export function readQqCronFeedback(stateDir, runId, peer, endedAtMs) {
  return readParts(stateDir,runId,peer,endedAtMs).map(row => ({
    ...replyFeedbackData(row),
    messageId: row.message_id,
    deliveryKey: row.delivery_key,
  }));
}

export function reconcileQueuedText({cfg,to,queueId}) {
  try {
    const a = account(cfg), peer = ownerTarget(to,a);
    const runId = cronIntentRunId(queueId,peer);
    if (runId) {
      const rows = readParts(a.stateDir,runId,peer);
      const ids = rows.map(row => row.message_id);
      if (rows.length && new Set(ids).size === rows.length && rows.every((row,index) =>
        row.delivery_key === 'delivery:'+queueId+':0' && row.part === index+1 &&
        row.parts === rows.length && row.status === 'sent' && /^-?[1-9]\d*$/u.test(row.message_id))) {
        return {
          status:'sent',
          messageId: ids.at(-1),
          receipt: {primaryPlatformMessageId:ids[0],platformMessageIds:ids,
            sentAt:Math.max(...rows.map(row=>row.at)),
            parts:ids.map((platformMessageId,index)=>({platformMessageId,index,kind:'text'}))},
        };
      }
    }
  } catch { /* Missing or unreadable evidence leaves a send unresolved. */ }
  return {status:'unresolved',retryable:false};
}
