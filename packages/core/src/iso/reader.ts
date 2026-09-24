// Read-back of an ISO 9660 + UDF 1.02 DVD-Video volume. Written independently of the writer's
// constants: it follows the anchors and descriptors the way a reader would, and records every
// structural problem it finds. Used by verification and to compare against the mkisofs reference.

import fs from 'node:fs';
import { SECTOR, crc16, tagChecksum } from './encoding.ts';

export interface IsoFileEntry {
  /** Path like "VIDEO_TS/VIDEO_TS.IFO". */
  path: string;
  size: number;
  /** Absolute start sector per the ISO 9660 directory record. */
  isoSector: number | null;
  /** Absolute extents per the UDF file entry. */
  udfExtents: { sector: number; length: number }[];
  udfLinkCount: number;
  udfPermissions: number;
  udfFileType: number;
}

export interface IsoInspection {
  totalSectors: number;
  issues: string[];
  iso9660: { volumeId: string; volumeSpaceSize: number; pathTableSize: number; directories: string[] } | null;
  udf: {
    vrs: string[];
    anchors: number[];
    volumeId: string;
    logicalVolumeId: string;
    domain: string;
    revision: number;
    partitionStart: number;
    partitionLength: number;
    accessType: number;
    blockSize: number;
    descriptors: { sector: number; tag: number }[];
  } | null;
  files: IsoFileEntry[];
}

const TAG_NAMES: Record<number, string> = { 1: 'PVD', 2: 'AVDP', 4: 'IUVD', 5: 'PD', 6: 'LVD', 7: 'USD', 8: 'TD', 9: 'LVID', 256: 'FSD', 257: 'FID', 261: 'FE' };

function readDstring(b: Buffer): string {
  const len = b[b.length - 1] ?? 0;
  if (!len) return '';
  const comp = b[0];
  const body = b.subarray(1, len);
  return comp === 16 ? Buffer.from(body).swap16().toString('utf16le') : body.toString('latin1');
}

export function inspectIso(isoPath: string): IsoInspection {
  const fd = fs.openSync(isoPath, 'r');
  const issues: string[] = [];
  try {
    const size = fs.fstatSync(fd).size;
    const totalSectors = Math.floor(size / SECTOR);
    if (size % SECTOR) issues.push('file size is not a whole number of sectors');
    const read = (n: number, count = 1) => {
      const b = Buffer.alloc(SECTOR * count);
      fs.readSync(fd, b, 0, b.length, n * SECTOR);
      return b;
    };
    /** Validate a tag at the start of `b` (checksum, CRC, location); returns the tag id or -1. */
    const checkTag = (b: Buffer, expectedLocation: number, where: string, expectedId?: number): number => {
      const id = b.readUInt16LE(0);
      if (tagChecksum(b) !== b[4]) {
        issues.push(`${where}: tag checksum mismatch`);
        return -1;
      }
      const crcLen = b.readUInt16LE(10);
      if (16 + crcLen > b.length) issues.push(`${where}: CRC length out of range`);
      else if (crc16(b.subarray(16, 16 + crcLen)) !== b.readUInt16LE(8)) issues.push(`${where}: descriptor CRC mismatch`);
      if (b.readUInt32LE(12) !== expectedLocation) issues.push(`${where}: tag location ${b.readUInt32LE(12)} != ${expectedLocation}`);
      if (b.readUInt16LE(2) !== 2) issues.push(`${where}: descriptor version ${b.readUInt16LE(2)} (expected 2 for UDF 1.02)`);
      if (expectedId !== undefined && id !== expectedId) issues.push(`${where}: tag ${id} (expected ${expectedId})`);
      return id;
    };

    // --- ISO 9660 -------------------------------------------------------------
    let iso9660: IsoInspection['iso9660'] = null;
    const isoFiles = new Map<string, { sector: number; size: number }>();
    const vrs: string[] = [];
    for (let s = 16; s < 32; s++) {
      const b = read(s);
      const id = b.toString('latin1', 1, 6);
      if (!/^[A-Z0-9]{5}$/.test(id)) break;
      vrs.push(id);
      if (id === 'CD001' && b[0] === 1) {
        const volumeSpaceSize = b.readUInt32LE(80);
        if (b.readUInt32BE(84) !== volumeSpaceSize) issues.push('ISO PVD: volume space size endian mismatch');
        if (volumeSpaceSize !== totalSectors) issues.push(`ISO PVD: volume space ${volumeSpaceSize} != file ${totalSectors}`);
        if (b.readUInt16LE(128) !== SECTOR) issues.push('ISO PVD: logical block size is not 2048');
        const pathTableSize = b.readUInt32LE(132);
        const lPath = b.readUInt32LE(140);
        const mPath = b.readUInt32BE(148);
        const directories: string[] = [];
        const walk = (extent: number, length: number, prefix: string, depth: number) => {
          if (depth > 2) return;
          const data = read(extent, Math.ceil(length / SECTOR));
          for (let p = 0; p < length;) {
            const rl = data[p] ?? 0;
            if (!rl) {
              p = (Math.floor(p / SECTOR) + 1) * SECTOR;
              continue;
            }
            const loc = data.readUInt32LE(p + 2);
            const dl = data.readUInt32LE(p + 10);
            if (data.readUInt32BE(p + 6) !== loc || data.readUInt32BE(p + 14) !== dl) issues.push(`ISO dir ${prefix}: both-endian mismatch`);
            const flags = data[p + 25] ?? 0;
            const nl = data[p + 32] ?? 0;
            const name = data.subarray(p + 33, p + 33 + nl).toString('latin1');
            if (!(nl === 1 && (name === '\0' || name === '\x01'))) {
              if (flags & 2) {
                directories.push(`${prefix}${name}`);
                walk(loc, dl, `${prefix}${name}/`, depth + 1);
              } else isoFiles.set(`${prefix}${name.replace(/;1$/, '')}`, { sector: loc, size: dl });
            }
            p += rl;
          }
        };
        walk(b.readUInt32LE(158), b.readUInt32LE(166), '', 0);
        // Path tables must list the same directories in both byte orders.
        const pt = (sectorNo: number, le: boolean) => {
          const t = read(sectorNo).subarray(0, pathTableSize);
          const out: string[] = [];
          for (let p = 0; p < t.length;) {
            const nl = t[p] ?? 0;
            if (!nl) break;
            const extent = le ? t.readUInt32LE(p + 2) : t.readUInt32BE(p + 2);
            out.push(`${t.subarray(p + 8, p + 8 + nl).toString('latin1')}@${extent}`);
            p += 8 + nl + (nl % 2);
          }
          return out.join(',');
        };
        if (pt(lPath, true) !== pt(mPath, false)) issues.push('ISO path tables (L/M) differ');
        iso9660 = { volumeId: b.toString('latin1', 40, 72).trim(), volumeSpaceSize, pathTableSize, directories };
      }
    }
    if (!iso9660) issues.push('ISO 9660 primary volume descriptor missing');
    for (const needed of ['BEA01', 'NSR02', 'TEA01']) if (!vrs.includes(needed)) issues.push(`UDF volume recognition: ${needed} missing`);

    // --- UDF ------------------------------------------------------------------------
    let udf: IsoInspection['udf'] = null;
    const files: IsoFileEntry[] = [];
    const anchors: number[] = [];
    for (const s of [256, totalSectors - 257, totalSectors - 1]) {
      if (s < 256 || s >= totalSectors) continue;
      const b = read(s);
      if (b.readUInt16LE(0) === 2 && tagChecksum(b) === b[4]) {
        checkTag(b.subarray(0, 512), s, `AVDP@${s}`, 2);
        anchors.push(s);
      }
    }
    if (!anchors.includes(256)) issues.push('UDF anchor at sector 256 missing');
    if (anchors.length < 2) issues.push('UDF needs two anchors (256 and N-256 or N-1)');
    if (anchors.includes(256)) {
      const avdp = read(256);
      const mainLen = avdp.readUInt32LE(16);
      const mainLoc = avdp.readUInt32LE(20);
      const resLen = avdp.readUInt32LE(24);
      const resLoc = avdp.readUInt32LE(28);
      const readVds = (loc: number, len: number, label: string) => {
        const out: { sector: number; tag: number; buf: Buffer }[] = [];
        for (let s = loc; s < loc + len / SECTOR; s++) {
          const b = read(s);
          const id = b.readUInt16LE(0);
          if (!id) continue;
          const size = id === 6 ? 440 + b.readUInt32LE(264) : id === 7 ? 24 + 8 * b.readUInt32LE(20) : 512;
          checkTag(b.subarray(0, size), s, `${label} ${TAG_NAMES[id] ?? id}@${s}`);
          out.push({ sector: s, tag: id, buf: b.subarray(16, size) });
          if (id === 8) break;
        }
        return out;
      };
      const main = readVds(mainLoc, mainLen, 'main VDS');
      const reserve = readVds(resLoc, resLen, 'reserve VDS');
      const summary = (list: typeof main) => list.map((d) => `${d.tag}:${d.buf.toString('hex')}`).join('|');
      if (summary(main) !== summary(reserve)) issues.push('UDF reserve VDS differs from main VDS');
      const find = (id: number) => main.find((d) => d.tag === id)?.buf;
      const pvd = find(1);
      const pd = find(5);
      const lvd = find(6);
      for (const [id, name] of [[1, 'PVD'], [4, 'IUVD'], [5, 'PD'], [6, 'LVD'], [7, 'USD'], [8, 'TD']] as const) {
        if (!find(id)) issues.push(`UDF main VDS: ${name} missing`);
      }
      if (pvd && pd && lvd) {
        // buffers start at descriptor offset 16
        const partitionStart = pd.readUInt32LE(188 - 16);
        const partitionLength = pd.readUInt32LE(192 - 16);
        const contents = pd.toString('latin1', 25 - 16, 48 - 16).replace(/\0/g, '');
        if (contents !== '+NSR02') issues.push(`UDF partition contents ${contents}`);
        const domain = lvd.toString('latin1', 217 - 16, 240 - 16).replace(/\0/g, '');
        const revision = lvd.readUInt16LE(240 - 16);
        const blockSize = lvd.readUInt32LE(212 - 16);
        if (domain !== '*OSTA UDF Compliant') issues.push(`UDF domain "${domain}"`);
        if (revision !== 0x0102) issues.push(`UDF revision 0x${revision.toString(16)} (expected 0x102)`);
        if (blockSize !== SECTOR) issues.push('UDF logical block size is not 2048');
        if (lvd[440 - 16] !== 1) issues.push('UDF partition map is not type 1');
        const lvidLen = lvd.readUInt32LE(432 - 16);
        const lvidLoc = lvd.readUInt32LE(436 - 16);
        if (lvidLen) {
          const lvid = read(lvidLoc);
          if (checkTag(lvid.subarray(0, 88 + lvid.readUInt32LE(76)), lvidLoc, 'LVID', 9) === 9 && lvid.readUInt32LE(28) !== 1) {
            issues.push('UDF LVID is not closed');
          }
        } else issues.push('UDF LVID extent missing');
        const fsdLb = lvd.readUInt32LE(252 - 16);
        const lb = (n: number) => partitionStart + n;
        const fsd = read(lb(fsdLb));
        checkTag(fsd.subarray(0, 512), fsdLb, 'FSD', 256);
        const walkDir = (icbLb: number, prefix: string, depth: number) => {
          const fe = read(lb(icbLb));
          const eaLen = fe.readUInt32LE(168);
          const adLen = fe.readUInt32LE(172);
          if (checkTag(fe.subarray(0, 176 + eaLen + adLen), icbLb, `FE ${prefix || '/'}`, 261) !== 261) return null;
          const fileType = fe[27] ?? 0;
          const adType = fe.readUInt16LE(34) & 7;
          if (adType !== 0) issues.push(`FE ${prefix}: allocation descriptors are not short_ad`);
          const extents: { sector: number; length: number }[] = [];
          for (let p = 176 + eaLen; p < 176 + eaLen + adLen; p += 8) {
            extents.push({ length: fe.readUInt32LE(p) & 0x3fffffff, sector: lb(fe.readUInt32LE(p + 4)) });
          }
          const infoLength = Number(fe.readBigUInt64LE(56));
          const entry = { size: infoLength, extents, linkCount: fe.readUInt16LE(48), permissions: fe.readUInt32LE(44), fileType };
          if (fileType === 4 && depth < 3) {
            const data = Buffer.concat(extents.map((e) => read(e.sector, Math.ceil(e.length / SECTOR)))).subarray(0, infoLength);
            for (let p = 0; p < data.length;) {
              const dirLb = extents[0] ? extents[0].sector - partitionStart + Math.floor(p / SECTOR) : 0;
              const nameLen = data[p + 19] ?? 0;
              const iuLen = data.readUInt16LE(p + 36);
              const size = (38 + iuLen + nameLen + 3) & ~3;
              checkTag(data.subarray(p, p + size), dirLb, `FID in ${prefix || '/'}`, 257);
              const chars = data[p + 18] ?? 0;
              const child = data.readUInt32LE(p + 24);
              const raw = data.subarray(p + 38 + iuLen, p + 38 + iuLen + nameLen);
              const name = nameLen ? (raw[0] === 16 ? Buffer.from(raw.subarray(1)).swap16().toString('utf16le') : raw.subarray(1).toString('latin1')) : '';
              if (!(chars & 8) && name) {
                const childPath = prefix ? `${prefix}/${name}` : name;
                const c = walkDir(child, childPath, depth + 1);
                if (c && c.fileType !== 4) {
                  files.push({ path: childPath, size: c.size, isoSector: null, udfExtents: c.extents, udfLinkCount: c.linkCount, udfPermissions: c.permissions, udfFileType: c.fileType });
                }
              }
              p += size;
            }
          }
          return entry;
        };
        walkDir(fsd.readUInt32LE(404), '', 0);
        for (const f of files) {
          const iso = isoFiles.get(f.path);
          f.isoSector = iso?.sector ?? null;
          if (!iso) issues.push(`${f.path}: missing from ISO 9660`);
          else {
            if (iso.size !== f.size) issues.push(`${f.path}: ISO size ${iso.size} != UDF size ${f.size}`);
            if (iso.sector !== f.udfExtents[0]?.sector) issues.push(`${f.path}: ISO and UDF point to different sectors`);
          }
          let next = f.udfExtents[0]?.sector ?? 0;
          for (const e of f.udfExtents) {
            if (e.sector !== next) issues.push(`${f.path}: file is not contiguous`);
            next = e.sector + Math.ceil(e.length / SECTOR);
            if (e.sector < partitionStart || next > partitionStart + partitionLength) issues.push(`${f.path}: extent outside the partition`);
          }
        }
        for (const p of isoFiles.keys()) if (!files.some((f) => f.path === p)) issues.push(`${p}: missing from UDF`);
        udf = {
          vrs,
          anchors,
          volumeId: readDstring(pvd.subarray(24 - 16, 56 - 16)),
          logicalVolumeId: readDstring(lvd.subarray(84 - 16, 212 - 16)),
          domain,
          revision,
          partitionStart,
          partitionLength,
          accessType: pd.readUInt32LE(184 - 16),
          blockSize,
          descriptors: main.map((d) => ({ sector: d.sector, tag: d.tag })),
        };
      }
    }
    return { totalSectors, issues, iso9660, udf, files };
  } finally {
    fs.closeSync(fd);
  }
}
