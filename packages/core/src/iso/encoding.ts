// Low-level encoders for ISO 9660 (ECMA-119) and UDF 1.02 (ECMA-167 3rd edition + OSTA UDF 1.02).

export const SECTOR = 2048;
export const UDF_REVISION = 0x0102;
export const IMPLEMENTATION_ID = '*SENA MP4 to IFO';

/** CRC-16/CCITT as ECMA-167 7.2.6 defines it: x^16 + x^12 + x^5 + 1, initial 0, no reflection. */
export function crc16(data: Uint8Array): number {
  let crc = 0;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

export function tagChecksum(b: Buffer, offset = 0): number {
  let sum = 0;
  for (let i = 0; i < 16; i++) if (i !== 4) sum = (sum + (b[offset + i] ?? 0)) & 0xff;
  return sum;
}

/**
 * Fill in a descriptor tag (ECMA-167 7.2) in place. `descriptor` is exactly the descriptor
 * (its length defines the CRC length).
 */
export function finishTag(descriptor: Buffer, tagId: number, location: number): Buffer {
  descriptor.writeUInt16LE(tagId, 0);
  descriptor.writeUInt16LE(2, 2); // descriptor version 2 (NSR02)
  descriptor[5] = 0;
  descriptor.writeUInt16LE(0, 6); // tag serial number
  descriptor.writeUInt16LE(crc16(descriptor.subarray(16)), 8);
  descriptor.writeUInt16LE(descriptor.length - 16, 10);
  descriptor.writeUInt32LE(location, 12);
  descriptor[4] = tagChecksum(descriptor);
  return descriptor;
}

/** OSTA CS0 d-string in a fixed field: compression id 8, bytes, last byte = recorded length. */
export function dstring(text: string, fieldLength: number): Buffer {
  const b = Buffer.alloc(fieldLength);
  if (!text) return b;
  if (!/^[\x20-\x7e]*$/.test(text)) throw new Error('dstring supports printable ASCII only');
  const bytes = Buffer.from(text, 'latin1').subarray(0, fieldLength - 2);
  b[0] = 8;
  bytes.copy(b, 1);
  b[fieldLength - 1] = bytes.length + 1;
  return b;
}

/** OSTA CS0 d-characters without the length byte (file identifiers). */
export function dchars(text: string): Buffer {
  return Buffer.concat([Buffer.from([8]), Buffer.from(text, 'latin1')]);
}

export function charspec(): Buffer {
  const b = Buffer.alloc(64);
  b[0] = 0; // CS0
  b.write('OSTA Compressed Unicode', 1, 'latin1');
  return b;
}

/** EntityID (regid): flags, 23-byte identifier, 8-byte suffix. */
export function regid(identifier: string, suffix: Buffer = Buffer.alloc(0)): Buffer {
  const b = Buffer.alloc(32);
  b.write(identifier, 1, 23, 'latin1');
  suffix.copy(b, 24, 0, 8);
  return b;
}

/** Domain / UDF identifier suffix: UDF revision (+ flags / OS info). */
export function udfSuffix(extra: number[] = []): Buffer {
  const b = Buffer.alloc(8);
  b.writeUInt16LE(UDF_REVISION, 0);
  extra.forEach((v, i) => (b[2 + i] = v));
  return b;
}

export function implementationId(): Buffer {
  return regid(IMPLEMENTATION_ID); // OS class/identifier 0 (undefined)
}

/** ECMA-167 1/7.3 timestamp, UTC (type 1, offset 0). */
export function udfTimestamp(date: Date): Buffer {
  const b = Buffer.alloc(12);
  b.writeUInt16LE(0x1000, 0);
  b.writeInt16LE(date.getUTCFullYear(), 2);
  b[4] = date.getUTCMonth() + 1;
  b[5] = date.getUTCDate();
  b[6] = date.getUTCHours();
  b[7] = date.getUTCMinutes();
  b[8] = date.getUTCSeconds();
  b[9] = Math.floor(date.getUTCMilliseconds() / 10);
  return b;
}

export function extentAd(length: number, location: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeUInt32LE(length, 0);
  b.writeUInt32LE(location, 4);
  return b;
}

/** long_ad: extent length, lb_addr (block, partition reference), 6 bytes implementation use. */
export function longAd(length: number, block: number, partition = 0): Buffer {
  const b = Buffer.alloc(16);
  b.writeUInt32LE(length, 0);
  b.writeUInt32LE(block, 4);
  b.writeUInt16LE(partition, 8);
  return b;
}

// --- ISO 9660 -----------------------------------------------------------------

export function both16(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt16LE(n, 0);
  b.writeUInt16BE(n, 2);
  return b;
}

export function both32(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeUInt32LE(n, 0);
  b.writeUInt32BE(n, 4);
  return b;
}

/** Space-padded a-/d-characters field. */
export function isoText(text: string, length: number): Buffer {
  const b = Buffer.alloc(length, 0x20);
  b.write(text.slice(0, length), 0, 'latin1');
  return b;
}

/** 17-byte dec-datetime (8.4.26.1), UTC. */
export function isoDecDate(date: Date | null): Buffer {
  const b = Buffer.alloc(17, 0x30);
  if (!date) {
    b[16] = 0;
    return b;
  }
  const p = (n: number, w: number) => String(n).padStart(w, '0');
  b.write(
    `${p(date.getUTCFullYear(), 4)}${p(date.getUTCMonth() + 1, 2)}${p(date.getUTCDate(), 2)}` +
      `${p(date.getUTCHours(), 2)}${p(date.getUTCMinutes(), 2)}${p(date.getUTCSeconds(), 2)}` +
      `${p(Math.floor(date.getUTCMilliseconds() / 10), 2)}`,
    0,
    'latin1',
  );
  b[16] = 0;
  return b;
}

/** 7-byte directory record date (9.1.5), UTC. */
export function isoDirDate(date: Date): Buffer {
  return Buffer.from([
    date.getUTCFullYear() - 1900,
    date.getUTCMonth() + 1,
    date.getUTCDate(),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
    0,
  ]);
}

/** ISO 9660 directory record. `name` is raw bytes (0x00 = self, 0x01 = parent). */
export function isoDirRecord(name: Buffer, extent: number, size: number, isDir: boolean, date: Date): Buffer {
  const length = 33 + name.length + (name.length % 2 === 0 ? 1 : 0);
  const b = Buffer.alloc(length);
  b[0] = length;
  b[1] = 0;
  both32(extent).copy(b, 2);
  both32(size).copy(b, 10);
  isoDirDate(date).copy(b, 18);
  b[25] = isDir ? 2 : 0;
  both16(1).copy(b, 28);
  b[32] = name.length;
  name.copy(b, 33);
  return b;
}
