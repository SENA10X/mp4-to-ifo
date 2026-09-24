// Minimal DVD-Video IFO reader: what the ISO writer needs for placement and what verification checks.

export const SECTOR = 2048;
const NTSC_FPS = 30000 / 1001;

export interface PgcInfo {
  seconds: number;
  programs: number;
  cells: number;
  pre: string[];
  post: string[];
}

export interface VmgInfo {
  id: string;
  /** Last sector of the VMG set (IFO + menu VOB + BUP), relative to VIDEO_TS.IFO. */
  lastSector: number;
  ifoLastSector: number;
  titleSets: number;
  regionMask: number;
  menuVobStart: number;
  firstPlay: PgcInfo | null;
  titles: { chapters: number; vts: number; vtsTitle: number; vtsStartSector: number }[];
}

export interface VtsInfo {
  id: string;
  /** Last sector of the title set (IFO + VOBs + BUP), relative to VTS_xx_0.IFO. */
  lastSector: number;
  ifoLastSector: number;
  menuVobStart: number;
  titleVobStart: number;
  video: { mpeg: string; standard: string; aspect: string; resolution: string };
  audio: { coding: string; sampleRate: number | 'other'; channels: number }[];
  pgcs: PgcInfo[];
}

const bcd = (b: number) => (b >> 4) * 10 + (b & 15);

function decodeCommand(c: Buffer): string {
  if (c[0] === 0x30 && c[1] === 0x01) return 'Exit';
  if (c[0] === 0x30 && c[1] === 0x02) return `JumpTT ${c[5]}`;
  return c.toString('hex');
}

export function readPgc(b: Buffer, offset: number): PgcInfo {
  const t = b.subarray(offset + 4, offset + 8);
  const fpsCode = (t[3] ?? 0) >> 6;
  // The BCD time counts frames non-drop at the nominal rate (30 for NTSC, 25 for PAL).
  const nominal = fpsCode === 3 ? 30 : 25;
  const rate = fpsCode === 3 ? NTSC_FPS : fpsCode === 1 ? 25 : 0;
  const frames = (bcd(t[0] ?? 0) * 3600 + bcd(t[1] ?? 0) * 60 + bcd(t[2] ?? 0)) * nominal + bcd((t[3] ?? 0) & 0x3f);
  const pre: string[] = [];
  const post: string[] = [];
  const cmdOffset = b.readUInt16BE(offset + 0xe4);
  if (cmdOffset) {
    const c = offset + cmdOffset;
    const nPre = b.readUInt16BE(c);
    const nPost = b.readUInt16BE(c + 2);
    let p = c + 8;
    for (let i = 0; i < nPre; i++, p += 8) pre.push(decodeCommand(b.subarray(p, p + 8)));
    for (let i = 0; i < nPost; i++, p += 8) post.push(decodeCommand(b.subarray(p, p + 8)));
  }
  return { seconds: rate ? frames / rate : 0, programs: b[offset + 2] ?? 0, cells: b[offset + 3] ?? 0, pre, post };
}

export function parseVmg(b: Buffer): VmgInfo {
  const fp = b.readUInt32BE(0x84);
  const ttSrpt = b.readUInt32BE(0xc4) * SECTOR;
  const titles: VmgInfo['titles'] = [];
  if (ttSrpt + 8 <= b.length) {
    const n = b.readUInt16BE(ttSrpt);
    for (let i = 0; i < n; i++) {
      const e = ttSrpt + 8 + i * 12;
      titles.push({ chapters: b.readUInt16BE(e + 2), vts: b[e + 6] ?? 0, vtsTitle: b[e + 7] ?? 0, vtsStartSector: b.readUInt32BE(e + 8) });
    }
  }
  return {
    id: b.toString('latin1', 0, 12),
    lastSector: b.readUInt32BE(0x0c),
    ifoLastSector: b.readUInt32BE(0x1c),
    titleSets: b.readUInt16BE(0x3e),
    regionMask: b[0x23] ?? 0xff,
    menuVobStart: b.readUInt32BE(0xc0),
    firstPlay: fp && fp < b.length ? readPgc(b, fp) : null,
    titles,
  };
}

export function parseVts(b: Buffer): VtsInfo {
  const v0 = b[0x200] ?? 0;
  const v1 = b[0x201] ?? 0;
  const audio: VtsInfo['audio'] = [];
  const nAudio = b.readUInt16BE(0x202);
  for (let i = 0; i < nAudio; i++) {
    const a0 = b[0x204 + i * 8] ?? 0;
    const a1 = b[0x205 + i * 8] ?? 0;
    audio.push({
      coding: ['ac3', '?', 'mpeg1', 'mpeg2ext', 'lpcm', '?', 'dts', '?'][a0 >> 5] ?? '?',
      sampleRate: (a1 >> 4) & 3 ? 'other' : 48000,
      channels: (a1 & 7) + 1,
    });
  }
  const pgcit = b.readUInt32BE(0xcc) * SECTOR;
  const pgcs: PgcInfo[] = [];
  if (pgcit + 8 <= b.length) {
    const n = b.readUInt16BE(pgcit);
    for (let i = 0; i < n; i++) pgcs.push(readPgc(b, pgcit + b.readUInt32BE(pgcit + 8 + i * 8 + 4)));
  }
  return {
    id: b.toString('latin1', 0, 12),
    lastSector: b.readUInt32BE(0x0c),
    ifoLastSector: b.readUInt32BE(0x1c),
    menuVobStart: b.readUInt32BE(0xc0),
    titleVobStart: b.readUInt32BE(0xc4),
    video: {
      mpeg: ['MPEG-1', 'MPEG-2'][v0 >> 6] ?? '?',
      standard: ['NTSC', 'PAL'][(v0 >> 4) & 3] ?? '?',
      aspect: ({ 0: '4:3', 3: '16:9' } as Record<number, string>)[(v0 >> 2) & 3] ?? '?',
      resolution: ['720x480', '704x480', '352x480', '352x240'][(v1 >> 3) & 7] ?? '?',
    },
    audio,
    pgcs,
  };
}
