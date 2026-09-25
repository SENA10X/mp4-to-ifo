// Test environment: toolchain resolution (LGPL build preferred) and generated test media.
// Media is generated with FFmpeg's native (LGPL) encoders, so tests run with the LGPL build too.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findOnPath, resolveToolchain, type Toolchain } from '../../src/toolchain.ts';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
export const LGPL_BIN = process.env.MP4_TO_IFO_FFMPEG_DIR ?? path.join(REPO, 'build/ffmpeg-lgpl/bin');

/** Toolchain for tests: the LGPL build when present (as production will use), else PATH. */
export function testToolchain(): Toolchain | null {
  try {
    const lgpl = path.join(LGPL_BIN, 'ffmpeg');
    if (fs.existsSync(lgpl)) {
      return resolveToolchain({ ffmpeg: lgpl, ffprobe: path.join(LGPL_BIN, 'ffprobe') });
    }
    return resolveToolchain();
  } catch {
    return null;
  }
}

export const toolchain = testToolchain();
export const skipNoTools = toolchain ? false : 'ffmpeg/ffprobe/dvdauthor not available';

export function tempDir(prefix = 'mp4-to-ifo-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function ff(args: string[]): void {
  if (!toolchain) throw new Error('no toolchain');
  execFileSync(toolchain.ffmpeg, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'ignore', 'inherit'] });
}

export interface SampleOptions {
  seconds?: number;
  size?: string;
  rate?: string;
  /**
   * Audio: 'stereo' (default), 'mono', '5.1', '5.1-loud', 'quad' (unsupported layout), 'none'.
   * Timing material: 'clicks' (a click every second), 'noise' (seeded white noise, unique at every lag),
   * 'tone' (steady 440 Hz), 'pulses' (a click every 0.2 s: periodic within the sync search range),
   * 'silent' (a stereo track of digital silence).
   */
  audio?: 'stereo' | 'mono' | '5.1' | '5.1-loud' | 'quad' | 'none' | 'clicks' | 'noise' | 'tone' | 'pulses' | 'silent';
  /** Frame index as a 12-bit code and a click every second (see motion.ts). */
  motion?: boolean;
  /** With `motion`: the pictures repeat every `period` frames (the code of n mod period). */
  period?: number;
  /** A still picture (SMPTE bars) for the whole clip. */
  still?: boolean;
  /** Exact number of video frames (overrides seconds for the picture; audio lasts as long). */
  frames?: number;
  /**
   * The picture changes only at this rate; each picture is repeated to fill `rate` (e.g. 15 fps
   * content in a 60 fps file: every picture four times). Motion and testsrc2 pictures.
   */
  contentRate?: string;
  /** Three still pictures, 3 s each: hard cuts, or 1 s crossfades between them (7 s). */
  slideshow?: 'cut' | 'crossfade';
  /**
   * Pictures without structure in an 8 s clip, inside the first and third sampling windows: 'cut' to
   * black at 1.5-2.4 s and 4.5-5.6 s, 'noisy' the same to near-black with grain (grain throughout), 'fade'
   * out over 2-4 s and in over 5-7 s.
   */
  blackout?: 'cut' | 'noisy' | 'fade';
  /** Extra ffmpeg filters for the generated picture (e.g. darken, add grain). */
  picture?: string;
  /** Drop frames irregularly and keep timestamps (VFR). */
  vfr?: boolean;
  rotation?: number;
  subtitles?: boolean;
  /** Start the video this many seconds after the audio (e.g. 1/60, as the Phase 2 VFR sample did). */
  videoDelay?: number;
}

/** Generate an MP4 test sample (MPEG-4 Part 2 video, AAC audio). */
export function makeSample(file: string, o: SampleOptions = {}): string {
  const [rn, rd] = (o.rate ?? '30000/1001').split('/').map(Number) as [number, number?];
  const seconds = o.frames ? o.frames * (rd ?? 1) / rn : (o.seconds ?? 4);
  const size = o.size ?? '640x360';
  const rate = o.rate ?? '30000/1001';
  const [w, h] = size.split('x').map(Number) as [number, number];
  const pictureRate = o.contentRate ?? rate;
  const repeat = o.contentRate ? `,fps=${rate}` : '';
  let video: string;
  if (o.slideshow) {
    const photo = (src: string, d: number, label: string) => `${src}=s=${size}:r=${rate}:d=${d},format=yuv420p[${label}]`;
    video = o.slideshow === 'cut'
      ? `${photo('smptebars', 3, 'a')};${photo('pal75bars', 3, 'b')};${photo('rgbtestsrc', 3, 'c')};[a][b][c]concat=n=3:v=1:a=0[out0]`
      : `${photo('smptebars', 3, 'a')};${photo('pal75bars', 3, 'b')};${photo('rgbtestsrc', 3, 'c')};` +
        '[a][b]xfade=transition=fade:duration=1:offset=2[ab];[ab][c]xfade=transition=fade:duration=1:offset=4[out0]';
  } else if (o.motion) {
    const boxW = Math.floor(w / 12);
    const boxes = Array.from({ length: 12 }, (_, i) =>
      `drawbox=x=${i * boxW}:y=0:w=${boxW}:h=${h}:color=white:t=fill:enable='eq(mod(floor(${o.period ? `mod(n,${o.period})` : 'n'}/${2 ** i}),2),1)'`).join(',');
    video = `color=c=black:s=${size}:r=${pictureRate}:d=${seconds},format=yuv420p,${boxes}${repeat}`;
  } else if (o.still) {
    video = `smptebars=s=${size}:r=${rate}:d=${seconds}`;
  } else {
    video = `testsrc2=s=${size}:r=${pictureRate}:d=${seconds}${repeat}`;
  }
  if (o.picture) video += `,${o.picture}`;
  if (o.blackout === 'cut' || o.blackout === 'noisy') {
    video += `,drawbox=x=0:y=0:w=iw:h=ih:color=${o.blackout === 'cut' ? 'black' : '0x101010'}:t=fill:enable='between(t,1.5,2.4)+between(t,4.5,5.6)'`;
    if (o.blackout === 'noisy') video += ',noise=alls=6:allf=t';
  }
  if (o.blackout === 'fade') video += ',split[a][b];[a]trim=0:4,fade=t=out:st=2:d=2[x];[b]trim=4,setpts=PTS-STARTPTS,fade=t=in:st=1:d=2[y];[x][y]concat';
  if (o.vfr) video += ",select='not(gte(mod(t\\,3)\\,1)*mod(n\\,2))*not(eq(mod(n*7\\,23)\\,0))'";
  const click = "if(lt(mod(t,1),0.02),0.5*sin(2*PI*1000*t),0)";
  const tone = (f: number, a: number) => `${a}*sin(2*PI*${f}*t)`;
  const audioSrc: Record<string, string | null> = {
    stereo: o.motion ? `aevalsrc='${click}|${click}':s=48000:d=${seconds}` : `aevalsrc='${tone(440, 0.3)}*(0.5+0.5*sin(2*PI*1.3*t))|${tone(660, 0.3)}':s=48000:d=${seconds}`,
    mono: `aevalsrc='${tone(440, 0.5)}':s=48000:d=${seconds}`,
    '5.1': `aevalsrc='${tone(440, 0.3)}|${tone(554, 0.3)}|${tone(300, 0.25)}|${tone(50, 0.3)}|${tone(220, 0.1)}|${tone(330, 0.1)}':s=48000:d=${seconds}:c=5.1`,
    '5.1-loud': `aevalsrc='${tone(220, 0.708)}|${tone(330, 0.708)}|${tone(220, 0.708)}|${tone(40, 0.708)}|${tone(220, 0.5)}|${tone(330, 0.5)}':s=48000:d=${seconds}:c=5.1`,
    quad: `aevalsrc='${tone(440, 0.3)}|${tone(554, 0.3)}|${tone(220, 0.1)}|${tone(330, 0.1)}':s=48000:d=${seconds}:c=quad`,
    none: null,
    clicks: `aevalsrc='${click}|${click}':s=48000:d=${seconds}`,
    noise: `anoisesrc=r=48000:a=0.3:c=white:seed=7:d=${seconds},aformat=channel_layouts=stereo`,
    tone: `aevalsrc='${tone(440, 0.5)}|${tone(440, 0.5)}':s=48000:d=${seconds}`,
    pulses: `aevalsrc='if(lt(mod(t,0.2),0.02),0.5*sin(2*PI*1000*t),0)|if(lt(mod(t,0.2),0.02),0.5*sin(2*PI*1000*t),0)':s=48000:d=${seconds}`,
    silent: `anullsrc=r=48000:cl=stereo:d=${seconds}`,
  };
  const a = audioSrc[o.audio ?? 'stereo'] ?? null;
  const args = ['-f', 'lavfi', '-i', video];
  if (a) args.push('-f', 'lavfi', '-i', a);
  if (o.subtitles) {
    const srt = `${file}.srt`;
    fs.writeFileSync(srt, '1\n00:00:00,500 --> 00:00:01,500\nhello\n');
    args.push('-i', srt);
  }
  args.push('-map', '0:v');
  if (a) args.push('-map', '1:a');
  if (o.subtitles) args.push('-map', `${a ? 2 : 1}:s`, '-c:s', 'mov_text');
  args.push('-c:v', 'mpeg4', '-q:v', '3', '-g', '30');
  if (o.frames) args.push('-frames:v', String(o.frames));
  if (o.vfr) args.push('-fps_mode', 'vfr');
  if (a) args.push('-c:a', 'aac', '-b:a', '256k');
  args.push('-movflags', '+faststart', file);
  ff(args);
  if (o.videoDelay) {
    const tmp = `${file}.delay.mp4`;
    fs.renameSync(file, tmp);
    ff(['-itsoffset', String(o.videoDelay), '-i', tmp, '-i', tmp, '-map', '0:v', '-map', '1:a?', '-c', 'copy', file]);
    fs.rmSync(tmp);
  }
  if (o.rotation) {
    // -display_rotation is an input option: re-mux the encoded file with the rotation applied.
    const tmp = `${file}.rot.mp4`;
    fs.renameSync(file, tmp);
    ff(['-display_rotation', String(o.rotation), '-i', tmp, '-c', 'copy', file]);
    fs.rmSync(tmp);
  }
  return file;
}

export function which(name: string): string | null {
  return findOnPath(name);
}
