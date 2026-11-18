// Shared transport for domain-owned native Cron jobs. Only domain adapters choose job parameters.
import {callGatewayFromCli} from 'openclaw/plugin-sdk/gateway-runtime';

export function createManagedCron({port, request}) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Invalid native Cron port');
  const call = request ?? ((method, params) => {
    const token = process.env.OPENCLAW_GATEWAY_TOKEN;
    if (!token) throw Error('Native Cron credentials unavailable');
    return callGatewayFromCli(method, {url: `ws://127.0.0.1:${port}`, token, timeout: '15000', json: true}, params);
  });
  return {
    async listJobs() {
      const jobs = [];
      let offset = 0;
      for (let page = 0; page < 100; page++) {
        const next = await call('cron.list', {includeDisabled: true, offset, limit: 100});
        if (!Array.isArray(next?.jobs)) throw Error('Invalid Cron snapshot');
        jobs.push(...next.jobs);
        if (!next.hasMore) return jobs;
        if (!Number.isInteger(next.nextOffset) || next.nextOffset <= offset) throw Error('Invalid Cron pagination');
        offset = next.nextOffset;
      }
      throw Error('Cron snapshot too large');
    },
    async runs(id, limit) {
      const result = await call('cron.runs', {id, limit});
      if (!Array.isArray(result?.entries)) throw Error('Invalid Cron observations');
      return result.entries;
    },
    async add(params) {
      const result = await call('cron.add', params);
      const id = result?.id ?? result?.jobId ?? result?.job?.id;
      if (typeof id !== 'string' || !id) throw Error('Missing managed Cron identity');
      return id;
    },
    async update(id, patch) { await call('cron.update', {id, patch}); },
    async remove(id) { await call('cron.remove', {id}); },
  };
}
