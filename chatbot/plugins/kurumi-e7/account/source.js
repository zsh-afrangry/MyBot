// Local account imports. The only external write is the operator-confirmed original PCAP submission.
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {AccountExportError} from './projection.js';

export const E7BOT = 'https://e7bot.top';
const PCAP_MAX = 25 * 1024 * 1024;
const JSON_MAX = 24 * 1024 * 1024;
const META_MAX = 4 * 1024 * 1024;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const stop = (signal, ms) => signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
const bad = message => {throw new AccountExportError(message);};

async function readFile(file, maxBytes) {
  const fd = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await fd.stat();
    if (!before.isFile() || before.size < 1 || before.size > maxBytes) bad('文件类型或大小超出限制');
    const bytes = Buffer.alloc(before.size);
    for (let offset = 0; offset < bytes.length;) {
      const {bytesRead} = await fd.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) bad('文件已变动，请重新选择');
      offset += bytesRead;
    }
    const after = await fd.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) bad('文件已变动，请重新选择');
    return bytes;
  } finally {await fd.close();}
}

export async function readAccountJson(file) {
  return parseJson(await readFile(file, JSON_MAX));
}

function parseJson(bytes) {
  try {
    // A source may encode an instance ID as an unquoted decimal integer. Retain the exact digits.
    return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/u, ''), (key, value, context) =>
      (key === 'id' || key === 'p') && typeof value === 'number' && !Number.isSafeInteger(value) && /^\d+$/u.test(context?.source ?? '')
        ? context.source : value);
  }
  catch {bad('JSON 格式无效');}
}

export function inspectPcap(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 40 || bytes.length > PCAP_MAX) bad('PCAP 文件大小超出范围');
  const magic = bytes.toString('hex', 0, 4);
  if (!['d4c3b2a1', 'a1b2c3d4', '4d3cb2a1', 'a1b23c4d'].includes(magic)) bad('仅支持经典 PCAP 格式');
  const le = ['d4c3b2a1', '4d3cb2a1'].includes(magic);
  const u16 = offset => le ? bytes.readUInt16LE(offset) : bytes.readUInt16BE(offset);
  const u32 = offset => le ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset);
  const precision = ['d4c3b2a1', 'a1b2c3d4'].includes(magic) ? 1000000 : 1000000000;
  const snapLength = u32(16), linkType = u32(20) & 0xffff;
  if (u16(4) !== 2 || u16(6) !== 4 || !snapLength || snapLength > 262144) bad('不支持此 PCAP 版本或截取长度');
  let packetCount = 0, startedAt, stoppedAt, offset = 24;
  while (offset < bytes.length) {
    if (bytes.length - offset < 16) bad('PCAP 包头被截断');
    const seconds = u32(offset), subsecond = u32(offset + 4), length = u32(offset + 8), original = u32(offset + 12);
    if (subsecond >= precision || !length || length > snapLength || length > original || offset + 16 + length > bytes.length) bad('PCAP 包边界无效');
    startedAt ??= seconds;
    stoppedAt = seconds;
    packetCount++;
    offset += 16 + length;
  }
  if (!packetCount || stoppedAt < startedAt) bad('PCAP 没有有效时间范围');
  return {packetCount, startedAt, stoppedAt, linkType, bytes: bytes.length, sha256: sha256(bytes)};
}

export async function readCapture(file) {
  const bytes = await readFile(file, PCAP_MAX);
  const name = path.basename(file).replace(/[^A-Za-z0-9_.-]/g, '_').slice(-160);
  return {name, bytes, facts: inspectPcap(bytes)};
}

async function readResponse(response, maxBytes) {
  try {
    if (response.status !== 200) bad('E7Bot HTTP ' + response.status);
    if (!response.body || Number(response.headers.get('content-length')) > maxBytes) bad('E7Bot 数据超出大小限制');
    const parts = [];
    let size = 0;
    for await (const part of response.body) {
      size += part.byteLength;
      if (size > maxBytes) bad('E7Bot 数据超出大小限制');
      parts.push(Buffer.from(part));
    }
    return Buffer.concat(parts);
  } finally {try {await response.body?.cancel();} catch {}}
}

function metadataAsset(manifest) {
  const a = manifest?.metadata;
  if (!a || manifest.schemaVersion !== 1 || a.encoding !== 'gzip'
    || !/^[0-9a-f]{64}$/u.test(a.sha256 ?? '') || a.url !== '/api/client/account-heroes/files/' + a.sha256 + '.json.gz'
    || !Number.isInteger(a.size) || a.size < 1 || a.size > META_MAX) bad('E7Bot 图鉴清单格式无效');
  return a;
}

export function checkedMetadata(manifest, compressed) {
  const {size, sha256: expected} = metadataAsset(manifest);
  if (compressed.length !== size || sha256(compressed) !== expected) bad('E7Bot 图鉴大小或 SHA-256 不匹配');
  let unpacked;
  try {unpacked = gunzipSync(compressed, {maxOutputLength: JSON_MAX});}
  catch {bad('E7Bot 图鉴解压失败或超过大小限制');}
  const data = parseJson(unpacked);
  if (data?.version !== 'account-heroes-meta-v6') bad('当前只支持 account-heroes-meta-v6 图鉴');
  return data;
}

export async function loadE7BotMetadata({manifestFile, metadataFile, fetcher = fetch, signal} = {}) {
  if (manifestFile || metadataFile) {
    if (!manifestFile || !metadataFile) bad('离线图鉴需要同时提供清单和压缩包');
    return checkedMetadata(await readAccountJson(manifestFile), await readFile(metadataFile, META_MAX));
  }
  const opts = {redirect: 'error', credentials: 'omit', signal: stop(signal, 20000)};
  const manifestResponse = await fetcher(E7BOT + '/api/client/account-heroes/manifest', opts);
  const manifest = parseJson(await readResponse(manifestResponse, 1024 * 1024));
  const asset = metadataAsset(manifest);
  const fileResponse = await fetcher(E7BOT + asset.url, opts);
  return checkedMetadata(manifest, await readResponse(fileResponse, META_MAX));
}

export function parsedAccount(result) {
  const sources = result?.account_data?.sources;
  if (result?.status !== 'parsed' || !Array.isArray(sources?.equips) || !Array.isArray(sources?.units)) bad('E7Bot 未返回已解析的装备与英雄数据');
  return {equips: sources.equips, units: sources.units};
}

export function assertCaptureApproval(capture, digest) {
  const facts = inspectPcap(capture.bytes);
  if (facts.sha256 !== capture.facts.sha256 || digest !== facts.sha256) bad('未提供向 e7bot.top 发送这一版 PCAP 的确认 SHA-256');
  // This implementation uses the Android VPN capture profile verified for the supplied reference.
  if (facts.linkType !== 101) bad('上传入口只支持 Android VPN 的 Raw IP PCAP');
  return facts;
}

export async function submitAndroidCapture(capture, digest, {fetcher = fetch, signal} = {}) {
  const facts = assertCaptureApproval(capture, digest);
  const form = new FormData();
  const fields = {client_version: '1.5.6', os: 'android', arch: 'unknown', interface: 'android-vpn',
    filter: 'tcp and (port 5222 or port 5333 or port 3333)', capture_categories: 'heroes,equipment',
    started_at: facts.startedAt, stopped_at: facts.stoppedAt, sha256: facts.sha256, file_size: facts.bytes};
  for (const [name, value] of Object.entries(fields)) form.set(name, String(value));
  form.set('file', new Blob([capture.bytes], {type: 'application/vnd.tcpdump.pcap'}), capture.name);
  const response = await fetcher(E7BOT + '/captures', {method: 'POST', redirect: 'error', credentials: 'omit', signal: stop(signal, 60000), body: form});
  return parsedAccount(parseJson(await readResponse(response, JSON_MAX)));
}
