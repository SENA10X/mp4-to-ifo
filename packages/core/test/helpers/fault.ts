// Fault injection on the production path: a toolchain whose ffmpeg is a wrapper that rewrites the
// arguments of the final encode (the only ffmpeg run with `-f dvd`) and then runs the real ffmpeg.
// Nothing in the core knows about it; the job, authoring, ZIP, ISO and verification run unchanged.

import fs from 'node:fs';
import path from 'node:path';
import type { Toolchain } from '../../src/toolchain.ts';

/**
 * `rewrite` is the source of a function `(args: string[]) => string[]` applied to the final encode's
 * arguments. It runs in a separate node process, so it must be self-contained.
 */
export function faultToolchain(base: Toolchain, dir: string, rewrite: string): Toolchain {
  fs.mkdirSync(dir, { recursive: true });
  const wrapper = path.join(dir, 'ffmpeg');
  fs.writeFileSync(wrapper, `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const rewrite = ${rewrite};
let args = process.argv.slice(2);
const i = args.indexOf('-f');
if (i >= 0 && args[i + 1] === 'dvd') args = rewrite(args);
const r = spawnSync(${JSON.stringify(base.ffmpeg)}, args, { stdio: 'inherit' });
process.exit(r.status ?? 1);
`);
  fs.chmodSync(wrapper, 0o755);
  return { ...base, ffmpeg: wrapper };
}

/** Delay the audio content (not its timestamps) by `ms`, as a wrong audio filter would. */
export const AUDIO_DELAY = (ms: number) => `(args) => args.map((a, i) => args[i - 1] === '-af' ? 'adelay=${ms}:all=1,' + a : a)`;

/** Mux a second, real AC-3 stream (the same source track mapped twice). */
export const SECOND_AUDIO = `(args) => {
  const i = args.indexOf('-c:a');
  const map = args.slice(0, i).lastIndexOf('-map');
  return [...args.slice(0, map), '-map', args[map + 1], ...args.slice(map)];
}`;

/**
 * Shift the audio content by `ms` (positive = late) and keep its length `seconds`: only the timing is
 * wrong, not the duration.
 */
export const AUDIO_SHIFT = (ms: number, seconds: number) => ms >= 0
  ? `(args) => args.map((a, i) => args[i - 1] === '-af' ? 'adelay=${ms}:all=1,atrim=end=${seconds},' + a : a)`
  : `(args) => args.map((a, i) => args[i - 1] === '-af' ? 'atrim=start=${-ms / 1000},asetpts=PTS-STARTPTS,apad=whole_dur=${seconds},' + a : a)`;
