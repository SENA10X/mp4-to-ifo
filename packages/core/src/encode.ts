// FFmpeg: downmix peak measurement and the 2-pass MPEG-2 / AC-3 encode into a DVD program stream.

import path from 'node:path';
import { ConversionError } from './errors.ts';
import type { LogSink } from './log.ts';
import type { ConversionPlan } from './plan.ts';
import { audioFilterChain, clipGuardGainDb } from './profile/audio.ts';
import { runTool } from './process.ts';
import type { Toolchain } from './toolchain.ts';

export interface EncodeContext {
  toolchain: Toolchain;
  signal?: AbortSignal;
  log?: LogSink;
}

/** Sample peak (dBFS) of the planned downmix, measured over the whole track. */
export async function measureDownmixPeak(plan: ConversionPlan, ctx: EncodeContext): Promise<number> {
  const audio = plan.audio;
  if (!audio?.matrix || audio.sourceIndex === null) return Number.NEGATIVE_INFINITY;
  const r = await runTool(ctx.toolchain.ffmpeg, [
    '-hide_banner', '-nostdin', '-v', 'info', '-i', plan.input.path, '-map', `0:${audio.sourceIndex}`,
    '-af', `${audio.matrix},astats=measure_perchannel=none:measure_overall=Peak_level`, '-f', 'null', '-',
  ], { errorCode: 'ENCODE_ERROR', signal: ctx.signal, log: ctx.log });
  const m = /Peak level dB:\s*(-?inf|-?[\d.]+)/.exec(r.stderr);
  if (!m?.[1]) throw new ConversionError('ENCODE_ERROR', 'Audio peak could not be measured', { reason: 'PEAK_MEASUREMENT' });
  return m[1].endsWith('inf') ? Number.NEGATIVE_INFINITY : Number(m[1]);
}

export interface EncodeResult {
  mpegPath: string;
  audioGainDb: number;
  audioPeakDbfs: number | null;
}

export type PassProgress = (pass: 1 | 2, mediaTime: number) => void;

export function videoArgs(plan: ConversionPlan, passLogPrefix: string): string[] {
  const v = plan.video;
  return [
    '-map', `0:${v.sourceIndex}`,
    '-vf', v.filter,
    '-c:v', 'mpeg2video',
    '-b:v', `${v.bitrateKbps}k`,
    '-maxrate', `${v.maxrateKbps}k`,
    '-minrate', '0',
    '-bufsize', String(v.bufsizeBits),
    '-g', String(v.gopFrames),
    '-bf', String(v.bFrames),
    '-flags', '+ildct+ilme', // progressive_sequence=0 (DVD-Video)
    '-top', '1',
    '-aspect', '16:9',
    '-color_primaries', 'smpte170m',
    '-color_trc', 'smpte170m',
    '-colorspace', 'smpte170m',
    // Same frame-rate handling in both passes so pass 2 sees exactly the frames pass 1 logged.
    '-fps_mode', 'cfr',
    '-r', '30000/1001',
    '-passlogfile', passLogPrefix,
  ];
}

export function audioArgs(plan: ConversionPlan, gainDb: number): { inputs: string[]; args: string[] } {
  const audio = plan.audio;
  if (!audio) throw new ConversionError('INTERNAL_ERROR', 'Plan has no audio plan');
  const encode = ['-c:a', 'ac3', '-b:a', `${audio.bitrateKbps}k`, '-ar', '48000', '-ac', '2'];
  if (audio.strategy === 'silence') {
    return {
      inputs: ['-f', 'lavfi', '-t', plan.input.videoEnd.toFixed(6), '-i', 'anullsrc=r=48000:cl=stereo'],
      args: ['-map', '1:a:0', '-af', audioFilterChain(audio, 0), ...encode],
    };
  }
  return { inputs: [], args: ['-map', `0:${audio.sourceIndex}`, '-af', audioFilterChain(audio, gainDb), ...encode] };
}

function progressParser(onTime: (seconds: number) => void): (line: string) => void {
  return (line) => {
    const m = /^out_time_us=(\d+)/.exec(line);
    if (m?.[1]) onTime(Number(m[1]) / 1e6);
  };
}

export async function encode(plan: ConversionPlan, workDir: string, ctx: EncodeContext & { onProgress?: PassProgress }): Promise<EncodeResult> {
  let audioGainDb = 0;
  let audioPeakDbfs: number | null = null;
  if (plan.audio?.clipGuardCeilingDbfs != null) {
    audioPeakDbfs = await measureDownmixPeak(plan, ctx);
    audioGainDb = clipGuardGainDb(audioPeakDbfs, plan.audio.clipGuardCeilingDbfs);
    ctx.log?.({ level: 'info', event: 'audio.clip_guard', message: 'downmix peak measured', data: { peakDbfs: audioPeakDbfs, gainDb: audioGainDb } });
  }

  const passLog = path.join(workDir, 'pass');
  const mpegPath = path.join(workDir, 'title.mpg');
  const base = ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-progress', 'pipe:1', '-nostats'];
  const run = { errorCode: 'ENCODE_ERROR' as const, signal: ctx.signal, log: ctx.log, cwd: workDir };

  await runTool(ctx.toolchain.ffmpeg, [...base, '-i', plan.input.path, ...videoArgs(plan, passLog), '-pass', '1', '-an', '-f', 'null', '-'], {
    ...run,
    onStdoutLine: progressParser((t) => ctx.onProgress?.(1, t)),
  });

  const audio = audioArgs(plan, audioGainDb);
  await runTool(ctx.toolchain.ffmpeg, [
    ...base, '-i', plan.input.path, ...audio.inputs,
    ...videoArgs(plan, passLog), '-pass', '2',
    ...audio.args,
    '-map_metadata', '-1', '-map_chapters', '-1',
    '-f', 'dvd', '-muxrate', '10080000', '-packetsize', '2048',
    mpegPath,
  ], { ...run, onStdoutLine: progressParser((t) => ctx.onProgress?.(2, t)) });

  return { mpegPath, audioGainDb, audioPeakDbfs };
}
