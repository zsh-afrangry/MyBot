// On-demand domain jobs, durable state, no automatic paid replay after a restart. See docs/22.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {Documents, atomicJson} from '../../packages/documents/index.js';
import {downloadPaper} from '../kurumi-research/papers.js';
import {resolveProfile} from './profiles.js';
import {runTranslation,executionSettings} from './runner.js';

const JOB_ID = /^job_[a-f0-9]{24}$/;
export function normalizePages(value, pages, maxPages = 30) {
  if (value == null) { if (pages > maxPages) throw Error(`PDF 有 ${pages} 页，超过单任务 ${maxPages} 页；请指定页码范围。`); return null; }
  if (typeof value !== 'string' || !/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(value) || value.length > 200) throw Error('Pages must be a comma-separated range such as 1-3,5');
  const selected = new Set();
  for (const part of value.split(',')) {
    const [start, end = start] = part.split('-').map(Number);
    if (start < 1 || end < start || end > pages || end - start >= maxPages) throw Error('Invalid page range');
    for (let i = start; i <= end; i++) { selected.add(i); if (selected.size > maxPages) throw Error('Too many selected pages'); }
  }
  return [...selected].sort((a,b) => a-b).join(',');
}
export class PaperService {
  constructor(config, {runner = runTranslation, sendFile, notify, trace = () => {}, inspect} = {}) {
    this.config = config; this.documents = new Documents(config.root);
    this.runner = runner; this.sendFile = sendFile; this.notify = notify; this.trace = trace; this.inspect = inspect;
    this.queue = []; this.active = null; this.online = false;
  }
  file(id) { if (!JOB_ID.test(id ?? '')) throw Error('Invalid translation job ID'); return path.join(this.documents.root, 'jobs', id + '.json'); }
  get(id) { const file = this.file(id); if (fs.lstatSync(file).isSymbolicLink()) throw Error('Invalid job file'); const data = JSON.parse(fs.readFileSync(file)); if (data.id !== id) throw Error('Job identity mismatch'); return data; }
  status(id) {
    const job = this.get(id), usage = path.join(this.documents.root, 'work', id, 'usage.json');
    if (job.status === 'running' && fs.existsSync(usage) && !fs.lstatSync(usage).isSymbolicLink()) {
      try { job.usage = JSON.parse(fs.readFileSync(usage)); } catch {}
    }
    const progress = path.join(this.documents.root, 'work', id, 'progress.json');
    if (job.status === 'running' && fs.existsSync(progress) && !fs.lstatSync(progress).isSymbolicLink()) {
      try { job.engineProgress = JSON.parse(fs.readFileSync(progress)); } catch {}
    }
    return job;
  }
  save(job) { job.updatedAt = new Date().toISOString(); atomicJson(this.file(job.id), job); this.trace({kind: 'paper.job', correlation: {taskId: job.id, ...job.correlation}, data: {status: job.status, documentId: job.documentId, profile: job.profile, error: job.error ?? null, delivery: job.delivery ?? null}}); return job; }
  list() { return fs.readdirSync(path.join(this.documents.root, 'jobs')).filter(n => /^job_[a-f0-9]{24}\.json$/.test(n)).map(n => this.get(n.slice(0,-5))).sort((a,b) => b.createdAt.localeCompare(a.createdAt)).slice(0,20); }
  start() {
    for (const name of fs.readdirSync(path.join(this.documents.root, 'jobs'))) {
      if (!/^job_[a-f0-9]{24}\.json$/.test(name)) continue;
      const job = this.get(name.slice(0,-5));
      if (['queued','running'].includes(job.status)) { job.status = 'interrupted'; job.error = 'gateway_restarted_no_automatic_replay'; this.save(job); }
      if (job.delivery?.status === 'dispatching') { job.delivery.status = 'failed_or_unknown'; this.save(job); }
    }
    this.online = true;
  }
  async stop() {
    this.online = false;
    for (const id of this.queue.splice(0)) { const job = this.get(id); job.status = 'interrupted'; this.save(job); }
    this.active?.controller.abort(); await this.active?.promise;
  }
  async fetch(url, {signal} = {}) {
    const cache = path.join(this.documents.root, 'cache');
    const paper = await downloadPaper(cache, url, {signal});
    return this.documents.add(fs.readFileSync(paper.pdfPath), {filename: `paper-${paper.id}.pdf`, source: {type: 'scholarly', url: paper.url}}, {signal, ...(this.inspect ? {inspect: this.inspect} : {})});
  }
  submit(args, {key, correlation = {}} = {}) {
    if (!this.online) throw Error('Translation job service is not running');
    if (this.config.liveTranslationEnabled !== true) throw Error('Live translation awaits budget approval; document acquisition and offline tests remain available');
    if (!key || typeof key !== 'string') throw Error('Trusted invocation key required');
    const doc = this.documents.describe(args.documentId), profile = resolveProfile(args);
    const pages = normalizePages(args.pages, doc.pages, this.config.maxPages ?? 30);
    const sourceLang = args.sourceLang ?? 'en', targetLang = args.targetLang ?? 'zh';
    for (const lang of [sourceLang, targetLang]) if (!['en','zh','zh-cn','zh-tw','ja','de','fr','es','ru'].includes(lang)) throw Error('Unsupported translation language');
    const delivery = args.delivery ?? 'qq'; if (!['qq','none'].includes(delivery)) throw Error('Translation delivery must be qq or none; email uses the confirmed mail draft tools');
    const deliveryKind = args.output ?? 'dual'; if (!['dual','mono','both'].includes(deliveryKind)) throw Error('Invalid PDF output preference');
    const parameters = {documentId: doc.id, profile, pages, sourceLang, targetLang, deliveryTarget: delivery, deliveryKind};
    const digest = createHash('sha256').update(JSON.stringify(parameters)).digest('hex');
    const id = 'job_' + createHash('sha256').update(key).digest('hex').slice(0,24);
    if (fs.existsSync(this.file(id))) { const existing = this.get(id); if (existing.requestHash !== digest) throw Error('Invocation key reused with different parameters'); return existing; }
    if (this.queue.length >= 5) throw Error('Translation queue is full (maximum 5 waiting jobs)');
    const job = this.save({id, ...parameters, requestHash: digest, status: 'queued', correlation, createdAt: new Date().toISOString(), artifacts: {}});
    this.queue.push(id); this.scheduleDrain(); return job;
  }
  scheduleDrain() {
    queueMicrotask(() => { void this.drain().catch(() => {
      // A damaged/missing job record must not become an unhandled rejection or paid retry loop.
      this.online = false;
      try { this.trace({kind: 'paper.dispatch_failed', data: {error: 'job_record_or_state_unavailable'}}); } catch {}
    }); });
  }
  async drain() {
    if (!this.online || this.active || !this.queue.length) return;
    const id = this.queue.shift(), controller = new AbortController();
    const promise = this.execute(id, controller.signal);
    this.active = {id, controller, promise};
    try { await promise; } finally { this.active = null; this.scheduleDrain(); }
  }
  async execute(id, signal) {
    const job = this.get(id), work = path.join(this.documents.root, 'work', id);
    try {
      fs.mkdirSync(work, {mode: 0o700});
      fs.writeFileSync(path.join(work, 'input.pdf'), this.documents.get(job.documentId).content, {mode: 0o600, flag: 'wx'});
      job.status = 'running'; job.execution = executionSettings(this.config); this.save(job);
      const result = await this.runner({config: this.config, work, cache: path.join(this.documents.root, 'cache'), profile: job.profile, pages: job.pages, sourceLang: job.sourceLang, targetLang: job.targetLang, signal});
      signal.throwIfAborted();
      job.usage = result.usage;
      for (const kind of ['mono','dual']) {
        const record = await this.documents.add(fs.readFileSync(result[kind]), {kind: 'artifact', filename: this.documents.describe(job.documentId).filename.replace(/\.pdf$/i, `${job.pages ? '-pages-' + job.pages : ''}-${kind}.pdf`), source: {type: 'translation', inputId: job.documentId}, jobId: id}, {signal, ...(this.inspect ? {inspect: this.inspect} : {})});
        job.artifacts[kind] = record.id;
      }
      signal.throwIfAborted(); job.status = 'succeeded'; job.delivery = {status: 'not_requested'}; this.save(job);
      if (job.deliveryTarget === 'qq') {
        job.delivery = {status: 'dispatching', receipts: []}; this.save(job);
        for (const kind of job.deliveryKind === 'both' ? ['dual','mono'] : [job.deliveryKind]) {
          signal.throwIfAborted();
          const receipt = await this.sendFile(job.artifacts[kind], id + ':' + kind, signal);
          job.delivery.receipts.push(receipt); this.save(job);
        }
        job.delivery.status = 'platform_accepted'; this.save(job);
      }
    } catch (error) {
      if (job.status === 'succeeded') { job.delivery.status = 'failed_or_unknown'; this.save(job); }
      else { job.status = signal.aborted ? (this.online ? 'cancelled' : 'interrupted') : 'failed'; job.error = /^[a-zA-Z0-9_]+$/.test(error.code ?? '') ? error.code : 'translation_failed'; this.save(job); }
      try { if (this.online && !signal.aborted) await this.notify?.(`论文翻译任务 ${id}：${job.status === 'succeeded' ? '译文已生成，但文件投递未确认，可查询任务后重新安排投递。' : '未完成（' + job.error + '），可查询详情。'}`, id); } catch {}
    } finally {
      // Keep bounded usage evidence even on cancellation; remove duplicated input/intermediate PDFs.
      const usageFile = path.join(work, 'usage.json');
      if (fs.existsSync(usageFile)) { try { job.usage = JSON.parse(fs.readFileSync(usageFile)); this.save(job); } catch {} }
      const progressFile = path.join(work, 'progress.json');
      if (fs.existsSync(progressFile)) { try { job.engineProgress = JSON.parse(fs.readFileSync(progressFile)); this.save(job); } catch {} }
      const engineError = path.join(work, 'engine-error.json');
      if (fs.existsSync(engineError)) { try { job.engineFailure = JSON.parse(fs.readFileSync(engineError)); this.save(job); } catch {} }
      fs.rmSync(work, {recursive: true, force: true});
    }
  }
  async cancel(id) {
    const job = this.get(id);
    if (job.status === 'queued') { this.queue = this.queue.filter(x => x !== id); job.status = 'cancelled'; this.save(job); }
    else if (job.status === 'running' && this.active?.id === id) { this.active.controller.abort(); await this.active.promise; }
    return this.get(id);
  }
}
