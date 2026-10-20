// Owner-private PDF ingress/egress, sharing the managed document catalog. Contract: docs/22.
import {Documents, documentRoot, MAX_PDF_BYTES, inspectPdf} from '../../../packages/documents/index.js';
import {account, ownerTarget} from './config.js';
import {onebot} from './transport.js';
import {Ledger} from './ledger.js';
import {createTraceSink} from '../../../packages/observability/index.js';
import {isIP} from 'node:net';
import https from 'node:https';
import {Readable} from 'node:stream';

export function traceFile(cfg, event) {
  try { createTraceSink(documentRoot(cfg) + '/events.jsonl').emit({source: 'papers', ...event}); } catch {}
}

// CDN download addresses are data from the authenticated OneBot result, not arbitrary user URLs.
export function qqFileUrl(value) {
  const u = new URL(value);
  const hosts = ['multimedia.nt.qq.com', 'multimedia.nt.qq.com.cn', 'gzc-download.ftn.qq.com', 'sz-download.ftn.qq.com', 'sh-download.ftn.qq.com', 'c2c-download.ftn.qq.com'];
  const ip = isIP(u.hostname) === 4 ? u.hostname.split('.').map(Number) : null;
  const publicNT = ip && u.pathname.startsWith('/asn.com/') && !(
    [0,10,127].includes(ip[0]) || ip[0] >= 224 ||
    (ip[0] === 100 && ip[1] >= 64 && ip[1] <= 127) ||
    (ip[0] === 169 && ip[1] === 254) || (ip[0] === 172 && ip[1] >= 16 && ip[1] <= 31) ||
    (ip[0] === 192 && [0,2,168].includes(ip[1])) ||
    (ip[0] === 198 && ([18,19].includes(ip[1]) || (ip[1] === 51 && ip[2] === 100))) ||
    (ip[0] === 203 && ip[1] === 0 && ip[2] === 113));
  if (!['http:', 'https:'].includes(u.protocol) || !(hosts.includes(u.hostname) || publicNT) || u.port || u.username || u.password || u.hash) throw Error('Unsupported QQ file download source');
  // QQ may return HTTP download links; upgrade before fetching, never downgrade TLS.
  u.protocol = 'https:'; return u.href;
}
async function fetchQqFile(url, options) {
  const u = new URL(url);
  if (!isIP(u.hostname)) return fetch(url, options);
  // NT file URLs can name a public CDN IP. Keep that routing IP but verify the fixed QQ TLS name.
  // Replacing the URL host breaks its signed route; accepting an IP certificate without verification
  // or falling back to plaintext would weaken the file boundary.
  return new Promise((resolve, reject) => {
    const req = https.get(u, {servername:'multimedia.nt.qq.com.cn',rejectUnauthorized:true,signal:options.signal}, res => {
      const headers = Object.fromEntries(Object.entries(res.headers).filter(([,v]) => v != null).map(([k,v]) => [k,String(v)]));
      resolve(new Response(Readable.toWeb(res), {status:res.statusCode, headers}));
    });
    req.once('error', reject);
  });
}
const receiveError = (code, message) => Object.assign(Error(message), {code});
export async function stagePdf(segment, cfg, {signal, apiCall = onebot, fetcher = fetchQqFile, inspect} = {}) {
  const a = account(cfg), data = segment.data ?? segment;
  const filename = String(data.name ?? data.file_name ?? data.file ?? '');
  if (!/\.pdf$/i.test(filename)) throw receiveError('unsupported_file_type', 'Only PDF uploads are accepted');
  if (/[\x00-\x1f]/.test(filename)) throw receiveError('invalid_file_metadata', 'Invalid QQ file name');
  if (Number(data.size ?? data.file_size) > MAX_PDF_BYTES) throw receiveError('pdf_size_limit_exceeded', 'PDF exceeds 25 MiB');
  const fileId = String(data.file_id ?? data.id ?? data.file ?? '');
  if (!fileId || fileId.length > 512 || /[\x00-\x1f]/.test(fileId)) throw receiveError('missing_qq_file_id', 'Missing QQ file ID');
  let size = 0; const chunks = [];
  try {
    const r = await apiCall(a, 'get_private_file_url', {user_id: Number(a.ownerId), file_id: fileId, file_hash: String(data.file_hash ?? '')}, signal);
    const url = qqFileUrl(r?.url);
    const stop = signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000);
    const response = await fetcher(url, {redirect: 'manual', signal: stop});
    if (response.status !== 200) throw receiveError('pdf_download_failed', 'QQ PDF download failed');
    if (Number(response.headers.get('content-length')) > MAX_PDF_BYTES) throw receiveError('pdf_size_limit_exceeded', 'PDF exceeds 25 MiB');
    for await (const part of response.body) { size += part.length; if (size > MAX_PDF_BYTES) throw receiveError('pdf_size_limit_exceeded', 'PDF exceeds 25 MiB'); chunks.push(Buffer.from(part)); }
  } catch (error) {
    signal?.throwIfAborted();
    if (error?.code === 'pdf_size_limit_exceeded') throw error;
    throw receiveError('pdf_download_failed', 'QQ PDF download failed');
  }
  return new Documents(documentRoot(cfg)).add(Buffer.concat(chunks), {filename, source: {type: 'qq', fileId}}, {signal,
    inspect: async (...args) => {
      try {
        const details = await (inspect ?? inspectPdf)(...args);
        if (!Number.isInteger(details.pages) || details.pages < 1 || details.pages > 500 || details.encrypted) throw Error('Invalid PDF');
        return details;
      } catch {
        signal?.throwIfAborted();
        throw receiveError('pdf_validation_failed', 'QQ PDF validation failed');
      }
    },
  });
}
export async function sendDocument({cfg, to, documentId, key, signal, apiCall = onebot}) {
  const a = account(cfg); ownerTarget(to, a); signal?.throwIfAborted();
  const doc = new Documents(documentRoot(cfg)).get(documentId);
  if (!key || typeof key !== 'string') throw Error('Stable file delivery key required');
  const ledger = new Ledger(a.stateDir);
  try {
    const prior = ledger.reserve('pdf:' + key, a.sendLimit, a.dailySendLimit ?? 120);
    if (prior) {
      if (prior.status === 'sent') return {...JSON.parse(prior.message_id), duplicate: true};
      throw Error('Previous PDF delivery unresolved/failed; manual reconciliation required');
    }
    try {
      signal?.throwIfAborted();
      const r = await apiCall(a, 'upload_private_file', {user_id: Number(a.ownerId), file: doc.path, name: doc.filename}, signal, {timeoutMs:120000});
      // OneBot upload success often returns null, without a QQ message ID. Do not invent one.
      const receipt = {channel: 'kurumi-qq', status: 'platform_accepted', documentId, fileId: r?.file_id ?? null};
      ledger.sent('pdf:' + key, JSON.stringify(receipt));
      traceFile(cfg, {kind: 'paper.qq_upload', data: receipt}); return receipt;
    } catch (e) {
      if (e.rejected) ledger.failed('pdf:' + key);
      traceFile(cfg, {kind: 'paper.qq_upload', data: {documentId, status: e.rejected ? 'rejected' : 'unknown'}});
      throw e;
    }
  } finally { ledger.close(); }
}
