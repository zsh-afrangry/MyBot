// Extract the text layer of public announcement PDFs in the existing networkless sandbox.
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runSandbox} from '../../packages/sandbox/index.js';
import {fail, object} from './policy.js';

const PAGE_LIMIT = 20;
const MAX_TEXT_BYTES = 1024 * 1024;

export async function extractAnnouncement(bytes, {signal} = {}) {
  signal?.throwIfAborted();
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kurumi-e7-announcement-'));
  try {
    await fs.writeFile(path.join(workspace, 'announcement.pdf'), bytes, {mode: 0o600, flag: 'wx'});
    const run = await runSandbox({root: workspace}, [
      '/usr/bin/prlimit', '--as=1073741824', '--cpu=15', '--fsize=' + MAX_TEXT_BYTES, '--',
      '/usr/bin/pdftotext', '-enc', 'UTF-8', '-layout', '-f', '1', '-l', String(PAGE_LIMIT + 1),
      '/workspace/announcement.pdf', '/workspace/body.txt',
    ], {signal, timeoutMs: 20000});
    signal?.throwIfAborted();
    if (run.code !== 0) fail('announcement_extraction_failed');
    const file = await fs.open(path.join(workspace, 'body.txt'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_TEXT_BYTES) fail('announcement_extraction_failed');
      const pages = (await file.readFile('utf8')).split('\f');
      if (pages.at(-1) === '') pages.pop();
      return {pageLimitReached: pages.length > PAGE_LIMIT, pages: pages.slice(0, PAGE_LIMIT).map((part, i) => ({
        page: i + 1, text: part.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trim(),
      }))};
    } finally {await file.close();}
  } catch {
    signal?.throwIfAborted();
    fail('announcement_extraction_failed');
  } finally {await fs.rm(workspace, {recursive: true, force: true});}
}

export function validateAnnouncementText(data) {
  if (!object(data) || typeof data.pageLimitReached !== 'boolean' || !Array.isArray(data.pages)
    || data.pages.length > PAGE_LIMIT || (data.pageLimitReached && data.pages.length !== PAGE_LIMIT)
    || data.pages.some((row, i) => !object(row) || row.page !== i + 1 || typeof row.text !== 'string')
    || Buffer.byteLength(data.pages.map(row => row.text).join('')) > MAX_TEXT_BYTES) fail('invalid_response');
  return data;
}
