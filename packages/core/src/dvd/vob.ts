// VOB scan: 2048-byte MPEG-2 PS packs, NAV packs, AC-3 PTS progression, MPEG-2 sequence/GOP headers,
// the first video/audio presentation timestamps, and which audio streams carry payload.

import fs from 'node:fs';
import { throwIfAborted } from '../errors.ts';

export interface VobScan {
  packs: number;
  badPacks: number;
  navPacks: number;
  audioPts: number;
  audioPtsNonMonotonic: number;
  firstVideoPts: number | null;
  firstAudioPts: number | null;
  sequence: { width: number; height: number; aspectCode: number; frameRateCode: number; vbvKbit: number } | null;
  /** Sequence headers seen, and those whose size, aspect, frame rate or VBV differ from the first. */
  sequenceHeaders: number;
  sequenceMismatches: number;
  /** progressive_sequence of the first sequence extension. */
  progressiveSequence: number | null;
  /**
   * Every sequence extension, counted by its values: frame_rate_extension_n/_d (both 0 on DVD) and
   * progressive_sequence, e.g. { "0/0": 9 } and { "0": 9 }.
   */
  frameRateExtensions: Record<string, number>;
  progressiveSequences: Record<string, number>;
  /** Picture start codes, i.e. coded pictures. */
  pictures: number;
  maxGop: number;
  /**
   * Audio payload bytes per elementary stream: 'bd-0x80' for a private stream 1 substream (AC-3 0x80–0x87,
   * DTS 0x88–0x8f, LPCM 0xa0–0xaf), 'mpeg-0xc0' for MPEG audio. A PES without payload does not count.
   */
  audioPayload: Record<string, number>;
}

const PTS_HZ = 90000;

function readPts(b: Buffer, p: number): number {
  return (((b[p] ?? 0) >> 1) & 7) * 2 ** 30 + ((b.readUInt16BE(p + 1) >> 1) << 15) + (b.readUInt16BE(p + 3) >> 1);
}

export function scanVobs(files: readonly string[], signal?: AbortSignal): VobScan {
  const r: VobScan = {
    packs: 0, badPacks: 0, navPacks: 0, audioPts: 0, audioPtsNonMonotonic: 0,
    firstVideoPts: null, firstAudioPts: null, sequence: null, sequenceHeaders: 0, sequenceMismatches: 0,
    progressiveSequence: null, frameRateExtensions: {}, progressiveSequences: {}, pictures: 0, maxGop: 0, audioPayload: {},
  };
  const chunk = Buffer.alloc(2048 * 512);
  let lastAudioPts = -1;
  let gop = 0;
  let carry = Buffer.alloc(0);

  const scanVideo = (payload: Buffer) => {
    const b = Buffer.concat([carry, payload]);
    const end = b.length - 12;
    for (let i = 0; i < end; i++) {
      if (b[i] !== 0 || b[i + 1] !== 0 || b[i + 2] !== 1) continue;
      const c = b[i + 3];
      if (c === 0xb3) {
        const header = {
          width: ((b[i + 4] ?? 0) << 4) | ((b[i + 5] ?? 0) >> 4),
          height: (((b[i + 5] ?? 0) & 15) << 8) | (b[i + 6] ?? 0),
          aspectCode: (b[i + 7] ?? 0) >> 4,
          frameRateCode: (b[i + 7] ?? 0) & 15,
          vbvKbit: ((((b[i + 10] ?? 0) & 31) << 5) | ((b[i + 11] ?? 0) >> 3)) * 16,
        };
        r.sequenceHeaders++;
        if (!r.sequence) r.sequence = header;
        else if (JSON.stringify(header) !== JSON.stringify(r.sequence)) r.sequenceMismatches++;
      } else if (c === 0xb5 && (b[i + 4] ?? 0) >> 4 === 1) {
        const progressive = ((b[i + 5] ?? 0) >> 3) & 1;
        if (r.progressiveSequence === null) r.progressiveSequence = progressive;
        const rate = `${((b[i + 9] ?? 0) >> 5) & 3}/${(b[i + 9] ?? 0) & 31}`;
        r.frameRateExtensions[rate] = (r.frameRateExtensions[rate] ?? 0) + 1;
        r.progressiveSequences[progressive] = (r.progressiveSequences[progressive] ?? 0) + 1;
      } else if (c === 0xb8) {
        r.maxGop = Math.max(r.maxGop, gop);
        gop = 0;
      } else if (c === 0x00) {
        r.pictures++;
        gop++;
      }
    }
    carry = b.subarray(Math.max(0, end));
  };

  for (const file of files) {
    const fd = fs.openSync(file, 'r');
    try {
      let n: number;
      while ((n = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0) {
        throwIfAborted(signal);
        for (let off = 0; off + 2048 <= n; off += 2048) {
          const pack = chunk.subarray(off, off + 2048);
          r.packs++;
          if (pack.readUInt32BE(0) !== 0x1ba) {
            r.badPacks++;
            continue;
          }
          let p = 14 + ((pack[13] ?? 0) & 7);
          while (p + 6 <= 2048 && pack.readUInt32BE(p) >>> 8 === 1) {
            const id = pack[p + 3];
            const len = pack.readUInt16BE(p + 4);
            if (id === 0xbf) r.navPacks += 0.5; // PCI + DSI
            if (id !== undefined && id >= 0xc0 && id <= 0xdf) {
              const payload = 6 + len - (9 + (pack[p + 8] ?? 0));
              if (payload > 0) r.audioPayload[`mpeg-0x${id.toString(16)}`] = (r.audioPayload[`mpeg-0x${id.toString(16)}`] ?? 0) + payload;
            }
            if (id === 0xe0 || id === 0xbd) {
              const headerLen = pack[p + 8] ?? 0;
              const hasPts = ((pack[p + 7] ?? 0) & 0x80) !== 0;
              if (id === 0xe0) {
                if (hasPts && r.firstVideoPts === null) r.firstVideoPts = readPts(pack, p + 9) / PTS_HZ;
                scanVideo(pack.subarray(p + 9 + headerLen, p + 6 + len));
              } else {
                // Private stream 1: substream id, then (audio) frame count and first access unit pointer.
                const sub = pack[p + 9 + headerLen] ?? 0;
                const isAudio = (sub >= 0x80 && sub <= 0x8f) || (sub >= 0xa0 && sub <= 0xaf);
                const payload = 6 + len - (9 + headerLen) - (sub >= 0xa0 ? 7 : 4);
                if (isAudio && payload > 0) r.audioPayload[`bd-0x${sub.toString(16)}`] = (r.audioPayload[`bd-0x${sub.toString(16)}`] ?? 0) + payload;
              }
              if (id === 0xbd && pack[p + 9 + headerLen] === 0x80 && hasPts) {
                const t = readPts(pack, p + 9);
                if (r.firstAudioPts === null) r.firstAudioPts = t / PTS_HZ;
                r.audioPts++;
                if (t <= lastAudioPts) r.audioPtsNonMonotonic++;
                lastAudioPts = t;
              }
            }
            p += 6 + len;
          }
        }
        if (n % 2048) r.badPacks++;
      }
    } finally {
      fs.closeSync(fd);
    }
  }
  r.maxGop = Math.max(r.maxGop, gop);
  return r;
}
