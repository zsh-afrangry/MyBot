import {error,time} from './policy.js';
// Wall-clock opportunities, no catch-up or startup send. Slot deduplication is
// durable in WakeStore; this scheduler never decides whether/how often to speak.
export function createWakeScheduler({intervalMs,wake,now=Date.now,onResult=()=>{},setTimer=setTimeout,clearTimer=clearTimeout}) {
  if (!Number.isSafeInteger(intervalMs)||intervalMs<60000||intervalMs>86400000) throw error('invalid_wake_interval');
  let timer,controller,busy=false,started=false;
  async function tick() {
    const at=time(now());
    if (busy) return {status:'skipped',reason:'scheduler_busy'};
    busy=true;controller=new AbortController();
    try {const result=await wake({eventKey:'fixed:'+intervalMs+':'+Math.floor(at/intervalMs),signal:controller.signal});onResult(result);return result;}
    catch {const result={status:'failed',reason:'wake_scheduler_failed'};onResult(result);return result;}
    finally {busy=false;controller=undefined;}
  }
  function arm() {
    if (!started) return;
    const at=time(now()),delay=intervalMs-at%intervalMs;
    timer=setTimer(()=>{arm();void tick();},delay);timer?.unref?.();
  }
  return {tick,start(){if(!started){started=true;arm();}},stop(){started=false;clearTimer(timer);controller?.abort();},
    status:()=>({started,busy,intervalMs})};
}
