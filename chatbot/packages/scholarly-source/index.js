// Public scholarly PDF acquisition only. Parsing and rendering belong to consumers.
import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';

const hosts = new Set(['arxiv.org', 'export.arxiv.org', 'aclanthology.org', 'openreview.net', 'proceedings.mlr.press', 'proceedings.neurips.cc']);
export const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function paperUrl(input) {
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !hosts.has(url.hostname) || url.hash) throw Error('仅支持已配置的公开学术PDF源（arXiv、ACL、OpenReview、PMLR、NeurIPS）');
  if ([...url.searchParams.keys()].some(key => url.hostname !== 'openreview.net' || key !== 'id')) throw Error('Unsupported PDF URL parameters');
  if (url.hostname === 'arxiv.org' || url.hostname === 'export.arxiv.org') {
    const match = url.pathname.match(/^\/(?:pdf|abs)\/(\d{4}\.\d{4,5}(?:v\d+)?)(?:\.pdf)?$/u);
    if (!match) throw Error('Invalid arXiv identifier');
    return `https://arxiv.org/pdf/${match[1]}`;
  }
  return url.href;
}

export function paperDirectory(workspace) {
  const root = fs.realpathSync(workspace), dir = path.join(root, 'papers');
  fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  if (fs.realpathSync(dir) !== dir) throw Error('Invalid paper directory');
  return {root, dir};
}

export function paperFile(dir, name) {
  const file = path.join(dir, name);
  try { if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) throw Error('Paper artifact must be a regular file'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return file;
}

function saveJson(file, data) {
  const temporary = file + '.' + randomUUID() + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(data, null, 2), {mode: 0o600, flag: 'wx'});
  try { fs.renameSync(temporary, file); } finally { fs.rmSync(temporary, {force: true}); }
}

const pending = new Map();
export async function downloadScholarlyPdf(workspace, input, options = {}) {
  const url = paperUrl(input), key = fs.realpathSync(workspace) + ':' + url;
  options.signal?.throwIfAborted();
  // Cancellation remains scoped to a caller: do not combine independently cancellable requests.
  if (options.signal) return downloadOnce(workspace, url, options);
  if (pending.has(key)) return pending.get(key);
  const job = downloadOnce(workspace, url, options).finally(() => pending.delete(key));
  pending.set(key, job);
  return job;
}

async function downloadOnce(workspace, url, {signal, fetcher = fetch} = {}) {
  const {dir} = paperDirectory(workspace), id = sha256(url).slice(0, 16);
  const pdfPath = paperFile(dir, id + '.pdf'), metadata = paperFile(dir, id + '.source.json');
  const legacy = paperFile(dir, id + '.json');
  const savedFile = fs.existsSync(metadata) ? metadata : fs.existsSync(legacy) ? legacy : undefined;
  if (savedFile) {
    const saved = JSON.parse(fs.readFileSync(savedFile, 'utf8'));
    if (saved.id !== id || saved.url !== url || !fs.existsSync(pdfPath)) throw Error('Cached PDF integrity mismatch');
    const bytes = fs.readFileSync(pdfPath);
    if (bytes.length > MAX_SOURCE_BYTES || saved.bytes !== bytes.length || saved.sha256 !== sha256(bytes) || !bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw Error('Cached PDF integrity mismatch');
    // Adopt an existing research cache without extracting text or downloading it again.
    return {id, url, sha256: saved.sha256, bytes: bytes.length, pdfPath, downloadedAt: saved.downloadedAt};
  }
  const response = await fetcher(url, {redirect: 'manual', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(45000)]) : AbortSignal.timeout(45000)});
  if (response.status !== 200) throw Error(`PDF source HTTP ${response.status}; no redirects or credentials attempted`);
  if (Number(response.headers.get('content-length')) > MAX_SOURCE_BYTES) throw Error('PDF exceeds 25 MiB');
  const parts = []; let size = 0;
  for await (const part of response.body) {
    size += part.length;
    if (size > MAX_SOURCE_BYTES) throw Error('PDF exceeds 25 MiB');
    parts.push(Buffer.from(part));
  }
  const bytes = Buffer.concat(parts);
  if (!bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw Error('Source did not return a PDF');
  signal?.throwIfAborted();
  const temporary = path.join(dir, id + '.' + randomUUID() + '.tmp');
  fs.writeFileSync(temporary, bytes, {mode: 0o600, flag: 'wx'});
  try { fs.renameSync(temporary, pdfPath); } finally { fs.rmSync(temporary, {force: true}); }
  const data = {id, url, sha256: sha256(bytes), bytes: bytes.length, downloadedAt: new Date().toISOString()};
  saveJson(metadata, data);
  return {...data, pdfPath};
}
