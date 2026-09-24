// VIDEO_TS file set and its disc placement. On a DVD-Video disc the IFOs dictate where every file
// sits relative to VIDEO_TS.IFO; the ISO writer places files exactly there.

import fs from 'node:fs';
import path from 'node:path';
import { SECTOR, parseVmg, parseVts, type VmgInfo, type VtsInfo } from './ifo.ts';

export interface VideoTsFile {
  name: string;
  path: string;
  size: number;
  sectors: number;
  /** Sector offset from the start of VIDEO_TS.IFO. */
  offset: number;
}

export interface VideoTsLayout {
  dir: string;
  /** Files in disc order. */
  files: VideoTsFile[];
  /** Sectors from the start of VIDEO_TS.IFO to the end of the last file. */
  extentSectors: number;
  vmg: VmgInfo;
  vts: VtsInfo;
}

export class LayoutError extends Error {}

const VOB_PATTERN = /^VTS_01_([1-9])\.VOB$/;

/** Only the file set dvdauthor produces for one title without menus is accepted. */
export function readVideoTs(dir: string): VideoTsLayout {
  const names = fs.readdirSync(dir).filter((n) => !n.startsWith('.')).sort();
  const expected = new Set(['VIDEO_TS.IFO', 'VIDEO_TS.BUP', 'VTS_01_0.IFO', 'VTS_01_0.BUP']);
  const vobs = names.filter((n) => VOB_PATTERN.test(n)).sort((a, b) => Number(VOB_PATTERN.exec(a)?.[1]) - Number(VOB_PATTERN.exec(b)?.[1]));
  const unexpected = names.filter((n) => !expected.has(n) && !vobs.includes(n));
  if (unexpected.length) throw new LayoutError(`unexpected files in VIDEO_TS: ${unexpected.join(' ')}`);
  for (const n of expected) if (!names.includes(n)) throw new LayoutError(`missing ${n}`);
  if (!vobs.length) throw new LayoutError('missing VTS_01_1.VOB');
  vobs.forEach((n, i) => {
    if (n !== `VTS_01_${i + 1}.VOB`) throw new LayoutError(`VOB sequence has a gap at ${n}`);
  });

  const stat = (n: string) => {
    const p = path.join(dir, n);
    const size = fs.statSync(p).size;
    if (size % SECTOR !== 0) throw new LayoutError(`${n} is not a whole number of sectors`);
    return { name: n, path: p, size, sectors: size / SECTOR };
  };
  const vmgIfo = stat('VIDEO_TS.IFO');
  const vmgBup = stat('VIDEO_TS.BUP');
  const vtsIfo = stat('VTS_01_0.IFO');
  const vtsBup = stat('VTS_01_0.BUP');
  const vobFiles = vobs.map(stat);

  const vmg = parseVmg(fs.readFileSync(vmgIfo.path));
  const vts = parseVts(fs.readFileSync(vtsIfo.path));
  if (vmg.id !== 'DVDVIDEO-VMG') throw new LayoutError('VIDEO_TS.IFO is not a VMG IFO');
  if (vts.id !== 'DVDVIDEO-VTS') throw new LayoutError('VTS_01_0.IFO is not a VTS IFO');
  if (vmg.menuVobStart !== 0 || vts.menuVobStart !== 0) throw new LayoutError('menu VOBs are not supported');
  const title = vmg.titles.find((t) => t.vts === 1);
  if (!title) throw new LayoutError('VMG has no title in title set 1');
  if (vmg.ifoLastSector + 1 !== vmgIfo.sectors) throw new LayoutError('VIDEO_TS.IFO size does not match the VMG');
  if (vts.ifoLastSector + 1 !== vtsIfo.sectors) throw new LayoutError('VTS_01_0.IFO size does not match the VTS');

  const vtsStart = title.vtsStartSector;
  const files: VideoTsFile[] = [
    { ...vmgIfo, offset: 0 },
    { ...vmgBup, offset: vmg.lastSector + 1 - vmgBup.sectors },
    { ...vtsIfo, offset: vtsStart },
  ];
  let vobOffset = vtsStart + vts.titleVobStart;
  for (const v of vobFiles) {
    files.push({ ...v, offset: vobOffset });
    vobOffset += v.sectors;
  }
  files.push({ ...vtsBup, offset: vtsStart + vts.lastSector + 1 - vtsBup.sectors });

  for (let i = 1; i < files.length; i++) {
    const prev = files[i - 1];
    const cur = files[i];
    if (prev && cur && cur.offset < prev.offset + prev.sectors) throw new LayoutError(`${cur.name} overlaps ${prev.name}`);
  }
  if (vmg.lastSector + 1 > vtsStart) throw new LayoutError('VMG overlaps the title set');
  if (vobOffset > vtsStart + vts.lastSector + 1 - vtsBup.sectors) throw new LayoutError('VOBs overlap VTS_01_0.BUP');
  const last = files[files.length - 1];
  return { dir, files, extentSectors: last ? last.offset + last.sectors : 0, vmg, vts };
}
