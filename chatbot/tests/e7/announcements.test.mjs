// Synthetic PDFs and wiki list data. The real extractor runs in its temporary, networkless sandbox.
import test from 'node:test';
import assert from 'node:assert/strict';
import {pdf} from '../papers/fixtures.mjs';
import {setup} from './fixtures.mjs';
import {extractAnnouncement} from '../../plugins/kurumi-e7/announcements.js';

test('Poppler extracts a PDF text layer and reports an empty layer without OCR', async () => {
  assert.deepEqual(await extractAnnouncement(pdf('Event ends Friday.')), {
    pageLimitReached: false, pages: [{page: 1, text: 'Event ends Friday.'}],
  });
  assert.deepEqual(await extractAnnouncement(pdf('')), {pageLimitReached: false, pages: [{page: 1, text: ''}]});
  await assert.rejects(extractAnnouncement(Buffer.from('%PDF-invalid')), {code: 'announcement_extraction_failed'});
});

test('game news opens listed PDFs by ID only, pages extracted text, caches it, and refuses moved locators', async t => {
  let extractCalls = 0;
  const {service, data, calls, now} = setup(t, {
    read: async (kind, params, _opts, data) => ({status: 200,
      data: kind === 'gameNews' ? structuredClone(data.gameNews) : pdf('Event ends Friday.')}),
    dependencies: {extractPdf(bytes) {
      assert(bytes.subarray(0, 5).equals(Buffer.from('%PDF-')));
      extractCalls++;
      return {pageLimitReached: false, pages: [{page: 1, text: 'First page'}, {page: 2, text: 'Second page'}]};
    }},
  });
  const base = {action: 'news', kind: 'game'};
  const args = {...base, mode: 'get', announcementId: '1', limit: 1};
  await assert.rejects(service.query(args), {code: 'announcement_list_required'});
  for (const invalid of [{...args, url: 'https://invalid.test/file.pdf'}, {...args, server: '国际服'}, {...args, announcementId: '../secret'}, {...base, announcementId: '1'}])
    await assert.rejects(service.query(invalid), {code: 'invalid_query'});
  assert.equal(calls.length, 0);
  data.gameNews.list[1].url = 'https://invalid.test/file.pdf';
  const list = await service.query({...base, server: '国际服', limit: 2});
  assert.equal(list.data.items[0].bodyExtracted, false);
  assert.equal(list.data.items[1].url, null);
  await assert.rejects(service.query({...args, announcementId: '3'}), {code: 'announcement_list_required'});
  const invalid = await service.query({...args, announcementId: '2'});
  assert.equal(invalid.data.bodyStatus, 'pdf_unavailable');
  assert.equal(invalid.data.bodyExtracted, false);
  const result = await service.query(args);
  assert.equal(result.data.bodyStatus, 'text_extracted');
  assert.equal(result.data.items[0].text, 'First page');
  assert.equal(result.sources.length, 2);
  assert.equal(result.sources[1].url, list.data.items[0].url);
  const next = await service.query({...args, cursor: result.data.nextCursor});
  assert.deepEqual(next.data.items, [{page: 2, text: 'Second page'}]);
  assert.equal(extractCalls, 1);
  assert.deepEqual(calls.map(c => [c.kind, c.params]), [
    ['gameNews', {page: 1, server: 2}], ['announcementPdf', {relative: '/event/test-0.pdf'}],
  ]);
  now.value += 31 * 60000;
  data.gameNews.list.shift();
  await assert.rejects(service.query(args), {code: 'announcement_locator_expired'});
  assert.equal(extractCalls, 1);
});

test('image-only or otherwise empty extracted pages never count as read body', async t => {
  const {service} = setup(t, {
    read: async (kind, params, opts, data) => ({status: 200, data: kind === 'gameNews' ? data.gameNews : pdf('')}),
  });
  const args = {action: 'news', kind: 'game'};
  await service.query(args);
  const r = await service.query({...args, mode: 'get', announcementId: '1'});
  assert.equal(r.data.bodyExtracted, false);
  assert.equal(r.data.bodyStatus, 'no_extractable_text');
  assert.deepEqual(r.missingFields, ['body']);
  assert.match(r.data.coverage, /未识别图片或扫描件/u);
});
