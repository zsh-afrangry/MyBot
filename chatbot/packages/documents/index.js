// Managed PDFs shared by paper acquisition, QQ files and mail attachments. See docs/22.
// Callers supply a configured root, never a model-selected filesystem path.
import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {runSandbox} from '../sandbox/index.js';

export const MAX_PDF_BYTES = 25 * 1024 * 1024;
// Dual PDFs include the original and translated resources; the worker caps each output at 100 MiB.
export const MAX_ARTIFACT_PDF_BYTES = 100 * 1024 * 1024;
const byteLimit = kind => kind === 'artifact' ? MAX_ARTIFACT_PDF_BYTES : MAX_PDF_BYTES;
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const validId = id => /^(?:doc|pdf)_[a-f0-9]{32}$/.test(String(id));
export function documentRoot(cfg) {
  const root = cfg?.plugins?.entries?.['kurumi-papers']?.config?.root;
  if (!path.isAbsolute(root ?? '')) throw Error('Managed document root is not configured');
  return root;
}
export function safeName(value) {
  const name = String(value ?? 'document.pdf').normalize('NFC').replace(/[\x00-\x1f\x7f/\\]/g, '_').slice(0, 160);
  return name.toLowerCase().endsWith('.pdf') ? name : name + '.pdf';
}
export function atomicJson(file, value) {
  const temp = file + '.' + randomUUID() + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), {mode: 0o600, flag: 'wx'});
  try { fs.renameSync(temp, file); } finally { fs.rmSync(temp, {force: true}); }
}
function regular(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { if (!fs.fstatSync(fd).isFile()) throw Error('Managed file is not regular'); return fs.readFileSync(fd); }
  finally { fs.closeSync(fd); }
}
export class Documents {
  constructor(root) {
    if (!path.isAbsolute(root)) throw Error('Absolute document root required');
    fs.mkdirSync(root, {recursive: true, mode: 0o700});
    if (fs.realpathSync(root) !== path.resolve(root)) throw Error('Document root must not contain symlinks');
    this.root = root;
    for (const name of ['files', 'records', 'jobs', 'work', 'cache']) {
      const dir = path.join(root, name);
      fs.mkdirSync(dir, {recursive: true, mode: 0o700});
      if (fs.realpathSync(dir) !== dir) throw Error('Managed directory must not contain symlinks');
    }
  }
  recordFile(id) { if (!validId(id)) throw Error('Invalid document ID'); return path.join(this.root, 'records', id + '.json'); }
  get(id) {
    const data = JSON.parse(regular(this.recordFile(id)));
    if (data.id !== id || !['input', 'artifact'].includes(data.kind)) throw Error('Invalid document record');
    const file = path.join(this.root, 'files', id + '.pdf');
    const bytes = regular(file);
    if (bytes.length !== data.bytes || bytes.length > byteLimit(data.kind) || sha256(bytes) !== data.sha256) throw Error('Managed PDF integrity mismatch');
    return {...data, path: file, content: bytes};
  }
  describe(id) { const {path: ignored, content, ...data} = this.get(id); return data; }
  list({kind, limit = 20} = {}) {
    return fs.readdirSync(path.join(this.root, 'records')).filter(n => /^(doc|pdf)_[a-f0-9]{32}\.json$/.test(n))
      .map(n => this.describe(n.slice(0, -5))).filter(d => !kind || d.kind === kind)
      .sort((a,b) => b.createdAt.localeCompare(a.createdAt)).slice(0, Math.min(50, Math.max(1, limit)));
  }
  async add(bytes, {filename, source = {}, kind = 'input', jobId} = {}, {inspect = inspectPdf, signal} = {}) {
    if (!['input', 'artifact'].includes(kind)) throw Error('Invalid document kind');
    if (!Buffer.isBuffer(bytes) || !bytes.length || !bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw Object.assign(Error('Expected a PDF'), {code: 'invalid_pdf'});
    if (bytes.length > byteLimit(kind)) throw Object.assign(Error(`PDF exceeds ${byteLimit(kind) / 1024 / 1024} MiB ${kind} limit`), {code: 'pdf_size_limit_exceeded'});
    const hash = sha256(bytes), id = (kind === 'input' ? 'doc_' : 'pdf_') + hash.slice(0, 32);
    if (fs.existsSync(this.recordFile(id))) return this.describe(id);
    const staging = fs.mkdtempSync(path.join(this.root, 'work', 'import-'));
    try {
      fs.mkdirSync(path.join(staging, 'files'), {mode: 0o700});
      fs.writeFileSync(path.join(staging, 'files', id + '.pdf'), bytes, {mode: 0o600, flag: 'wx'});
      // The parser sees just this candidate; failed/cancelled imports leave no unregistered PDF.
      const details = await inspect(staging, id, {signal});
      if (!Number.isInteger(details.pages) || details.pages < 1 || details.pages > 500 || details.encrypted) throw Error('PDF must be unencrypted and have 1–500 pages');
      signal?.throwIfAborted();
      if (fs.existsSync(this.recordFile(id))) return this.describe(id);
      const file = path.join(this.root, 'files', id + '.pdf');
      try { fs.writeFileSync(file, bytes, {mode: 0o600, flag: 'wx'}); } catch (e) { if (e.code !== 'EEXIST') throw e; }
      if (sha256(regular(file)) !== hash) throw Error('PDF content collision');
      const data = {id, kind, filename: safeName(filename), sha256: hash, bytes: bytes.length, pages: details.pages, source, ...(jobId ? {jobId} : {}), createdAt: new Date().toISOString()};
      atomicJson(this.recordFile(id), data);
      return data;
    } finally { fs.rmSync(staging, {recursive: true, force: true}); }
  }
}
export async function inspectPdf(root, id, {signal} = {}) {
  const result = await runSandbox({root}, ['/usr/bin/prlimit', '--as=1073741824', '--cpu=20', '--', '/usr/bin/pdfinfo', '/workspace/files/' + id + '.pdf'], {signal, timeoutMs: 30000});
  const pages = Number(/^Pages:\s+(\d+)/m.exec(result.output)?.[1]);
  if (result.code !== 0 || !Number.isInteger(pages) || pages < 1) throw Error('PDF parsing failed');
  return {pages, encrypted: /^Encrypted:\s+yes/m.test(result.output)};
}
