// Offline PDF source/reader/translation boundary; injected HTTP and actual managed
// PDF inspection in temporary directories. No real APIs, paid jobs or delivery.
// Evidence: docs/verification/capability-decoupling-2026-10-20/README.md
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {downloadScholarlyPdf, MAX_SOURCE_BYTES} from '../../packages/scholarly-source/index.js';
import {downloadPaper, readPaperText} from '../../plugins/kurumi-research/papers.js';
import {PaperService} from '../../plugins/kurumi-papers/service.js';
import {pdf} from './fixtures.mjs';

const url = 'https://arxiv.org/abs/2401.12345';
function directory(t) { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'kurumi-source-')); t.after(() => fs.rmSync(p, {recursive: true, force: true})); return p; }
const fetcher = async () => new Response(pdf(), {status: 200});

test('text extraction failure retains a valid source that translation imports without running the reader', async t => {
  const root = directory(t);
  const service = new PaperService({root}, {download: (cache, input, options) => downloadScholarlyPdf(cache, input, {...options, fetcher})});
  const cache = path.join(root, 'cache');
  await assert.rejects(downloadPaper(cache, url, {fetcher, extractText: async () => ({code: 1})}), /extraction failed/);
  const record = await service.fetch(url);
  assert.equal(record.pages, 1);
  assert.equal(record.source.type, 'scholarly');
  const id = fs.readdirSync(path.join(cache, 'papers')).find(n => n.endsWith('.pdf')).slice(0, -4);
  assert.equal(fs.existsSync(path.join(cache, 'papers', id + '.json')), false);
});

test('reader separately prepares full text from the same cached source', async t => {
  const root = directory(t), source = await downloadScholarlyPdf(root, url, {fetcher});
  const result = await downloadPaper(root, url, {fetcher: () => { throw Error('cache must be reused'); }, extractText: async () => {
    fs.writeFileSync(path.join(root, 'papers', source.id + '.raw.txt'), 'First page\fSecond page\f'); return {code: 0};
  }});
  assert.equal(result.pages, 2);
  assert.match(readPaperText(root, result.id).text, /PDF PAGE 2/);
  assert.equal(result.sha256, source.sha256);
});

test('legacy reader cache is reusable by source-only consumers without parsing or network', async t => {
  const root = directory(t), source = await downloadScholarlyPdf(root, url, {fetcher});
  const dir = path.join(root, 'papers');
  fs.renameSync(path.join(dir, source.id + '.source.json'), path.join(dir, source.id + '.json'));
  const reused = await downloadScholarlyPdf(root, url, {fetcher: () => { throw Error('no download'); }});
  assert.equal(reused.sha256, source.sha256);
  assert.equal('pages' in reused, false);
});

test('cache corruption and cache symlinks fail closed', async t => {
  const root = directory(t), source = await downloadScholarlyPdf(root, url, {fetcher});
  fs.appendFileSync(source.pdfPath, 'corrupt');
  await assert.rejects(downloadScholarlyPdf(root, url, {fetcher}), /integrity/);
  fs.unlinkSync(source.pdfPath); fs.symlinkSync('/etc/hosts', source.pdfPath);
  await assert.rejects(downloadScholarlyPdf(root, url, {fetcher}), /regular file/);
});

test('source rejects redirects, non-PDF bytes and excessive declared/streamed sizes', async t => {
  for (const response of [
    () => new Response('', {status: 302, headers: {location: 'http://127.0.0.1/'}}),
    () => new Response('<html>not a PDF</html>'),
    () => new Response(pdf(), {headers: {'content-length': String(MAX_SOURCE_BYTES + 1)}}),
    () => new Response(new Uint8Array(MAX_SOURCE_BYTES + 1)),
  ]) await assert.rejects(downloadScholarlyPdf(directory(t), url, {fetcher: response}), /HTTP 302|PDF|25 MiB/);
});

test('cancellation is isolated and never publishes partial bytes', async t => {
  const root = directory(t), controller = new AbortController();
  const cancelled = downloadScholarlyPdf(root, url, {signal: controller.signal, fetcher: async (_url, {signal}) => {
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), {once: true}));
  }});
  controller.abort();
  await assert.rejects(cancelled, /abort/i);
  assert.deepEqual(fs.readdirSync(path.join(root, 'papers')), []);
  const source = await downloadScholarlyPdf(root, url, {fetcher});
  await assert.rejects(downloadScholarlyPdf(root, url, {signal: controller.signal, fetcher}), /abort/i);
  assert.equal(fs.existsSync(source.pdfPath), true);
});
