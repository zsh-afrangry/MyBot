import {setTimeout as delay} from 'node:timers/promises';

// Health can precede completion of plugin generation during startup. Retry only
// the explicit generation-replacement error, keeping all other failures visible.
export async function readPluginCatalog(call, {timeoutMs=30000, retryDelayMs=300}={}) {
  const deadline=Date.now()+timeoutMs;
  for (;;) {
    try {
      return await call('tools.catalog', {agentId:'main',includePlugins:true}, Math.max(1,Math.min(10000,deadline-Date.now())));
    } catch (error) {
      if (!String(error?.message).includes('Plugin catalog generation is no longer available') || Date.now()>=deadline) throw error;
      await delay(Math.min(retryDelayMs,Math.max(1,deadline-Date.now())));
    }
  }
}

export async function waitForPluginStates(call, expected, {timeoutMs=30000,retryDelayMs=300}={}) {
  const deadline=Date.now()+timeoutMs;
  for (;;) {
    const result=await call('plugins.list',{},Math.max(1,Math.min(10000,deadline-Date.now())));
    const states=Object.fromEntries((result.plugins??[]).map(plugin=>[plugin.id,plugin.runtime?.state]));
    if (Object.entries(expected).every(([id,allowed])=>allowed.includes(states[id]))) return result;
    if (Date.now()>=deadline) throw Error('Plugin states did not settle: '+JSON.stringify(states));
    await delay(Math.min(retryDelayMs,Math.max(1,deadline-Date.now())));
  }
}
