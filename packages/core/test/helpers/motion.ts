// Ground-truth timing of a DVD output made from a motion sample (each frame shows its index as a
// 12-bit code; a click every second). Source times come from decoding the source itself, so the
// result does not depend on how the sample was muxed. Independent of the core's sync verification.

import { execFileSync, spawnSync } from 'node:child_process';
import { toolchain } from './env.ts';

const FRAME = 1001 / 30000;

export interface MotionResult {
  distinctFrames: number;
  uniquePerSecond: number;
  backwards: number;
  /** Spread of (output time - source time) where frames first appear, around the median. */
  timingErrorMaxMs: number;
  /** Audio offset minus picture offset (output - source); positive = sound late. */
  avSyncMs: number | null;
}

function codesOf(raw: Buffer, frameBytes: number, width: number, rows: [number, number], cols: number[], parity: number | null): number[] {
  const out: number[] = [];
  for (let k = 0; k * frameBytes + frameBytes <= raw.length; k++) {
    for (const p of parity === null ? [0] : [0, 1]) {
      let code = 0;
      cols.forEach((x, i) => {
        let sum = 0;
        let n = 0;
        for (let y = rows[0] + (parity === null ? 0 : p); y < rows[1]; y += parity === null ? 1 : 2) {
          sum += raw[k * frameBytes + y * width + x] ?? 0;
          n++;
        }
        if (sum / n > 128) code |= 1 << i;
      });
      out.push(code);
    }
  }
  return out;
}

function clicks(input: string, map: string): number[] {
  const tc = toolchain!;
  const r = spawnSync(tc.ffmpeg, ['-v', 'info', '-copyts', '-i', input, '-map', map, '-af', 'aformat=sample_fmts=s16:channel_layouts=mono:sample_rates=48000,ashowinfo', '-f', 's16le', '-'], { maxBuffer: 2 ** 30 });
  const first = Number(/pts_time:\s*(-?[\d.]+)/.exec(r.stderr.toString())?.[1] ?? 0);
  const pcm = r.stdout;
  const out: number[] = [];
  for (let i = 0, quiet = 0; i < pcm.length / 2; i++) {
    if (i < quiet) continue;
    if (Math.abs(pcm.readInt16LE(i * 2)) > 3000) {
      out.push(first + i / 48000);
      quiet = i + 24000;
    }
  }
  return out;
}

function frameTimes(input: string, map: string, vf: string): { times: number[]; raw: Buffer } {
  const tc = toolchain!;
  const r = spawnSync(tc.ffmpeg, ['-v', 'info', '-copyts', '-i', input, '-map', map, '-vf', `${vf}showinfo`, '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 2 ** 31 });
  const times = [...r.stderr.toString().matchAll(/Parsed_showinfo.*?pts_time:\s*(-?[\d.]+)/g)].map((m) => Number(m[1]));
  return { times, raw: r.stdout };
}

const median = (v: number[]) => [...v].sort((a, b) => a - b)[v.length >> 1] ?? 0;
const origin = (input: string) => Number(execFileSync(toolchain!.ffprobe, ['-v', 'error', '-show_entries', 'format=start_time', '-of', 'csv=p=0', input]).toString().trim());

export function probeMotion(source: string, sourceSize: [number, number], vobConcat: string, active: { width: number; x: number }): MotionResult {
  // Source: code -> time on the source timeline.
  const [sw, sh] = sourceSize;
  const sBox = Math.floor(sw / 12);
  const src = frameTimes(source, '0:v:0', '');
  const srcCodes = codesOf(src.raw, sw * sh, sw, [Math.floor(sh * 0.2), Math.floor(sh * 0.8)], Array.from({ length: 12 }, (_, i) => Math.round((i + 0.5) * sBox)), null);
  const srcOrigin = origin(source);
  const codeTime = new Map<number, number>();
  srcCodes.forEach((c, i) => codeTime.set(c, (src.times[i] ?? 0) - srcOrigin));

  // Output fields (TFF: top field first, half a frame apart).
  const W = 720;
  const H = 480;
  const out = frameTimes(vobConcat, '0:v:0', '');
  const oBox = active.width * (sBox * 12 / sw) / 12;
  const outCodes = codesOf(out.raw, W * H, W, [100, 380], Array.from({ length: 12 }, (_, i) => Math.round(active.x + (i + 0.5) * oBox)), 0);
  const outOrigin = origin(vobConcat);
  const fields = outCodes.map((code, i) => ({ code, t: (out.times[i >> 1] ?? 0) - outOrigin + (i % 2) * FRAME / 2 }));

  const firsts = fields.filter((f, i) => i === 0 || f.code !== fields[i - 1]?.code).filter((f) => codeTime.has(f.code));
  const offsets = firsts.map((f) => f.t - (codeTime.get(f.code) ?? 0));
  const videoOffset = median(offsets);
  let backwards = 0;
  for (let i = 1; i < fields.length; i++) if ((fields[i]?.code ?? 0) < (fields[i - 1]?.code ?? 0)) backwards++;

  const sc = clicks(source, '0:a:0?').map((t) => t - srcOrigin);
  const oc = clicks(vobConcat, '0:a:0').map((t) => t - outOrigin);
  const audioOffsets = oc.map((t) => {
    const s = sc.reduce((best, x) => (Math.abs(x - t) < Math.abs(best - t) ? x : best), Infinity);
    return t - s;
  }).filter((d) => Math.abs(d) < 0.2);
  const distinct = new Set(fields.map((f) => f.code)).size;
  return {
    distinctFrames: distinct,
    uniquePerSecond: distinct / (outCodes.length / 2 * FRAME),
    backwards,
    timingErrorMaxMs: Math.max(0, ...offsets.map((o) => Math.abs(o - videoOffset))) * 1000,
    avSyncMs: audioOffsets.length ? (median(audioOffsets) - videoOffset) * 1000 : null,
  };
}

export interface FieldSequence {
  fields: number;
  /** Consecutive fields whose code goes up by exactly one, stays, or goes back. */
  next: number;
  repeats: number;
  backwards: number;
  /** Fields with a code box neither black nor white: two moments mixed in one field. */
  blended: number;
  distinct: number;
}

/**
 * The fields of a DVD made from an interlaced motion sample (makeSample `interlaced`), each read on its
 * own lines, in display order from each frame's own field flag. Independent of the core: no plan, no
 * verification code.
 */
export function fieldSequence(vobConcat: string, active: { width: number; x: number }): FieldSequence {
  const r = spawnSync(toolchain!.ffmpeg, ['-v', 'info', '-i', vobConcat, '-map', '0:v:0', '-vf', 'showinfo', '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 2 ** 31 });
  const flags = [...r.stderr.toString().matchAll(/Parsed_showinfo.*? i:([TBP])/g)].map((m) => m[1]);
  const W = 720;
  const frame = W * 480;
  const box = active.width / 12;
  const codes: number[] = [];
  let blended = 0;
  for (let k = 0; (k + 1) * frame <= r.stdout.length; k++) {
    for (const parity of flags[k] === 'B' ? [1, 0] : [0, 1]) {
      let code = 0;
      let mixed = false;
      for (let i = 0; i < 12; i++) {
        const x = Math.round(active.x + (i + 0.5) * box);
        let sum = 0;
        let n = 0;
        for (let y = 60 + parity; y < 420; y += 2, n++) sum += r.stdout[k * frame + y * W + x] ?? 0;
        const v = sum / n;
        if (v > 60 && v < 190) mixed = true;
        if (v > 128) code |= 1 << i;
      }
      if (mixed) blended++;
      codes.push(code);
    }
  }
  const steps = codes.slice(1).map((c, i) => c - (codes[i] ?? 0));
  return {
    fields: codes.length,
    next: steps.filter((d) => d === 1).length,
    repeats: steps.filter((d) => d === 0).length,
    backwards: steps.filter((d) => d < 0).length,
    blended,
    distinct: new Set(codes).size,
  };
}
