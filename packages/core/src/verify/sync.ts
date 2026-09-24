// A/V sync measurement by content, not timestamps. The Phase 2 59.94 bug kept every timestamp
// intact while showing each picture one frame late, so this compares pictures and sound.
//
// Picture: change points from the field comparison (fields.ts): where the output first shows a source
// moment against where that moment starts in the source. Repeated source frames are one moment, so
// the start of a moment is a change in the picture, never a guess among identical frames (Phase 5.2).
// Sound: cross-correlate 8 kHz mono source and output windows.
//
// The three timings are judged separately (Phase 5.1): picture timing needs moving pictures, sound
// timing needs distinctive sound, and only their difference needs both. Sound is placed against the
// output's video start timestamp, the anchor the DVD player uses; a still picture therefore does not
// hide a sound offset.

import { isCancelled } from '../errors.ts';
import { runTool, type RunResult } from '../process.ts';
import type { Toolchain } from '../toolchain.ts';
import type { ChangePoint } from './fields.ts';

const AUDIO_RATE = 8000;
const WINDOW_SEC = 1.2;
const SEARCH_SEC = 0.25;
/** Fewer picture change points than this: picture timing is not measurable. */
export const MIN_CHANGE_POINTS = 8;

export interface SyncMeasurement {
  status: 'measured' | 'partial' | 'indeterminate';
  windows: number[];
  videoMatches: number;
  videoOffsetMs: number | null;
  audioMatches: number;
  audioOffsetMs: number | null;
  /**
   * Picture timing error: measured display time minus the time a correct conversion shows that
   * source moment (strategy model), after removing the output's video start timestamp.
   */
  videoTimelineErrorMs: number | null;
  /**
   * Sound timing error: output sound time minus source sound time, against the output's video start
   * timestamp (positive = sound late). Measurable without moving pictures.
   */
  audioTimingErrorMs: number | null;
  /** Per-window sound lags that had a unique correlation peak (ms, relative to the output origin). */
  audioWindowOffsetsMs: number[];
  /** Picture offset minus sound offset once the strategy's own timing is removed; positive = picture late. */
  introducedOffsetMs: number | null;
}

export interface SyncInput {
  toolchain: Toolchain;
  /** origin: container start time (ffprobe format start_time) that both streams are relative to. */
  source: { path: string; origin: number; audioIndex: number | null; duration: number };
  /** videoStart: first video timestamp of the output, seconds from its origin. */
  output: { input: string; origin: number; videoStart: number };
  /** Picture change points from the field comparison (fields.ts), on the same windows. */
  changes: ChangePoint[];
  /** Where a correct conversion first shows a source moment (see expectedDisplayTime). */
  expectedDisplayTime: (sourceTime: number) => number;
  signal?: AbortSignal;
}

/**
 * Decode 8 kHz mono audio from about `start`; returns samples and the time of the first one, or null
 * when there is no audio to decode (the stream checks judge a missing or broken stream).
 */
async function decodeAudio(tc: Toolchain, input: string, origin: number, map: string, start: number, duration: number, signal?: AbortSignal): Promise<{ samples: Float32Array; start: number } | null> {
  let first: number | null = null;
  let r: RunResult;
  try {
    r = await runTool(tc.ffmpeg, [
      '-hide_banner', '-nostdin', '-v', 'info', '-copyts', '-ss', Math.max(0, start).toFixed(4), '-i', input, '-map', map,
      // -t would count from the copied timestamps; limit by samples instead.
      '-af', `aformat=sample_fmts=flt:sample_rates=${AUDIO_RATE}:channel_layouts=mono,ashowinfo,atrim=end_sample=${Math.ceil(duration * AUDIO_RATE)}`,
      '-f', 'f32le', '-',
    ], {
      errorCode: 'VERIFY_ERROR',
      signal,
      binary: true,
      onStderrLine: (line) => {
        const m = /pts_time:\s*(-?[\d.]+)/.exec(line);
        if (first === null && m?.[1] && /Parsed_ashowinfo/.test(line)) first = Number(m[1]);
      },
    });
  } catch (error) {
    if (isCancelled(error)) throw error;
    return null;
  }
  if (first === null) return null;
  const b = r.stdoutBuffer;
  return { samples: new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length - (b.length % 4))), start: first - origin };
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

/** Best lag (seconds, output - source) by normalised cross-correlation, or null if not confident. */
export function matchAudio(source: Float32Array, sourceStart: number, output: Float32Array, outputStart: number): number | null {
  let energy = 0;
  for (const v of output) energy += v * v;
  if (energy / Math.max(1, output.length) < 1e-7) return null; // silence
  const maxLag = Math.round(SEARCH_SEC * AUDIO_RATE);
  const base = Math.round((outputStart - sourceStart) * AUDIO_RATE);
  let bestLag = 0;
  let best = -Infinity;
  const scores: number[] = [];
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let dot = 0;
    let ns = 0;
    const shift = base - lag;
    for (let n = 0; n < output.length; n++) {
      const s = source[n + shift];
      if (s === undefined) continue;
      const o = output[n] ?? 0;
      dot += o * s;
      ns += s * s;
    }
    scores.push(ns > 0 ? dot / Math.sqrt(ns * energy) : -Infinity);
  }
  scores.forEach((score, i) => {
    if (score > best) {
      best = score;
      bestLag = i - maxLag;
    }
  });
  // Periodic signals (steady tones) correlate almost equally at many lags: require a unique peak.
  const guard = Math.round(0.002 * AUDIO_RATE);
  const runnerUp = Math.max(...scores.filter((_, i) => Math.abs(i - maxLag - bestLag) > guard));
  return best >= 0.5 && best - runnerUp >= 0.1 ? bestLag / AUDIO_RATE : null;
}

/** Window centres (seconds): five spread over the video, or the middle of a short one. Deterministic. */
export function syncWindows(duration: number): number[] {
  if (duration < 2 * WINDOW_SEC + 1) return [duration / 2];
  return [0.15, 0.35, 0.55, 0.75, 0.9].map((f) => Math.min(Math.max(f * duration, WINDOW_SEC), duration - WINDOW_SEC));
}

export async function measureSync(input: SyncInput): Promise<SyncMeasurement> {
  const { toolchain: tc, source, output, signal } = input;
  const windows = syncWindows(source.duration);
  const pairs = input.changes;
  const audioOffsets: number[] = [];

  if (source.audioIndex !== null) {
    for (const centre of windows) {
      const outStart = Math.max(0, centre - WINDOW_SEC / 2);
      const srcStart = Math.max(0, outStart - SEARCH_SEC - 0.1);
      const srcLen = WINDOW_SEC + 2 * (SEARCH_SEC + 0.1);
      const s = await decodeAudio(tc, source.path, source.origin, `0:${source.audioIndex}`, srcStart, srcLen, signal);
      const o = await decodeAudio(tc, output.input, output.origin, '0:a:0', outStart, WINDOW_SEC, signal);
      const lag = s && o ? matchAudio(s.samples, s.start, o.samples, o.start) : null;
      if (lag !== null) audioOffsets.push(lag);
    }
  }
  const raw = median(pairs.map((p) => p.out - p.src));
  const timeline = median(pairs.map((p) => p.out - output.videoStart - input.expectedDisplayTime(p.src)));
  const au = median(audioOffsets);
  const videoOk = pairs.length >= MIN_CHANGE_POINTS;
  const audioOk = audioOffsets.length >= Math.min(2, windows.length);
  const ms = (x: number | null) => (x === null ? null : Math.round(x * 10000) / 10);
  return {
    status: videoOk && (audioOk || source.audioIndex === null) ? 'measured' : videoOk || audioOk ? 'partial' : 'indeterminate',
    windows,
    videoMatches: pairs.length,
    videoOffsetMs: videoOk ? ms(raw) : null,
    audioMatches: audioOffsets.length,
    audioOffsetMs: audioOk ? ms(au) : null,
    videoTimelineErrorMs: videoOk ? ms(timeline) : null,
    audioTimingErrorMs: audioOk && au !== null ? ms(au - output.videoStart) : null,
    audioWindowOffsetsMs: audioOffsets.map((x) => ms(x) ?? 0),
    introducedOffsetMs: videoOk && audioOk && timeline !== null && au !== null ? ms(timeline + output.videoStart - au) : null,
  };
}
