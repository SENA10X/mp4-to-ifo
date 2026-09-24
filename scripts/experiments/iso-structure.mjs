#!/usr/bin/env node
// Dump the ISO9660 + UDF structure of a DVD-Video ISO (reference: mkisofs -dvd-video) to see what
// a minimal DVD-Video-only writer would have to produce.
// Usage: node iso-structure.mjs <file.iso>

import fs from 'node:fs';

const file = process.argv[2];
const fd = fs.openSync(file, 'r');
const size = fs.fstatSync(fd).size;
const total = size / 2048;
const sector = (n) => {
  const b = Buffer.alloc(2048);
  fs.readSync(fd, b, 0, 2048, n * 2048);
  return b;
};
const out = [];
const log = (...a) => out.push(a.join(' '));

log(`size ${size} bytes = ${total} sectors (${size % 2048 === 0 ? 'whole sectors' : 'NOT whole sectors'})`);
log(`sectors 0-15: ${[...Array(16).keys()].every((i) => sector(i).every((x) => x === 0)) ? 'system area, all zero' : 'system area has data'}`);

// --- Volume descriptors (ISO9660 + UDF VRS) ----------------------------------
let pvd;
for (let s = 16; s < 32; s++) {
  const b = sector(s);
  const id = b.toString('latin1', 1, 6);
  if (!/^[A-Z0-9]{5}$/.test(id)) break;
  let extra = '';
  if (id === 'CD001' && b[0] === 1) {
    pvd = b;
    extra = `PVD volume_id="${b.toString('latin1', 40, 72).trim()}" volume_space=${b.readUInt32LE(80)} block=${b.readUInt16LE(128)} path_table_size=${b.readUInt32LE(132)} L_path=${b.readUInt32LE(140)} M_path=${b.readUInt32BE(148)} root_extent=${b.readUInt32LE(156 + 2)}`;
  } else if (id === 'CD001') extra = b[0] === 255 ? 'terminator' : `type ${b[0]}`;
  log(`sector ${s}: ${id}${b[0] !== undefined && id === 'CD001' ? `(type ${b[0]})` : ''} ${extra}`);
}

// --- UDF descriptors -------------------------------------------------------
const TAGS = { 1: 'PVD', 2: 'AVDP', 3: 'VDP', 4: 'IUVD', 5: 'PD', 6: 'LVD', 7: 'USD', 8: 'TD', 9: 'LVID', 256: 'FSD', 257: 'FID', 261: 'FE', 266: 'EFE' };
const tag = (b, off = 0) => ({ id: b.readUInt16LE(off), ver: b.readUInt16LE(off + 2), loc: b.readUInt32LE(off + 12), crcLen: b.readUInt16LE(off + 10) });
const tagOk = (b, off = 0) => {
  let sum = 0;
  for (let i = 0; i < 16; i++) if (i !== 4) sum = (sum + b[off + i]) & 0xff;
  return sum === b[off + 4];
};
const ext = (b, off) => ({ len: b.readUInt32LE(off), loc: b.readUInt32LE(off + 4) });
for (const s of [256, total - 257, total - 1]) {
  const b = sector(s);
  const t = tag(b);
  if (t.id === 2) log(`sector ${s}: AVDP (tag v${t.ver}, checksum ${tagOk(b) ? 'ok' : 'BAD'}) main VDS ${JSON.stringify(ext(b, 16))} reserve VDS ${JSON.stringify(ext(b, 24))}`);
  else log(`sector ${s}: no AVDP`);
}
const avdp = sector(256);
const vds = ext(avdp, 16);
let partitionStart = 0;
let fsdLoc = 0;
for (let s = vds.loc; s < vds.loc + vds.len / 2048; s++) {
  const b = sector(s);
  const t = tag(b);
  if (!t.id) continue;
  let extra = '';
  if (t.id === 5) {
    partitionStart = b.readUInt32LE(188);
    extra = `partition start=${partitionStart} length=${b.readUInt32LE(192)} contents="${b.toString('latin1', 25, 48).replace(/\0/g, '')}"`;
  } else if (t.id === 6) {
    const domain = b.toString('latin1', 217, 240).replace(/\0/g, '');
    const udfRev = b.readUInt16LE(240);
    fsdLoc = b.readUInt32LE(248 + 4);
    extra = `block=${b.readUInt32LE(212)} domain="${domain}" UDF rev=0x${udfRev.toString(16)} FSD lb=${fsdLoc} lvid=${JSON.stringify(ext(b, 432))}`;
  } else if (t.id === 1) {
    extra = `volume_id="${b.subarray(25, 56).toString('latin1').replace(/\0/g, '')}"`;
  }
  log(`sector ${s}: UDF ${TAGS[t.id] ?? t.id} (checksum ${tagOk(b) ? 'ok' : 'BAD'}) ${extra}`);
  if (t.id === 8) break;
}

// --- UDF file tree ---------------------------------------------------------
const lb = (n) => sector(partitionStart + n);
const fsd = lb(fsdLoc);
log(`FSD at lb ${fsdLoc}: ${TAGS[tag(fsd).id]} root ICB lb=${fsd.readUInt32LE(400 + 4)}`);
const files = [];
function walk(icbLb, name) {
  const fe = lb(icbLb);
  const t = tag(fe);
  const fileType = fe[16 + 11];
  const infoLen = Number(fe.readBigUInt64LE(56));
  const eaLen = fe.readUInt32LE(168);
  const adLen = fe.readUInt32LE(172);
  const adType = fe.readUInt16LE(16 + 18) & 7;
  const ads = [];
  for (let p = 176 + eaLen; p < 176 + eaLen + adLen; p += 8) ads.push({ len: fe.readUInt32LE(p) & 0x3fffffff, lb: fe.readUInt32LE(p + 4) });
  if (fileType === 4) { // directory: read FIDs
    const data = Buffer.concat(ads.map((a) => Buffer.concat([...Array(Math.ceil(a.len / 2048)).keys()].map((i) => lb(a.lb + i))))).subarray(0, infoLen);
    for (let p = 0; p < data.length;) {
      const nameLen = data[p + 19];
      const iuLen = data.readUInt16LE(p + 36);
      const chars = data[p + 18];
      const child = data.readUInt32LE(p + 20 + 4);
      const nm = data.subarray(p + 38 + iuLen, p + 38 + iuLen + nameLen);
      const childName = nameLen ? (nm[0] === 8 ? nm.subarray(1).toString('latin1') : nm.subarray(1).swap16().toString('utf16le')) : null;
      if (!(chars & 8) && childName) walk(child, `${name}/${childName}`);
      p += (38 + iuLen + nameLen + 3) & ~3;
    }
  }
  files.push({ name: name || '/', tag: TAGS[t.id], type: fileType === 4 ? 'dir' : 'file', size: infoLen, adType: ['short_ad', 'long_ad', 'ext_ad', 'embedded'][adType], extents: ads.map((a) => `${partitionStart + a.lb}+${Math.ceil(a.len / 2048)}`) });
}
walk(fsd.readUInt32LE(400 + 4), '');

// --- ISO9660 directory records -------------------------------------------
const iso = {};
function isoDir(extent, len, prefix) {
  const data = Buffer.concat([...Array(Math.ceil(len / 2048)).keys()].map((i) => sector(extent + i)));
  for (let p = 0; p < data.length;) {
    const rl = data[p];
    if (!rl) { p = (Math.floor(p / 2048) + 1) * 2048; continue; }
    const loc = data.readUInt32LE(p + 2);
    const dl = data.readUInt32LE(p + 10);
    const flags = data[p + 25];
    const nl = data[p + 32];
    const nm = data.subarray(p + 33, p + 33 + nl).toString('latin1');
    if (nl === 1 && (nm === '\0' || nm === '\x01')) { p += rl; continue; }
    if (flags & 2) isoDir(loc, dl, `${prefix}/${nm}`);
    else iso[`${prefix}/${nm.replace(/;1$/, '')}`] = { loc, size: dl };
    p += rl;
  }
}
isoDir(pvd.readUInt32LE(158), pvd.readUInt32LE(166), '');

log('');
log('path                       UDF-tag  type  size        extents(abs sector+count)  ISO9660 extent  same  ECC(16)-aligned');
for (const f of files.reverse()) {
  const i = iso[f.name];
  const first = Number(f.extents[0]?.split('+')[0]);
  log(`${f.name.padEnd(26)} ${f.tag.padEnd(8)} ${f.type.padEnd(5)} ${String(f.size).padEnd(11)} ${(f.extents.join(',') + ` ${f.adType}`).padEnd(27)} ${String(i?.loc ?? '-').padEnd(15)} ${i ? (i.loc === first ? 'yes' : 'NO') : '-'}     ${f.type === 'file' ? (first % 16 === 0 ? 'yes' : 'no') : '-'}`);
}
console.log(out.join('\n'));
