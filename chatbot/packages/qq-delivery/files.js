// Authorized private PDF ingress/egress and owner workspace file staging. Contracts: docs/22, docs/32, docs/38.
import {createHash} from 'node:crypto';
import {chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Documents, documentRoot, MAX_PDF_BYTES, inspectPdf} from '../documents/index.js';
import {ensureWorkspaceSubdir, isRedlineFilename, resolveSafePath} from '../scoped-lease/tiers.js';
import {account} from './config.js';
import {onebot} from './transport.js';
import {Ledger} from './ledger.js';
import {createTraceSink} from '../observability/index.js';
import {isIP} from 'node:net';
import https from 'node:https';
import {Readable} from 'node:stream';
import {activeSubject, targetSubject} from '../access-control/index.js';

export const OWNER_WORKSPACE_FILE_TYPES = Object.freeze(['xlsx', 'csv', 'tsv', 'docx', 'txt', 'md', 'json']);
export const MAX_WORKSPACE_FILE_BYTES = 16 * 1024 * 1024;

export function traceFile(cfg, event) {
  try { createTraceSink(documentRoot(cfg) + '/events.jsonl').emit({source: 'papers', ...event}); } catch {}
}

function traceWorkspaceFile(a, event) {
  try { createTraceSink(path.join(a.stateDir, 'trace-events.jsonl')).emit({source: 'trace-events', ...event}); } catch {}
}

const receiveError = (code, message) => Object.assign(Error(message), {code});
const bufferSha256 = buf => createHash('sha256').update(buf).digest('hex');

function shanghaiDayString(now = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Shanghai'}).format(new Date(now));
}

function sanitizeWorkspaceFilename(rawName, fileType) {
  const base = String(rawName ?? '')
    .replaceAll('\\', '/')
    .split('/')
    .at(-1)
    .normalize('NFC')
    .replace(/[\p{Cc}\p{Cf}]/gu, '_')
    .trim();
  const suffix = '.' + fileType;
  const rawStem = base.toLowerCase().endsWith(suffix) ? base.slice(0, -suffix.length) : base;
  let stem = rawStem.replace(/^\.+/u, '_').replaceAll('/', '_').trim();
  if (!stem) stem = 'file';
  stem = Array.from(stem).slice(0, 120).join('');
  let candidate = `${stem}${suffix}`;
  if (isRedlineFilename(candidate)) {
    candidate = `file_${candidate}`;
  }
  return candidate;
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
async function downloadPrivateQqFile(a, segment, {
  subjectId,
  signal,
  apiCall = onebot,
  fetcher = fetchQqFile,
  maxBytes,
  sizeErrorCode,
  downloadErrorCode,
}) {
  const data = segment.data ?? segment;
  const filename = String(data.name ?? data.file_name ?? data.file ?? '');
  if (/[\x00-\x1f]/.test(filename)) throw receiveError('invalid_file_metadata', 'Invalid QQ file name');
  if (Number(data.size ?? data.file_size) > maxBytes) throw receiveError(sizeErrorCode, 'File exceeds size limit');
  const fileId = String(data.file_id ?? data.id ?? data.file ?? '');
  if (!fileId || fileId.length > 512 || /[\x00-\x1f]/.test(fileId)) throw receiveError('missing_qq_file_id', 'Missing QQ file ID');
  let size = 0; const chunks = [];
  try {
    const r = await apiCall(a, 'get_private_file_url', {user_id: Number(subjectId), file_id: fileId, file_hash: String(data.file_hash ?? '')}, signal);
    const url = qqFileUrl(r?.url);
    const stop = signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000);
    const response = await fetcher(url, {redirect: 'manual', signal: stop});
    if (response.status !== 200) throw receiveError(downloadErrorCode, 'QQ file download failed');
    if (Number(response.headers.get('content-length')) > maxBytes) throw receiveError(sizeErrorCode, 'File exceeds size limit');
    for await (const part of response.body) {
      size += part.length;
      if (size > maxBytes) throw receiveError(sizeErrorCode, 'File exceeds size limit');
      chunks.push(Buffer.from(part));
    }
  } catch (error) {
    signal?.throwIfAborted();
    // Do not expose signed URLs, platform errors or response bodies in the model-facing result.
    if (error?.code === sizeErrorCode) throw error;
    throw receiveError(downloadErrorCode, 'QQ file download failed');
  }
  return {filename, fileId, bytes: Buffer.concat(chunks)};
}

export async function stagePdf(segment, cfg, {subjectId, signal, apiCall = onebot, fetcher = fetchQqFile, inspect} = {}) {
  const a = account(cfg), data = segment.data ?? segment;
  subjectId ??= a.ownerId;
  activeSubject(cfg, subjectId, 'papers.import');
  const rawName = String(data.name ?? data.file_name ?? data.file ?? '');
  if (!/\.pdf$/i.test(rawName)) throw receiveError('unsupported_file_type', 'Only PDF uploads are accepted');
  const {filename, fileId, bytes} = await downloadPrivateQqFile(a, segment, {
    subjectId,
    signal,
    apiCall,
    fetcher,
    maxBytes: MAX_PDF_BYTES,
    sizeErrorCode: 'pdf_size_limit_exceeded',
    downloadErrorCode: 'pdf_download_failed',
  });
  activeSubject(cfg, subjectId, 'papers.import');
  return new Documents(documentRoot(cfg,subjectId)).add(bytes, {filename, source: {type: 'qq', fileId}}, {signal,
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

export async function stageAttachment(segment, cfg, {
  subjectId,
  signal,
  apiCall = onebot,
  fetcher = fetchQqFile,
  inspect,
  messageId,
  sessionKey,
  now = Date.now,
} = {}) {
  const a = account(cfg), data = segment.data ?? segment;
  subjectId ??= a.ownerId;
  const rawName = String(data.name ?? data.file_name ?? data.file ?? '');
  const fileType = /\.([a-z0-9]{1,16})$/i.exec(rawName)?.[1].toLowerCase() ?? 'unknown';
  if (fileType === 'pdf') {
    const doc = await stagePdf(segment, cfg, {subjectId, signal, apiCall, fetcher, inspect});
    return {...doc, kind: 'pdf'};
  }
  if (!OWNER_WORKSPACE_FILE_TYPES.includes(fileType)) {
    throw receiveError('unsupported_file_type', 'Unsupported QQ attachment type');
  }
  const subject = activeSubject(cfg, subjectId);
  if (subject.role !== 'owner' || subject.permissions['files.manage'] !== true) {
    throw receiveError('unsupported_file_type', 'Workspace file staging requires owner files.manage');
  }
  const filesEntry = cfg.plugins?.entries?.['kurumi-files'];
  if (!filesEntry || filesEntry.enabled !== true || !filesEntry.config?.defaultWorkspace) {
    throw receiveError('unsupported_file_type', 'Workspace file staging is not enabled');
  }
  const {filename, bytes} = await downloadPrivateQqFile(a, segment, {
    subjectId,
    signal,
    apiCall,
    fetcher,
    maxBytes: MAX_WORKSPACE_FILE_BYTES,
    sizeErrorCode: 'file_size_limit_exceeded',
    downloadErrorCode: 'file_download_failed',
  });
  activeSubject(cfg, subjectId, 'files.manage');

  const dayDir = shanghaiDayString(now());
  const {cfg: filesCfg, redlineList, directory} = ensureWorkspaceSubdir(filesEntry.config, ['qq-inbox', dayDir]);
  const fileHash = bufferSha256(bytes);
  const safeName = sanitizeWorkspaceFilename(filename, fileType);
  const targetPath = path.join(directory, `${fileHash.slice(0, 12)}_${safeName}`);
  const safeTarget = resolveSafePath(targetPath, filesCfg, redlineList, {forWrite: true, allowRootItself: false});

  if (safeTarget.exists) {
    const existing = readFileSync(safeTarget.canonicalPath);
    if (bufferSha256(existing) !== fileHash) {
      const tmp = path.join(directory, `.tmp-${process.pid}-${Date.now()}-${safeName}`);
      writeFileSync(tmp, bytes, {mode: 0o600});
      renameSync(tmp, safeTarget.canonicalPath);
      chmodSync(safeTarget.canonicalPath, 0o600);
    }
  } else {
    const tmp = path.join(directory, `.tmp-${process.pid}-${Date.now()}-${safeName}`);
    writeFileSync(tmp, bytes, {mode: 0o600});
    renameSync(tmp, safeTarget.canonicalPath);
    chmodSync(safeTarget.canonicalPath, 0o600);
  }

  traceWorkspaceFile(a, {
    kind: 'qq.workspace_file_receive',
    correlation: {
      ...(messageId ? {qqMessageId: String(messageId)} : {}),
      ...(sessionKey ? {sessionKey: String(sessionKey)} : {}),
    },
    data: {
      fileType,
      sizeBytes: bytes.length,
      sha256: fileHash,
      status: 'staged_to_workspace',
    },
  });

  return {
    kind: 'workspace_file',
    path: safeTarget.canonicalPath,
    sha256: fileHash,
    sizeBytes: bytes.length,
  };
}
stageAttachment.supportsWorkspaceFiles = true;
const filePrefix = (account, peer) => peer === account.ownerId ? 'pdf:' : 'pdf:subject:' + peer + ':';

function fileAttempt(row, prefix, documentId) {
  let data;
  try { data = JSON.parse(row.message_id); } catch {}
  if (data?.documentId && data.documentId !== documentId) return undefined;
  const job = /^(job_[a-f0-9]{24}):(dual|mono)$/u.exec(row.id.slice(prefix.length));
  const accepted = row.status === 'sent' && data?.documentId === documentId &&
    data.channel === 'kurumi-qq' && data.status === 'platform_accepted';
  const platformStatus = accepted ? 'accepted' : row.status === 'failed' ? 'rejected' : 'unknown';
  return {
    platformStatus, attemptedAt: new Date(row.at).toISOString(),
    source: job ? 'translation_job' : 'file_upload',
    ...(job && {jobId: job[1], kind: job[2]}),
    ...(accepted && data.fileId != null && {fileId: data.fileId}),
  };
}

/** Read existing upload receipts for one authorized artifact, including explicitly requested resends. */
export function readDocumentDeliveries({cfg, to, documentId, key}) {
  const a = account(cfg), peer = targetSubject(to, cfg, 'papers.read').qq;
  const prefix = filePrefix(a, peer);
  const file = path.join(a.stateDir, 'channel.sqlite');
  if (!existsSync(file)) return {attempts: [], truncated: false};
  const db = new DatabaseSync(file, {readOnly: true});
  try {
    // File rows store a JSON reference in the receipt field. Legacy sent rows already
    // contain the ID. Pre-upgrade unresolved automatic rows can be joined by the job key.
    const rows = db.prepare(`
      SELECT id, status, message_id, at FROM outbound
      WHERE id GLOB ? AND id NOT GLOB ?
        AND CASE WHEN json_valid(message_id) THEN json_extract(message_id, '$.documentId') END = ?
      ORDER BY at DESC, rowid DESC LIMIT 11
    `).all(prefix + '*', peer === a.ownerId ? 'pdf:subject:*' : '', documentId);
    const row = key && db.prepare('SELECT id, status, message_id, at FROM outbound WHERE id = ?').get(prefix + key);
    return {
      attempts: rows.slice(0, 10).map(item => fileAttempt(item, prefix, documentId)),
      truncated: rows.length > 10,
      automatic: row ? fileAttempt(row, prefix, documentId) : undefined,
    };
  } finally { db.close(); }
}

export async function sendDocument({cfg, to, documentId, key, signal, apiCall = onebot}) {
  const a = account(cfg),target=targetSubject(to,cfg,'qq.file.reply').qq; signal?.throwIfAborted();
  const doc = new Documents(documentRoot(cfg,target)).get(documentId);
  if (!key || typeof key !== 'string') throw Error('Stable file delivery key required');
  const ledger = new Ledger(a.stateDir);
  try {
    const deliveryKey = filePrefix(a, target) + key;
    const prior = ledger.reserve(deliveryKey, a.sendLimit, a.dailySendLimit ?? 120, undefined, JSON.stringify({documentId}));
    if (prior) {
      const receipt = JSON.parse(prior.message_id);
      if (receipt?.documentId && receipt.documentId !== documentId) throw Error('File delivery key reused with a different PDF');
      if (prior.status === 'sent' && receipt?.documentId === documentId) return {...receipt, duplicate: true};
      throw Error('Previous PDF delivery unresolved/failed; manual reconciliation required');
    }
    try {
      signal?.throwIfAborted();
      targetSubject(to,cfg,'qq.file.reply');
      const r = await apiCall(a, 'upload_private_file', {user_id: Number(target), file: doc.path, name: doc.filename}, signal, {timeoutMs:120000});
      // OneBot upload success often returns null, without a QQ message ID. Do not invent one.
      const receipt = {channel: 'kurumi-qq', status: 'platform_accepted', documentId, fileId: r?.file_id ?? null};
      ledger.sent(deliveryKey, JSON.stringify(receipt));
      traceFile(cfg, {kind: 'paper.qq_upload', data: receipt}); return receipt;
    } catch (e) {
      if (e.rejected) ledger.failed(deliveryKey);
      traceFile(cfg, {kind: 'paper.qq_upload', data: {documentId, status: e.rejected ? 'rejected' : 'unknown'}});
      throw e;
    }
  } finally { ledger.close(); }
}
