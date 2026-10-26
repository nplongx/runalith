// Validate portable archive-relative names independently of the host OS.
// Windows drive-absolute and drive-relative names must be rejected on POSIX
// too, otherwise a later Windows extractor can reinterpret an accepted entry.
export function isSafePortableArchivePath(name) {
  return typeof name === 'string' && name.length > 0 && !name.startsWith('/') && !name.startsWith('-') &&
    !/^[a-zA-Z]:/.test(name) && !name.includes('\\') && !/[\u0000-\u001f\u007f]/.test(name) &&
    name.split('/').every(part => part && part !== '.' && part !== '..');
}

// Validate ZIP central-directory entry types without extracting untrusted data.
// Callers must validate every path with isSafePortableArchivePath as well.
function uint64(bytes, offset, label) {
  if (offset < 0 || offset + 8 > bytes.length) throw new Error(`ZIP has truncated ${label}`);
  const value = bytes.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`ZIP ${label} exceeds the supported range`);
  return Number(value);
}

function parseExtraFields(bytes, start, length, label) {
  const fields = new Map();
  const end = start + length;
  if (start < 0 || end > bytes.length) throw new Error(`ZIP has out-of-bounds ${label} extra fields`);
  let cursor = start;
  while (cursor < end) {
    if (cursor + 4 > end) throw new Error(`ZIP has a truncated ${label} extra-field header`);
    const id = bytes.readUInt16LE(cursor);
    const size = bytes.readUInt16LE(cursor + 2);
    const fieldStart = cursor + 4;
    const fieldEnd = fieldStart + size;
    if (fieldEnd > end) throw new Error(`ZIP has a truncated ${label} extra field`);
    if (fields.has(id)) throw new Error(`ZIP has duplicate ${label} extra field 0x${id.toString(16)}`);
    fields.set(id, { start: fieldStart, end: fieldEnd, size });
    cursor = fieldEnd;
  }
  return fields;
}

function zip64EntryValues(bytes, extraFields, requirements, label) {
  const required = requirements.some(([, needed]) => needed);
  if (!required) return {};
  const field = extraFields.get(0x0001);
  if (!field) throw new Error(`ZIP has missing ${label} ZIP64 extended-information extra field`);
  let cursor = field.start;
  const output = {};
  for (const [name, needed, width] of requirements) {
    if (!needed) continue;
    if (cursor + width > field.end) throw new Error(`ZIP has truncated ${label} ZIP64 ${name}`);
    if (width === 8) output[name] = uint64(bytes, cursor, `${label} ZIP64 ${name}`);
    else output[name] = bytes.readUInt32LE(cursor);
    cursor += width;
  }
  if (cursor > field.end) throw new Error(`ZIP has invalid ${label} ZIP64 extra field length`);
  return output;
}

function decodeEntryName(nameBytes, flags, label) {
  if (!nameBytes.length) throw new Error(`ZIP has an empty ${label} entry name`);
  if (flags & 0x0800) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(nameBytes); }
    catch { throw new Error(`ZIP has invalid UTF-8 in ${label} entry name`); }
  }
  return nameBytes.toString('latin1');
}

export function validateZipEntryTypes(bytes) {
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) throw new TypeError('ZIP archive must be bytes');
  bytes = Buffer.from(bytes);
  if (bytes.length < 22) throw new Error('archive is not a complete ZIP file');
  const minEocd = Math.max(0, bytes.length - 22 - 0xffff);
  let eocd = -1;
  for (let cursor = bytes.length - 22; cursor >= minEocd; cursor--) {
    if (bytes.readUInt32LE(cursor) !== 0x06054b50) continue;
    if (cursor + 22 + bytes.readUInt16LE(cursor + 20) === bytes.length) { eocd = cursor; break; }
  }
  if (eocd < 0) throw new Error('archive is not a complete ZIP file');

  let entryCount = bytes.readUInt16LE(eocd + 10);
  let centralSize = bytes.readUInt32LE(eocd + 12);
  let centralOffset = bytes.readUInt32LE(eocd + 16);
  const disk = bytes.readUInt16LE(eocd + 4);
  const centralDisk = bytes.readUInt16LE(eocd + 6);
  const diskEntries = bytes.readUInt16LE(eocd + 8);
  const hasZip64Sentinel = entryCount === 0xffff || diskEntries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff;
  if (disk !== 0 || centralDisk !== 0 || (entryCount !== diskEntries && !hasZip64Sentinel)) {
    throw new Error('ZIP uses unsupported multi-disk layout');
  }
  const locatorOffset = eocd - 20;
  const hasZip64Locator = locatorOffset >= 0 && bytes.readUInt32LE(locatorOffset) === 0x07064b50;
  if (hasZip64Sentinel || hasZip64Locator) {
    if (!hasZip64Locator) throw new Error('ZIP has missing ZIP64 end record');
    const zip64Offset = uint64(bytes, locatorOffset + 8, 'ZIP64 end-record offset');
    if (zip64Offset + 56 > bytes.length || bytes.readUInt32LE(zip64Offset) !== 0x06064b50) {
      throw new Error('ZIP has an invalid ZIP64 end record');
    }
    if (bytes.readUInt32LE(zip64Offset + 16) !== 0 || bytes.readUInt32LE(zip64Offset + 20) !== 0) {
      throw new Error('ZIP uses unsupported multi-disk ZIP64 layout');
    }
    const perDiskCount = uint64(bytes, zip64Offset + 24, 'ZIP64 per-disk entry count');
    entryCount = uint64(bytes, zip64Offset + 32, 'ZIP64 entry count');
    if (perDiskCount !== entryCount) throw new Error('ZIP has inconsistent ZIP64 entry counts');
    centralSize = uint64(bytes, zip64Offset + 40, 'ZIP64 central-directory size');
    centralOffset = uint64(bytes, zip64Offset + 48, 'ZIP64 central-directory offset');
  }
  const centralEnd = centralOffset + centralSize;
  if (!Number.isSafeInteger(centralEnd) || centralOffset < 0 || centralEnd > bytes.length || centralEnd > eocd) {
    throw new Error('ZIP has an out-of-bounds central directory');
  }

  let cursor = centralOffset;
  const entryNames = new Set();
  const canonicalNames = new Set();
  const localOffsets = new Set();
  const localRanges = [];
  for (let entry = 0; entry < entryCount; entry++) {
    if (cursor + 46 > centralEnd || bytes.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error('ZIP has a malformed central-directory entry');
    }
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const end = cursor + 46 + nameLength + extraLength + commentLength;
    if (end > centralEnd) throw new Error('ZIP has a truncated central-directory entry');
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const name = decodeEntryName(nameBytes, flags, 'central-directory');
    if (entryNames.has(name)) throw new Error(`ZIP contains a duplicate entry name: ${JSON.stringify(name)}`);
    entryNames.add(name);
    const canonicalName = name.endsWith('/') ? name.slice(0, -1) : name;
    if (canonicalNames.has(canonicalName)) throw new Error(`ZIP has ambiguous file/directory entry names: ${JSON.stringify(name)}`);
    canonicalNames.add(canonicalName);
    if (flags & (0x0001 | 0x0040 | 0x2000)) throw new Error(`ZIP uses encrypted or masked entry data: ${JSON.stringify(name)}`);
    const crc32 = bytes.readUInt32LE(cursor + 16);
    let compressedSize = bytes.readUInt32LE(cursor + 20);
    let uncompressedSize = bytes.readUInt32LE(cursor + 24);
    const diskStart = bytes.readUInt16LE(cursor + 34);
    let localOffset = bytes.readUInt32LE(cursor + 42);
    const extraFields = parseExtraFields(bytes, cursor + 46 + nameLength, extraLength, 'central-directory');
    const zip64 = zip64EntryValues(bytes, extraFields, [
      ['uncompressed size', uncompressedSize === 0xffffffff, 8],
      ['compressed size', compressedSize === 0xffffffff, 8],
      ['local-header offset', localOffset === 0xffffffff, 8],
      ['disk start', diskStart === 0xffff, 4]
    ], 'central-directory');
    if (uncompressedSize === 0xffffffff) uncompressedSize = zip64['uncompressed size'];
    if (compressedSize === 0xffffffff) compressedSize = zip64['compressed size'];
    if (localOffset === 0xffffffff) localOffset = zip64['local-header offset'];
    if (diskStart !== 0 && !(diskStart === 0xffff && zip64['disk start'] === 0)) {
      throw new Error(`ZIP entry is stored on an unsupported disk: ${JSON.stringify(name)}`);
    }
    if (localOffsets.has(localOffset)) throw new Error(`ZIP central-directory entries alias the same local header: ${JSON.stringify(name)}`);
    localOffsets.add(localOffset);
    if (!Number.isSafeInteger(localOffset) || localOffset < 0 || localOffset + 30 > centralOffset ||
        bytes.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`ZIP has an invalid or overlapping local file header: ${JSON.stringify(name)}`);
    }
    const localFlags = bytes.readUInt16LE(localOffset + 6);
    const localMethod = bytes.readUInt16LE(localOffset + 8);
    const localCrc32 = bytes.readUInt32LE(localOffset + 14);
    let localCompressedSize = bytes.readUInt32LE(localOffset + 18);
    let localUncompressedSize = bytes.readUInt32LE(localOffset + 22);
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const localNameStart = localOffset + 30;
    const localExtraStart = localNameStart + localNameLength;
    const dataStart = localExtraStart + localExtraLength;
    if (dataStart > centralOffset || !bytes.subarray(localNameStart, localExtraStart).equals(nameBytes)) {
      throw new Error(`ZIP local/central filenames disagree or local header is truncated: ${JSON.stringify(name)}`);
    }
    if (localFlags !== flags || localMethod !== method) {
      throw new Error(`ZIP local/central flags or compression method disagree: ${JSON.stringify(name)}`);
    }
    const localExtras = parseExtraFields(bytes, localExtraStart, localExtraLength, 'local-header');
    const localZip64 = zip64EntryValues(bytes, localExtras, [
      ['uncompressed size', localUncompressedSize === 0xffffffff, 8],
      ['compressed size', localCompressedSize === 0xffffffff, 8]
    ], 'local-header');
    if (localUncompressedSize === 0xffffffff) localUncompressedSize = localZip64['uncompressed size'];
    if (localCompressedSize === 0xffffffff) localCompressedSize = localZip64['compressed size'];
    if (!(flags & 0x0008) && (localCrc32 !== crc32 || localCompressedSize !== compressedSize || localUncompressedSize !== uncompressedSize)) {
      throw new Error(`ZIP local/central CRC or sizes disagree: ${JSON.stringify(name)}`);
    }
    const dataEnd = dataStart + compressedSize;
    if (!Number.isSafeInteger(dataEnd) || dataEnd < dataStart || dataEnd > centralOffset) {
      throw new Error(`ZIP entry payload overlaps the central directory: ${JSON.stringify(name)}`);
    }
    let rangeEnd = dataEnd;
    if (flags & 0x0008) {
      const descriptorHasSignature = rangeEnd + 4 <= centralOffset && bytes.readUInt32LE(rangeEnd) === 0x08074b50;
      const descriptorStart = rangeEnd + (descriptorHasSignature ? 4 : 0);
      const zip64Descriptor = compressedSize > 0xffffffff || uncompressedSize > 0xffffffff ||
        bytes.readUInt32LE(localOffset + 18) === 0xffffffff || bytes.readUInt32LE(localOffset + 22) === 0xffffffff;
      const descriptorBodyLength = 4 + (zip64Descriptor ? 16 : 8);
      if (descriptorStart + descriptorBodyLength > centralOffset || descriptorStart + descriptorBodyLength > bytes.length) {
        throw new Error(`ZIP data descriptor is truncated: ${JSON.stringify(name)}`);
      }
      if (bytes.readUInt32LE(descriptorStart) !== crc32) throw new Error(`ZIP data-descriptor CRC disagrees with central directory: ${JSON.stringify(name)}`);
      if (zip64Descriptor) {
        if (uint64(bytes, descriptorStart + 4, `${name} data-descriptor compressed size`) !== compressedSize ||
            uint64(bytes, descriptorStart + 12, `${name} data-descriptor uncompressed size`) !== uncompressedSize) {
          throw new Error(`ZIP data-descriptor sizes disagree with central directory: ${JSON.stringify(name)}`);
        }
      } else if (bytes.readUInt32LE(descriptorStart + 4) !== compressedSize || bytes.readUInt32LE(descriptorStart + 8) !== uncompressedSize) {
        throw new Error(`ZIP data-descriptor sizes disagree with central directory: ${JSON.stringify(name)}`);
      }
      rangeEnd = descriptorStart + descriptorBodyLength;
    }
    localRanges.push({ start: localOffset, end: rangeEnd, name });
    const madeByOs = bytes.readUInt16LE(cursor + 4) >>> 8;
    const attributes = bytes.readUInt32LE(cursor + 38);
    if (madeByOs === 3 || madeByOs === 19) {
      const type = (attributes >>> 16) & 0xf000;
      if (type !== 0 && type !== 0x8000 && type !== 0x4000) {
        throw new Error(`ZIP contains a symlink or special entry: ${JSON.stringify(name)}`);
      }
      if ((type === 0x4000 && !name.endsWith('/')) || (type === 0x8000 && name.endsWith('/'))) {
        throw new Error(`ZIP entry type conflicts with path: ${JSON.stringify(name)}`);
      }
    }
    cursor = end;
  }
  if (cursor !== centralEnd) throw new Error('ZIP central-directory length is inconsistent');
  localRanges.sort((a, b) => a.start - b.start);
  for (let index = 1; index < localRanges.length; index += 1) {
    if (localRanges[index].start < localRanges[index - 1].end) {
      throw new Error(`ZIP local entry byte ranges overlap: ${JSON.stringify(localRanges[index - 1].name)} and ${JSON.stringify(localRanges[index].name)}`);
    }
  }
  return { entries: entryCount, central_directory_bytes: centralSize };
}
