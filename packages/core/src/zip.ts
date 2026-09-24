// Minimal ZIP (store only) for VIDEO_TS.zip, with Zip64 when offsets or sizes need it, and a reader
// that checks structure and every entry's CRC. MPEG data does not compress, so nothing is deflated.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { ConversionError, throwIfAborted } from './errors.ts';

const LIMIT32 = 0xffffffff;

interface Entry {
  name: string;
  crc: number;
  size: number;
  offset: number;
  isDir: boolean;
}

function dosDateTime(date: Date): { time: number; date: number } {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

export interface ZipWriteOptions {
  date: Date;
  /** 'always' writes Zip64 records for every entry; lets tests check Zip64 without 4 GB of data. */
  zip64?: 'auto' | 'always';
  signal?: AbortSignal;
  onProgress?: (bytes: number, total: number) => void;
}

/**
 * Zip `<dir>` (a directory named e.g. VIDEO_TS) into `zipPath` with entries "VIDEO_TS/" and
 * "VIDEO_TS/<file>" for each regular file, in name order. The output must not exist.
 */
export async function writeZip(dir: string, zipPath: string, options: ZipWriteOptions): Promise<void> {
  const folder = path.basename(dir);
  const names = fs.readdirSync(dir).filter((n) => !n.startsWith('.')).sort();
  const stamp = dosDateTime(options.date);
  const total = names.reduce((s, n) => s + fs.statSync(path.join(dir, n)).size, 0);
  const fd = fs.openSync(zipPath, 'wx');
  let ok = false;
  let position = 0;
  const write = (buf: Buffer, at = position) => {
    let off = 0;
    while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off, at + off);
    if (at === position) position += buf.length;
  };
  const entries: Entry[] = [];
  const force = options.zip64 === 'always';
  try {
    const localHeader = (name: string, crc: number, size: number) => {
      const big = force || size >= LIMIT32;
      const nameBuf = Buffer.from(name, 'utf8');
      const h = Buffer.alloc(30);
      h.writeUInt32LE(0x04034b50, 0);
      h.writeUInt16LE(big ? 45 : 20, 4); // version needed
      h.writeUInt16LE(0x0800, 6); // UTF-8 names
      h.writeUInt16LE(0, 8); // stored
      h.writeUInt16LE(stamp.time, 10);
      h.writeUInt16LE(stamp.date, 12);
      h.writeUInt32LE(crc, 14);
      h.writeUInt32LE(big ? LIMIT32 : size, 18);
      h.writeUInt32LE(big ? LIMIT32 : size, 22);
      h.writeUInt16LE(nameBuf.length, 26);
      const extra = big ? zip64Extra([size, size]) : Buffer.alloc(0);
      h.writeUInt16LE(extra.length, 28);
      return Buffer.concat([h, nameBuf, extra]);
    };

    entries.push({ name: `${folder}/`, crc: 0, size: 0, offset: position, isDir: true });
    write(localHeader(`${folder}/`, 0, 0));
    const chunk = Buffer.alloc(4 * 1024 * 1024);
    let done = 0;
    for (const name of names) {
      const file = path.join(dir, name);
      const size = fs.statSync(file).size;
      const offset = position;
      const header = localHeader(`${folder}/${name}`, 0, size);
      write(header);
      let crc = 0;
      const src = fs.openSync(file, 'r');
      try {
        let n: number;
        while ((n = fs.readSync(src, chunk, 0, chunk.length, null)) > 0) {
          throwIfAborted(options.signal);
          const part = chunk.subarray(0, n);
          crc = zlib.crc32(part, crc);
          write(part);
          done += n;
          options.onProgress?.(done, total);
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      } finally {
        fs.closeSync(src);
      }
      const crcBuf = Buffer.alloc(4);
      crcBuf.writeUInt32LE(crc >>> 0);
      write(crcBuf, offset + 14); // patch the local header CRC
      entries.push({ name: `${folder}/${name}`, crc: crc >>> 0, size, offset, isDir: false });
    }

    const cdStart = position;
    for (const e of entries) {
      const nameBuf = Buffer.from(e.name, 'utf8');
      const bigSize = force || e.size >= LIMIT32;
      const bigOffset = force || e.offset >= LIMIT32;
      const needs = [bigSize ? e.size : null, bigSize ? e.size : null, bigOffset ? e.offset : null].filter((v): v is number => v !== null);
      const extra = needs.length ? zip64Extra(needs) : Buffer.alloc(0);
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0);
      c.writeUInt16LE((3 << 8) | 45, 4); // made by: Unix, 4.5
      c.writeUInt16LE(needs.length ? 45 : 20, 6);
      c.writeUInt16LE(0x0800, 8);
      c.writeUInt16LE(0, 10);
      c.writeUInt16LE(stamp.time, 12);
      c.writeUInt16LE(stamp.date, 14);
      c.writeUInt32LE(e.crc, 16);
      c.writeUInt32LE(bigSize ? LIMIT32 : e.size, 20);
      c.writeUInt32LE(bigSize ? LIMIT32 : e.size, 24);
      c.writeUInt16LE(nameBuf.length, 28);
      c.writeUInt16LE(extra.length, 30);
      c.writeUInt32LE((((e.isDir ? 0o40755 : 0o100644) << 16) | (e.isDir ? 0x10 : 0)) >>> 0, 38);
      c.writeUInt32LE(bigOffset ? LIMIT32 : e.offset, 42);
      write(Buffer.concat([c, nameBuf, extra]));
    }
    const cdSize = position - cdStart;
    const zip64 = force || cdStart >= LIMIT32 || cdSize >= LIMIT32 || entries.length >= 0xffff;
    if (zip64) {
      const eocd64At = position;
      const r = Buffer.alloc(56);
      r.writeUInt32LE(0x06064b50, 0);
      r.writeBigUInt64LE(44n, 4);
      r.writeUInt16LE((3 << 8) | 45, 12);
      r.writeUInt16LE(45, 14);
      r.writeBigUInt64LE(BigInt(entries.length), 24);
      r.writeBigUInt64LE(BigInt(entries.length), 32);
      r.writeBigUInt64LE(BigInt(cdSize), 40);
      r.writeBigUInt64LE(BigInt(cdStart), 48);
      write(r);
      const loc = Buffer.alloc(20);
      loc.writeUInt32LE(0x07064b50, 0);
      loc.writeBigUInt64LE(BigInt(eocd64At), 8);
      loc.writeUInt32LE(1, 16);
      write(loc);
    }
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(zip64 ? 0xffff : entries.length, 8);
    eocd.writeUInt16LE(zip64 ? 0xffff : entries.length, 10);
    eocd.writeUInt32LE(zip64 ? LIMIT32 : cdSize, 12);
    eocd.writeUInt32LE(zip64 ? LIMIT32 : cdStart, 16);
    write(eocd);
    fs.fsyncSync(fd);
    ok = true;
  } finally {
    fs.closeSync(fd);
    if (!ok) fs.rmSync(zipPath, { force: true });
  }
}

function zip64Extra(values: number[]): Buffer {
  const b = Buffer.alloc(4 + values.length * 8);
  b.writeUInt16LE(0x0001, 0);
  b.writeUInt16LE(values.length * 8, 2);
  values.forEach((v, i) => b.writeBigUInt64LE(BigInt(v), 4 + i * 8));
  return b;
}

export interface ZipEntryInfo {
  name: string;
  size: number;
  crc: number;
  crcOk: boolean;
  sha256: string | null;
}

/** Read the central directory, then stream every entry checking its CRC. Throws on structural errors. */
export async function readZip(zipPath: string, options: { signal?: AbortSignal } = {}): Promise<ZipEntryInfo[]> {
  const fd = fs.openSync(zipPath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const tailLen = Math.min(size, 65557);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);
    const eocdAt = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (eocdAt < 0) throw new ConversionError('ZIP_ERROR', 'End of central directory not found');
    let count = tail.readUInt16LE(eocdAt + 10);
    let cdSize = tail.readUInt32LE(eocdAt + 12);
    let cdStart = tail.readUInt32LE(eocdAt + 16);
    if (cdStart === LIMIT32 || cdSize === LIMIT32 || count === 0xffff) {
      const locAt = eocdAt - 20;
      if (locAt < 0 || tail.readUInt32LE(locAt) !== 0x07064b50) throw new ConversionError('ZIP_ERROR', 'Zip64 locator missing');
      const rec = Buffer.alloc(56);
      fs.readSync(fd, rec, 0, 56, Number(tail.readBigUInt64LE(locAt + 8)));
      if (rec.readUInt32LE(0) !== 0x06064b50) throw new ConversionError('ZIP_ERROR', 'Zip64 end record missing');
      count = Number(rec.readBigUInt64LE(32));
      cdSize = Number(rec.readBigUInt64LE(40));
      cdStart = Number(rec.readBigUInt64LE(48));
    }
    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdStart);
    const out: ZipEntryInfo[] = [];
    const chunk = Buffer.alloc(4 * 1024 * 1024);
    for (let p = 0, i = 0; i < count; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) throw new ConversionError('ZIP_ERROR', 'Central directory entry corrupt');
      if (cd.readUInt16LE(p + 10) !== 0) throw new ConversionError('ZIP_ERROR', 'Unexpected compression method');
      const crc = cd.readUInt32LE(p + 16);
      let sizeU = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      let offset = cd.readUInt32LE(p + 42);
      const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
      const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
      for (let q = 0; q + 4 <= extra.length;) {
        const id = extra.readUInt16LE(q);
        const len = extra.readUInt16LE(q + 2);
        if (id === 1) {
          let r = q + 4;
          if (sizeU === LIMIT32) {
            sizeU = Number(extra.readBigUInt64LE(r)); // uncompressed
            r += 16; // uncompressed + compressed
          }
          if (offset === LIMIT32) offset = Number(extra.readBigUInt64LE(r));
        }
        q += 4 + len;
      }
      p += 46 + nameLen + extraLen + commentLen;

      const lh = Buffer.alloc(30);
      fs.readSync(fd, lh, 0, 30, offset);
      if (lh.readUInt32LE(0) !== 0x04034b50) throw new ConversionError('ZIP_ERROR', `Local header missing for ${name}`);
      const dataStart = offset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
      let crcCalc = 0;
      const hash = crypto.createHash('sha256');
      let remaining = sizeU;
      let pos = dataStart;
      while (remaining > 0) {
        throwIfAborted(options.signal);
        const n = fs.readSync(fd, chunk, 0, Math.min(chunk.length, remaining), pos);
        if (n <= 0) throw new ConversionError('ZIP_ERROR', `${name} is truncated`);
        const part = chunk.subarray(0, n);
        crcCalc = zlib.crc32(part, crcCalc);
        hash.update(part);
        remaining -= n;
        pos += n;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      out.push({ name, size: sizeU, crc, crcOk: (crcCalc >>> 0) === crc, sha256: name.endsWith('/') ? null : hash.digest('hex') });
    }
    return out;
  } finally {
    fs.closeSync(fd);
  }
}
