// DVD-Video-only ISO 9660 + UDF 1.02 bridge writer. Not a general ISO library: the volume holds
// VIDEO_TS (placed where its IFOs say) and an empty AUDIO_TS, nothing else.
//
// Sector map (mirrors the mkisofs -dvd-video reference, docs/poc.md §9.2):
//   0-15 system area | 16 ISO PVD | 17 ISO terminator | 18-20 BEA01 NSR02 TEA01
//   32-37 UDF main VDS (PVD IUVD PD LVD USD TD) | 48-53 reserve VDS | 64-65 LVID + TD | 256 AVDP
//   257.. partition: FSD, TD, directory FEs + FIDs, file FEs | ISO path tables + directories
//   VIDEO_TS files at IFO-dictated offsets | last sector: second AVDP

import fs from 'node:fs';
import path from 'node:path';
import { ConversionError, throwIfAborted } from '../errors.ts';
import { readVideoTs, type VideoTsLayout } from '../dvd/layout.ts';
import {
  SECTOR, UDF_REVISION, both16, both32, charspec, dchars, dstring, extentAd, finishTag, implementationId, isoDecDate,
  isoDirRecord, isoText, longAd, regid, udfSuffix, udfTimestamp,
} from './encoding.ts';

export const VDS_MAIN = 32;
export const VDS_RESERVE = 48;
export const VDS_SECTORS = 16;
export const LVID_SECTOR = 64;
export const AVDP_SECTOR = 256;
export const PARTITION_START = 257;
/** UDF short_ad extent length is 30 bits; split larger files into sector-aligned pieces. */
const MAX_EXTENT = 0x3fffffff - (0x3fffffff % SECTOR);

const FILE_TYPE_DIR = 4;
const FILE_TYPE_FILE = 5;
// Directories r-x, files r-- for owner, group and others (as mkisofs writes them).
const PERM_DIR = 0x14a5;
const PERM_FILE = 0x1084;

export interface IsoWriteOptions {
  volumeLabel: string;
  /** Recording time for every timestamp (deterministic output). */
  date: Date;
  signal?: AbortSignal;
  onProgress?: (bytesWritten: number, totalBytes: number) => void;
}

export interface IsoLayout {
  totalSectors: number;
  /** Absolute sector of VIDEO_TS.IFO; every file is at vmgSector + its layout offset. */
  vmgSector: number;
  partitionLength: number;
  files: { name: string; sector: number; size: number }[];
}

interface Node {
  lb: number;
  uniqueId: number;
}

function fileEntry(lb: number, fileType: number, uniqueId: number, linkCount: number, infoLength: number, extents: { length: number; position: number }[], date: Date): Buffer {
  const fe = Buffer.alloc(176 + extents.length * 8);
  fe.writeUInt32LE(0, 16); // prior recorded direct entries
  fe.writeUInt16LE(4, 20); // strategy type 4
  fe.writeUInt16LE(1, 24); // maximum entries
  fe[27] = fileType;
  fe.writeUInt16LE(0, 34); // ICB flags: short_ad
  fe.writeUInt32LE(0xffffffff, 36); // uid
  fe.writeUInt32LE(0xffffffff, 40); // gid
  fe.writeUInt32LE(fileType === FILE_TYPE_DIR ? PERM_DIR : PERM_FILE, 44);
  fe.writeUInt16LE(linkCount, 48);
  fe.writeBigUInt64LE(BigInt(infoLength), 56);
  fe.writeBigUInt64LE(BigInt(extents.reduce((s, e) => s + Math.ceil(e.length / SECTOR), 0)), 64);
  udfTimestamp(date).copy(fe, 72);
  udfTimestamp(date).copy(fe, 84);
  udfTimestamp(date).copy(fe, 96);
  fe.writeUInt32LE(1, 108); // checkpoint
  implementationId().copy(fe, 128);
  fe.writeBigUInt64LE(BigInt(uniqueId), 160);
  fe.writeUInt32LE(0, 168);
  fe.writeUInt32LE(extents.length * 8, 172);
  extents.forEach((e, i) => {
    fe.writeUInt32LE(e.length, 176 + i * 8);
    fe.writeUInt32LE(e.position, 180 + i * 8);
  });
  return finishTag(fe, 261, lb);
}

function fid(dirLb: number, characteristics: number, name: string | null, icbLb: number): Buffer {
  const id = name === null ? Buffer.alloc(0) : dchars(name);
  const size = (38 + id.length + 3) & ~3;
  const b = Buffer.alloc(size);
  b.writeUInt16LE(1, 16); // file version number
  b[18] = characteristics;
  b[19] = id.length;
  longAd(SECTOR, icbLb).copy(b, 20);
  b.writeUInt16LE(0, 36);
  id.copy(b, 38);
  return finishTag(b, 257, dirLb);
}

function sector(content?: Buffer): Buffer {
  const s = Buffer.alloc(SECTOR);
  content?.copy(s);
  return s;
}

function fileExtents(startLb: number, size: number): { length: number; position: number }[] {
  const extents: { length: number; position: number }[] = [];
  let remaining = size;
  let lb = startLb;
  do {
    const length = Math.min(remaining, MAX_EXTENT);
    extents.push({ length, position: lb });
    lb += length / SECTOR;
    remaining -= length;
  } while (remaining > 0);
  return extents;
}

/** Build every metadata sector before VIDEO_TS.IFO, plus the trailing AVDP. */
export function buildIsoMetadata(layout: VideoTsLayout, options: Pick<IsoWriteOptions, 'volumeLabel' | 'date'>) {
  const { volumeLabel: label, date } = options;
  if (!/^[A-Z0-9_]{1,30}$/.test(label)) throw new ConversionError('ISO_ERROR', 'Invalid volume label', { reason: 'LABEL' });
  const files = layout.files;
  const P = PARTITION_START;

  // Partition logical blocks
  const lbFsd = 0;
  const lbFsdTd = 1;
  const root: Node = { lb: 2, uniqueId: 0 };
  const audioTs: Node = { lb: 4, uniqueId: 16 };
  const videoTs: Node = { lb: 6, uniqueId: 17 };
  const fileNodes: Node[] = files.map((_, i) => ({ lb: 8 + i, uniqueId: 18 + i }));
  const nextUniqueId = 18 + files.length;

  // ISO 9660 structures after the UDF metadata
  const isoBase = P + 8 + files.length;
  const pathL = isoBase;
  const pathM = isoBase + 1;
  const isoRoot = isoBase + 2;
  const isoAudio = isoBase + 3;
  const isoVideo = isoBase + 4;
  const vmgSector = isoBase + 5;
  const dataEnd = vmgSector + layout.extentSectors;
  const totalSectors = dataEnd + 1; // + trailing AVDP
  const partitionLength = dataEnd - P;

  const sectors = new Map<number, Buffer>();
  const put = (n: number, content: Buffer) => sectors.set(n, sector(content));

  // --- ISO 9660 -----------------------------------------------------------
  const pvd = Buffer.alloc(SECTOR);
  pvd[0] = 1;
  pvd.write('CD001', 1, 'latin1');
  pvd[6] = 1;
  isoText('', 32).copy(pvd, 8);
  isoText(label, 32).copy(pvd, 40);
  both32(totalSectors).copy(pvd, 80);
  both16(1).copy(pvd, 120);
  both16(1).copy(pvd, 124);
  both16(SECTOR).copy(pvd, 128);
  const pathTableSize = 10 + 16 + 16;
  both32(pathTableSize).copy(pvd, 132);
  pvd.writeUInt32LE(pathL, 140);
  pvd.writeUInt32BE(pathM, 148);
  isoDirRecord(Buffer.from([0]), isoRoot, SECTOR, true, date).copy(pvd, 156);
  isoText(label, 128).copy(pvd, 190);
  isoText('', 128).copy(pvd, 318);
  isoText('', 128).copy(pvd, 446);
  isoText('SENA MP4 TO IFO', 128).copy(pvd, 574);
  isoText('', 37).copy(pvd, 702);
  isoText('', 37).copy(pvd, 739);
  isoText('', 37).copy(pvd, 776);
  isoDecDate(date).copy(pvd, 813);
  isoDecDate(date).copy(pvd, 830);
  isoDecDate(null).copy(pvd, 847);
  isoDecDate(null).copy(pvd, 864);
  pvd[881] = 1;
  put(16, pvd);
  const term = Buffer.alloc(7);
  term[0] = 255;
  term.write('CD001', 1, 'latin1');
  term[6] = 1;
  put(17, term);
  ['BEA01', 'NSR02', 'TEA01'].forEach((id, i) => {
    const b = Buffer.alloc(7);
    b.write(id, 1, 'latin1');
    b[6] = 1;
    put(18 + i, b);
  });

  const pathTable = (littleEndian: boolean) => {
    const entries: [Buffer, number][] = [[Buffer.from([0]), isoRoot], [Buffer.from('AUDIO_TS'), isoAudio], [Buffer.from('VIDEO_TS'), isoVideo]];
    const parts = entries.map(([name, extent]) => {
      const b = Buffer.alloc(8 + name.length + (name.length % 2));
      b[0] = name.length;
      if (littleEndian) {
        b.writeUInt32LE(extent, 2);
        b.writeUInt16LE(1, 6);
      } else {
        b.writeUInt32BE(extent, 2);
        b.writeUInt16BE(1, 6);
      }
      name.copy(b, 8);
      return b;
    });
    return Buffer.concat(parts);
  };
  put(pathL, pathTable(true));
  put(pathM, pathTable(false));
  const dirSector = (records: Buffer[]) => Buffer.concat(records);
  put(isoRoot, dirSector([
    isoDirRecord(Buffer.from([0]), isoRoot, SECTOR, true, date),
    isoDirRecord(Buffer.from([1]), isoRoot, SECTOR, true, date),
    isoDirRecord(Buffer.from('AUDIO_TS'), isoAudio, SECTOR, true, date),
    isoDirRecord(Buffer.from('VIDEO_TS'), isoVideo, SECTOR, true, date),
  ]));
  put(isoAudio, dirSector([
    isoDirRecord(Buffer.from([0]), isoAudio, SECTOR, true, date),
    isoDirRecord(Buffer.from([1]), isoRoot, SECTOR, true, date),
  ]));
  const isoFiles = [...files].sort((a, b) => (a.name < b.name ? -1 : 1));
  const videoRecords = [
    isoDirRecord(Buffer.from([0]), isoVideo, SECTOR, true, date),
    isoDirRecord(Buffer.from([1]), isoRoot, SECTOR, true, date),
    ...isoFiles.map((f) => isoDirRecord(Buffer.from(`${f.name};1`), vmgSector + f.offset, f.size, false, date)),
  ];
  if (videoRecords.reduce((s, r) => s + r.length, 0) > SECTOR) throw new ConversionError('ISO_ERROR', 'VIDEO_TS directory does not fit one sector');
  put(isoVideo, dirSector(videoRecords));

  // --- UDF volume descriptor sequence ------------------------------------------
  const vds = (base: number) => {
    const uPvd = Buffer.alloc(512);
    uPvd.writeUInt32LE(0, 16);
    uPvd.writeUInt32LE(0, 20);
    dstring(label, 32).copy(uPvd, 24);
    uPvd.writeUInt16LE(1, 56);
    uPvd.writeUInt16LE(1, 58);
    uPvd.writeUInt16LE(2, 60);
    uPvd.writeUInt16LE(3, 62);
    uPvd.writeUInt32LE(1, 64);
    uPvd.writeUInt32LE(1, 68);
    dstring(`${volumeSetPrefix(date)}${label}`, 128).copy(uPvd, 72);
    charspec().copy(uPvd, 200);
    charspec().copy(uPvd, 264);
    regid('*SENA MP4 to IFO').copy(uPvd, 344);
    udfTimestamp(date).copy(uPvd, 376);
    implementationId().copy(uPvd, 388);
    put(base, finishTag(uPvd, 1, base));

    const iuvd = Buffer.alloc(512);
    iuvd.writeUInt32LE(1, 16);
    regid('*UDF LV Info', udfSuffix([0, 0])).copy(iuvd, 20);
    charspec().copy(iuvd, 52);
    dstring(label, 128).copy(iuvd, 116);
    implementationId().copy(iuvd, 352);
    put(base + 1, finishTag(iuvd, 4, base + 1));

    const pd = Buffer.alloc(512);
    pd.writeUInt32LE(2, 16);
    pd.writeUInt16LE(1, 20); // allocated
    pd.writeUInt16LE(0, 22); // partition number
    regid('+NSR02').copy(pd, 24);
    pd.writeUInt32LE(1, 184); // read-only access
    pd.writeUInt32LE(P, 188);
    pd.writeUInt32LE(partitionLength, 192);
    implementationId().copy(pd, 196);
    put(base + 2, finishTag(pd, 5, base + 2));

    const lvd = Buffer.alloc(446);
    lvd.writeUInt32LE(3, 16);
    charspec().copy(lvd, 20);
    dstring(label, 128).copy(lvd, 84);
    lvd.writeUInt32LE(SECTOR, 212);
    regid('*OSTA UDF Compliant', udfSuffix([0])).copy(lvd, 216);
    longAd(SECTOR, lbFsd).copy(lvd, 248);
    lvd.writeUInt32LE(6, 264);
    lvd.writeUInt32LE(1, 268);
    implementationId().copy(lvd, 272);
    extentAd(2 * SECTOR, LVID_SECTOR).copy(lvd, 432);
    lvd[440] = 1; // type 1 partition map
    lvd[441] = 6;
    lvd.writeUInt16LE(1, 442);
    lvd.writeUInt16LE(0, 444);
    put(base + 3, finishTag(lvd, 6, base + 3));

    const usd = Buffer.alloc(24);
    usd.writeUInt32LE(4, 16);
    put(base + 4, finishTag(usd, 7, base + 4));
    put(base + 5, finishTag(Buffer.alloc(512), 8, base + 5));
  };
  vds(VDS_MAIN);
  vds(VDS_RESERVE);

  const lvid = Buffer.alloc(88 + 46);
  udfTimestamp(date).copy(lvid, 16);
  lvid.writeUInt32LE(1, 28); // close integrity
  lvid.writeBigUInt64LE(BigInt(nextUniqueId), 40);
  lvid.writeUInt32LE(1, 72);
  lvid.writeUInt32LE(46, 76);
  lvid.writeUInt32LE(0, 80); // free space
  lvid.writeUInt32LE(partitionLength, 84);
  implementationId().copy(lvid, 88);
  lvid.writeUInt32LE(files.length, 120);
  lvid.writeUInt32LE(3, 124); // root, AUDIO_TS, VIDEO_TS
  lvid.writeUInt16LE(UDF_REVISION, 128);
  lvid.writeUInt16LE(UDF_REVISION, 130);
  lvid.writeUInt16LE(UDF_REVISION, 132);
  put(LVID_SECTOR, finishTag(lvid, 9, LVID_SECTOR));
  put(LVID_SECTOR + 1, finishTag(Buffer.alloc(512), 8, LVID_SECTOR + 1));

  const avdp = (at: number) => {
    const b = Buffer.alloc(512);
    extentAd(VDS_SECTORS * SECTOR, VDS_MAIN).copy(b, 16);
    extentAd(VDS_SECTORS * SECTOR, VDS_RESERVE).copy(b, 24);
    return finishTag(b, 2, at);
  };
  put(AVDP_SECTOR, avdp(AVDP_SECTOR));

  // --- UDF file set -------------------------------------------------------------
  const fsd = Buffer.alloc(512);
  udfTimestamp(date).copy(fsd, 16);
  fsd.writeUInt16LE(3, 28);
  fsd.writeUInt16LE(3, 30);
  fsd.writeUInt32LE(1, 32);
  fsd.writeUInt32LE(1, 36);
  charspec().copy(fsd, 48);
  dstring(label, 128).copy(fsd, 112);
  charspec().copy(fsd, 240);
  dstring(label, 32).copy(fsd, 304);
  longAd(SECTOR, root.lb).copy(fsd, 400);
  regid('*OSTA UDF Compliant', udfSuffix([0])).copy(fsd, 416);
  put(P + lbFsd, finishTag(fsd, 256, lbFsd));
  put(P + lbFsdTd, finishTag(Buffer.alloc(512), 8, lbFsdTd));

  const dirData = (dir: Node, parent: Node, children: { name: string; node: Node; isDir: boolean }[]) => {
    const lb = dir.lb + 1;
    const fids = [fid(lb, 0x0a, null, parent.lb), ...children.map((c) => fid(lb, c.isDir ? 0x02 : 0x00, c.name, c.node.lb))];
    const data = Buffer.concat(fids);
    if (data.length > SECTOR) throw new ConversionError('ISO_ERROR', 'UDF directory does not fit one block');
    put(P + lb, data);
    return data.length;
  };
  const rootLen = dirData(root, root, [
    { name: 'AUDIO_TS', node: audioTs, isDir: true },
    { name: 'VIDEO_TS', node: videoTs, isDir: true },
  ]);
  put(P + root.lb, fileEntry(root.lb, FILE_TYPE_DIR, root.uniqueId, 3, rootLen, [{ length: rootLen, position: root.lb + 1 }], date));
  const audioLen = dirData(audioTs, root, []);
  put(P + audioTs.lb, fileEntry(audioTs.lb, FILE_TYPE_DIR, audioTs.uniqueId, 1, audioLen, [{ length: audioLen, position: audioTs.lb + 1 }], date));
  const videoLen = dirData(videoTs, root, files.map((f, i) => ({ name: f.name, node: fileNodes[i] as Node, isDir: false })));
  put(P + videoTs.lb, fileEntry(videoTs.lb, FILE_TYPE_DIR, videoTs.uniqueId, 1, videoLen, [{ length: videoLen, position: videoTs.lb + 1 }], date));
  files.forEach((f, i) => {
    const node = fileNodes[i] as Node;
    put(P + node.lb, fileEntry(node.lb, FILE_TYPE_FILE, node.uniqueId, 1, f.size, fileExtents(vmgSector + f.offset - P, f.size), date));
  });

  const header = Buffer.alloc(vmgSector * SECTOR);
  for (const [n, s] of sectors) s.copy(header, n * SECTOR);
  const trailer = sector(avdp(dataEnd));
  const isoLayout: IsoLayout = {
    totalSectors,
    vmgSector,
    partitionLength,
    files: files.map((f) => ({ name: f.name, sector: vmgSector + f.offset, size: f.size })),
  };
  return { header, trailer, layout: isoLayout };
}

/** UDF volume set identifier: 16 hex digits (unique) followed by free text. */
function volumeSetPrefix(date: Date): string {
  return Math.floor(date.getTime() / 1000).toString(16).toUpperCase().padStart(8, '0').padEnd(16, '0');
}

/** Write `<isoPath>` from a VIDEO_TS directory. The file must not exist; a partial file is removed on failure. */
export async function writeDvdIso(videoTsDir: string, isoPath: string, options: IsoWriteOptions): Promise<IsoLayout> {
  let layout: VideoTsLayout;
  try {
    layout = readVideoTs(videoTsDir);
  } catch (cause) {
    throw new ConversionError('ISO_ERROR', 'VIDEO_TS cannot be placed on a DVD-Video volume', { reason: 'LAYOUT', detail: String((cause as Error).message), cause });
  }
  const { header, trailer, layout: isoLayout } = buildIsoMetadata(layout, options);
  const total = isoLayout.totalSectors * SECTOR;
  const fd = fs.openSync(isoPath, 'wx');
  let ok = false;
  try {
    let position = 0;
    const write = (buf: Buffer) => {
      let off = 0;
      while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off, position + off);
      position += buf.length;
    };
    write(header);
    const chunk = Buffer.alloc(4 * 1024 * 1024);
    for (const f of layout.files) {
      const target = (isoLayout.vmgSector + f.offset) * SECTOR;
      if (target > position) write(Buffer.alloc(target - position));
      const src = fs.openSync(path.join(videoTsDir, f.name), 'r');
      try {
        let n: number;
        let copied = 0;
        while ((n = fs.readSync(src, chunk, 0, chunk.length, null)) > 0) {
          throwIfAborted(options.signal);
          write(chunk.subarray(0, n));
          copied += n;
          options.onProgress?.(position, total);
          await new Promise<void>((resolve) => setImmediate(resolve)); // let abort signals through
        }
        if (copied !== f.size) throw new ConversionError('ISO_ERROR', `${f.name} changed while writing`);
      } finally {
        fs.closeSync(src);
      }
    }
    write(trailer);
    if (position !== total) throw new ConversionError('ISO_ERROR', 'ISO size mismatch');
    fs.fsyncSync(fd);
    ok = true;
  } finally {
    fs.closeSync(fd);
    if (!ok) fs.rmSync(isoPath, { force: true });
  }
  return isoLayout;
}
