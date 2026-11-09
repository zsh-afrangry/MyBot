// Fixed CLI adapter; no shell, arbitrary script, raw text mode or caller-supplied roots.
import {spawn} from 'node:child_process';
import path from 'node:path';
import {LogQueryError} from './policy.js';
export function cliArguments(config, q) {
  // The host captures plugin modules outside the source tree. Only the trusted
  // deployment root locates this fixed backend; import.meta.url cannot do so.
  const args = [path.join(config.backendRoot,'scripts/fusion/log-query.mjs'),'--runtime-root',config.runtimeRoot,'--snowluma-root',config.snowlumaRoot,'--from',q.from,'--to',q.to,'--json','--no-text'];
  for (const source of q.sources) args.push('--source',source);
  for (const [key,flag] of [['runId','--run-id'],['messageId','--message-id'],['kind','--kind']]) if (q[key] !== undefined) args.push(`${flag}=${q[key]}`);
  if (q.view === 'stats') args.push('--stats');
  else { args.push('--limit',String(q.limit),'--offset',String(q.offset)); if (q.view === 'errors') args.push('--errors'); }
  return args;
}
export function readQuery(config, q, {signal, timeoutMs = 10000, maxBytes = 512 * 1024} = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve,reject) => {
    let child, timer, forceTimer, failure, bytes=0; const chunks=[];
    const stop = code => {
      failure ??= new LogQueryError(code);
      child?.kill('SIGTERM');
      forceTimer ??= setTimeout(() => child?.kill('SIGKILL'),500);
      forceTimer.unref();
    };
    const abort = () => stop('cancelled');
    const finish = (error,result) => {
      clearTimeout(timer); clearTimeout(forceTimer); signal?.removeEventListener('abort',abort);
      error ? reject(error) : resolve(result);
    };
    try {
      child = spawn(process.execPath,cliArguments(config,q),{cwd:config.backendRoot,shell:false,stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH ?? '',TZ:'Asia/Shanghai',NODE_NO_WARNINGS:'1'}});
    } catch { finish(new LogQueryError('query_failed')); return; }
    signal?.addEventListener('abort',abort,{once:true}); if (signal?.aborted) abort();
    timer = setTimeout(() => stop('timeout'),timeoutMs); timer.unref();
    const consume = (chunk,keep) => {
      bytes += chunk.length;
      if (bytes > maxBytes) stop('output_limit');
      else if (keep && !failure) chunks.push(chunk);
    };
    child.stdout.on('data',b => consume(b,true)); child.stderr.on('data',b => consume(b,false));
    child.once('error',() => {failure ??= new LogQueryError('query_failed');});
    child.once('close',code => {
      if (failure) return finish(failure);
      if (code !== 0) return finish(new LogQueryError('query_failed'));
      try { finish(null,JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { finish(new LogQueryError('invalid_response')); }
    });
  });
}
