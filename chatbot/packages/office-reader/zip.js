import zlib from 'node:zlib';
import {officeFail} from './errors.js';

export const MAX_OFFICE_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_ZIP_ENTRIES = 2000;
export const MAX_ZIP_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

function validateEntryName(name) {
  if (!name || name.includes('\0') || name.startsWith('/') || name.includes('\\')) {
    officeFail('office_invalid_archive_path');
  }
  const parts = name.split('/');
  if (parts.some(seg => seg === '..' || seg === '.')) {
    officeFail('office_invalid_archive_path');
  }
  return name;
}

function findEocd(buf) {
  const minOffset = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= minOffset; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      const commentLen = buf.readUInt16LE(i + 20);
      if (i + 22 + commentLen === buf.length) return i;
    }
  }
  officeFail('office_corrupt_archive');
}

export function openZipArchive(rawBuffer) {
  if (!Buffer.isBuffer(rawBuffer)) officeFail('office_corrupt_archive');
  if (rawBuffer.length > MAX_OFFICE_FILE_BYTES) officeFail('office_file_too_large');
  if (rawBuffer.length < 22) officeFail('office_corrupt_archive');

  const eocdOffset = findEocd(rawBuffer);
  const diskNum = rawBuffer.readUInt16LE(eocdOffset + 4);
  const cdDisk = rawBuffer.readUInt16LE(eocdOffset + 6);
  const entriesOnDisk = rawBuffer.readUInt16LE(eocdOffset + 8);
  const totalEntries = rawBuffer.readUInt16LE(eocdOffset + 10);
  const cdSize = rawBuffer.readUInt32LE(eocdOffset + 12);
  const cdOffset = rawBuffer.readUInt32LE(eocdOffset + 16);

  if (diskNum !== 0 || cdDisk !== 0 || entriesOnDisk !== totalEntries) {
    officeFail('office_corrupt_archive');
  }
  if (totalEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    officeFail('office_zip_uncompressed_too_large');
  }
  if (totalEntries > MAX_ZIP_ENTRIES) {
    officeFail('office_zip_too_many_entries');
  }
  if (cdOffset + cdSize > eocdOffset) {
    officeFail('office_corrupt_archive');
  }

  const entries = new Map();
  let cursor = cdOffset;
  const cdEnd = cdOffset + cdSize;
  for (let idx = 0; idx < totalEntries; idx++) {
    if (cursor + 46 > cdEnd || rawBuffer.readUInt32LE(cursor) !== CD_SIG) {
      officeFail('office_corrupt_archive');
    }
    const flags = rawBuffer.readUInt16LE(cursor + 8);
    const method = rawBuffer.readUInt16LE(cursor + 10);
    const crc32 = rawBuffer.readUInt32LE(cursor + 16);
    const compressedSize = rawBuffer.readUInt32LE(cursor + 20);
    const uncompressedSize = rawBuffer.readUInt32LE(cursor + 24);
    const nameLen = rawBuffer.readUInt16LE(cursor + 28);
    const extraLen = rawBuffer.readUInt16LE(cursor + 30);
    const commentLen = rawBuffer.readUInt16LE(cursor + 32);
    const localHeaderOffset = rawBuffer.readUInt32LE(cursor + 42);

    const recordEnd = cursor + 46 + nameLen + extraLen + commentLen;
    if (recordEnd > cdEnd) officeFail('office_corrupt_archive');

    if ((flags & 0x01) !== 0) {
      officeFail('office_encrypted_not_supported');
    }
    if (uncompressedSize > MAX_ZIP_UNCOMPRESSED_BYTES) {
      officeFail('office_zip_uncompressed_too_large');
    }

    const name = validateEntryName(rawBuffer.toString('utf8', cursor + 46, cursor + 46 + nameLen));
    entries.set(name, {
      name,
      flags,
      method,
      crc32,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });
    cursor = recordEnd;
  }

  let totalDecompressed = 0;
  const cache = new Map();

  function readEntry(name) {
    const meta = entries.get(name);
    if (!meta) return null;
    if (cache.has(name)) return cache.get(name);

    const lh = meta.localHeaderOffset;
    if (lh + 30 > cdOffset || rawBuffer.readUInt32LE(lh) !== LOCAL_SIG) {
      officeFail('office_corrupt_archive');
    }
    const localFlags = rawBuffer.readUInt16LE(lh + 6);
    if ((localFlags & 0x01) !== 0) {
      officeFail('office_encrypted_not_supported');
    }
    const lNameLen = rawBuffer.readUInt16LE(lh + 26);
    const lExtraLen = rawBuffer.readUInt16LE(lh + 28);
    const dataStart = lh + 30 + lNameLen + lExtraLen;
    const dataEnd = dataStart + meta.compressedSize;
    if (dataEnd > cdOffset) {
      officeFail('office_corrupt_archive');
    }

    const remainingBudget = MAX_ZIP_UNCOMPRESSED_BYTES - totalDecompressed;
    if (meta.uncompressedSize > remainingBudget) {
      officeFail('office_zip_uncompressed_too_large');
    }

    const compressed = rawBuffer.subarray(dataStart, dataEnd);
    let out;
    if (meta.method === 0) {
      if (meta.compressedSize !== meta.uncompressedSize) officeFail('office_corrupt_archive');
      out = Buffer.from(compressed);
    } else if (meta.method === 8) {
      try {
        out = zlib.inflateRawSync(compressed, {maxOutputLength: remainingBudget});
      } catch (error) {
        if (error?.code === 'ERR_BUFFER_TOO_LARGE') {
          officeFail('office_zip_uncompressed_too_large');
        }
        officeFail('office_corrupt_archive');
      }
    } else {
      officeFail('office_corrupt_archive');
    }

    if (out.length > remainingBudget) {
      officeFail('office_zip_uncompressed_too_large');
    }
    if ((zlib.crc32(out) >>> 0) !== meta.crc32) {
      officeFail('office_corrupt_archive');
    }
    if (out.length !== meta.uncompressedSize) {
      officeFail('office_corrupt_archive');
    }

    totalDecompressed += out.length;
    cache.set(name, out);
    return out;
  }

  function readText(name) {
    const buf = readEntry(name);
    return buf ? buf.toString('utf8') : null;
  }

  return {
    entries,
    has: name => entries.has(name),
    readEntry,
    readText,
  };
}
