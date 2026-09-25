// Input analysis (ffprobe) into a normalized model, and input validation.

import fs from 'node:fs';
import path from 'node:path';
import { ConversionError } from './errors.ts';
import type { LogSink } from './log.ts';
import { runTool } from './process.ts';
import type { Toolchain } from './toolchain.ts';

export interface Rational {
  num: number;
  den: number;
}

export interface ColorInfo {
  space: string | null;
  transfer: string | null;
  primaries: string | null;
  range: string | null;
}

export type HdrKind = 'sdr' | 'hdr10' | 'hlg' | 'dolby-vision' | 'bt2020-sdr' | 'unknown';

export interface HdrInfo {
  kind: HdrKind;
  /** For Dolby Vision: which compatible base layer the stream carries ('none' = profile 5 style). */
  dolbyVision: { profile: number | null; compatibilityId: number | null; baseLayer: 'sdr' | 'hdr10' | 'hlg' | 'none' } | null;
}

export interface AudioTrack {
  index: number;
  codec: string;
  sampleRate: number;
  channels: number;
  channelLayout: string | null;
  default: boolean;
  startTime: number | null;
  duration: number | null;
}

export interface SubtitleTrack {
  index: number;
  codec: string;
  language: string | null;
}

export interface VideoInfo {
  index: number;
  codec: string;
  profile: string | null;
  width: number;
  height: number;
  sampleAspectRatio: Rational;
  /** Display aspect ratio after rotation, as a number (width / height). */
  displayAspectRatio: number;
  frameRate: number;
  rFrameRate: Rational;
  avgFrameRate: Rational;
  isVariableFrameRate: boolean;
  frameCount: number | null;
  pixelFormat: string | null;
  fieldOrder: string | null;
  /** Progressive or interlaced, and which field comes first (see scanOf). */
  scan: Scan;
  color: ColorInfo;
  rotation: number;
  hdr: HdrInfo;
  startTime: number | null;
  duration: number;
}

export interface InputAnalysis {
  path: string;
  fileSize: number;
  modifiedMs: number;
  container: string;
  majorBrand: string | null;
  /** Video duration in seconds (container duration when the stream has none). */
  duration: number;
  /** Container origin: ffmpeg rebases every stream relative to this. */
  startTime: number;
  video: VideoInfo;
  audioTracks: AudioTrack[];
  subtitleTracks: SubtitleTrack[];
  /** Index into audioTracks of the track that will be used (default-marked, else first), or null. */
  selectedAudio: number | null;
}

interface ProbeStream {
  index: number;
  codec_type?: string;
  codec_name?: string;
  profile?: string;
  width?: number;
  height?: number;
  sample_aspect_ratio?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  time_base?: string;
  pix_fmt?: string;
  field_order?: string;
  color_space?: string;
  color_transfer?: string;
  color_primaries?: string;
  color_range?: string;
  sample_rate?: string;
  channels?: number;
  channel_layout?: string;
  start_time?: string;
  duration?: string;
  nb_frames?: string;
  nb_read_packets?: string;
  disposition?: Record<string, number>;
  tags?: Record<string, string>;
  side_data_list?: Record<string, unknown>[];
}

interface ProbeOutput {
  streams?: ProbeStream[];
  format?: { format_name?: string; duration?: string; start_time?: string; tags?: Record<string, string> };
}

export function parseRational(value: string | undefined, fallback: Rational = { num: 0, den: 1 }): Rational {
  const m = /^(-?\d+)[/:](\d+)$/.exec(value ?? '');
  if (!m) return fallback;
  const num = Number(m[1]);
  const den = Number(m[2]);
  return den ? { num, den } : fallback;
}

const rationalValue = (r: Rational) => (r.den ? r.num / r.den : 0);
const numberOrNull = (v: string | undefined) => (v === undefined || v === 'N/A' || !Number.isFinite(Number(v)) ? null : Number(v));

const SDR_TRANSFERS = new Set(['unknown', 'bt709', 'smpte170m', 'bt470bg', 'bt470m', 'gamma22', 'gamma28', 'smpte240m', 'iec61966-2-1', 'iec61966-2-4', 'bt2020-10', 'bt2020-12']);

export function classifyHdr(stream: ProbeStream): HdrInfo {
  const dovi = stream.side_data_list?.find((d) => /DOVI configuration/i.test(String(d.side_data_type ?? '')));
  if (dovi) {
    const profile = typeof dovi.dv_profile === 'number' ? dovi.dv_profile : null;
    const compatibilityId = typeof dovi.dv_bl_signal_compatibility_id === 'number' ? dovi.dv_bl_signal_compatibility_id : null;
    const baseLayer = compatibilityId === 1 ? 'hdr10' : compatibilityId === 2 ? 'sdr' : compatibilityId === 4 ? 'hlg' : 'none';
    return { kind: 'dolby-vision', dolbyVision: { profile, compatibilityId, baseLayer } };
  }
  if (stream.color_transfer === 'smpte2084') return { kind: 'hdr10', dolbyVision: null };
  if (stream.color_transfer === 'arib-std-b67') return { kind: 'hlg', dolbyVision: null };
  if (stream.color_primaries === 'bt2020') return { kind: 'bt2020-sdr', dolbyVision: null };
  // Anything that is not a known SDR transfer is not guessed at.
  if (stream.color_transfer && !SDR_TRANSFERS.has(stream.color_transfer)) return { kind: 'unknown', dolbyVision: null };
  return { kind: 'sdr', dolbyVision: null };
}

/**
 * Variable frame rate: r_frame_rate and avg_frame_rate disagree, or packet durations spread.
 * CFR streams in coarse time bases alternate by one tick (e.g. 512/513), well under 5%.
 */
export type Scan = 'progressive' | 'tff' | 'bff' | 'unknown';

/**
 * Scan from the first decoded frames' own flags (what the filters and the encoder see); the stream's
 * field_order only when no frame could be read. Its tb / bt codes mean the opposite field order in
 * different demuxers (MPEG-2 and MOV write tb for top field first), so only tt / bb / progressive are used.
 */
export function scanOf(frames: { interlaced: boolean; topFirst: boolean }[], fieldOrder: string | null | undefined): Scan {
  if (frames.length) {
    const interlaced = frames.filter((f) => f.interlaced);
    if (2 * interlaced.length <= frames.length) return 'progressive';
    return 2 * interlaced.filter((f) => f.topFirst).length >= interlaced.length ? 'tff' : 'bff';
  }
  return fieldOrder === 'progressive' ? 'progressive' : fieldOrder === 'tt' ? 'tff' : fieldOrder === 'bb' ? 'bff' : 'unknown';
}

export function detectVariableFrameRate(r: Rational, avg: Rational, packetPts: number[]): boolean {
  const rv = rationalValue(r);
  const av = rationalValue(avg);
  if (rv > 0 && av > 0 && Math.abs(rv - av) / rv > 0.005) return true;
  const pts = [...packetPts].sort((a, b) => a - b);
  const deltas: number[] = [];
  for (let i = 1; i < pts.length; i++) deltas.push((pts[i] ?? 0) - (pts[i - 1] ?? 0));
  if (deltas.length < 3) return false;
  const sorted = [...deltas].sort((a, b) => a - b);
  const median = sorted[sorted.length >> 1] ?? 0;
  if (median <= 0) return true;
  const off = deltas.filter((d) => Math.abs(d - median) / median > 0.05).length;
  return off / deltas.length > 0.01;
}

export async function analyzeInput(
  inputPath: string,
  toolchain: Toolchain,
  options: { signal?: AbortSignal; log?: LogSink } = {},
): Promise<InputAnalysis> {
  const absolute = path.resolve(inputPath);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absolute);
    fs.accessSync(absolute, fs.constants.R_OK);
  } catch (cause) {
    throw new ConversionError('INPUT_ERROR', 'Input file cannot be read', { reason: 'UNREADABLE', cause });
  }
  if (!stat.isFile()) throw new ConversionError('INPUT_ERROR', 'Input is not a file', { reason: 'NOT_A_FILE' });
  if (path.extname(absolute).toLowerCase() !== '.mp4') {
    throw new ConversionError('INPUT_ERROR', 'Input must be an .mp4 file', { reason: 'NOT_MP4' });
  }

  const run = { errorCode: 'INPUT_ERROR' as const, signal: options.signal, log: options.log };
  let probe: ProbeOutput;
  try {
    const r = await runTool(toolchain.ffprobe, ['-v', 'error', '-count_packets', '-show_format', '-show_streams', '-of', 'json', absolute], run);
    probe = JSON.parse(r.stdout) as ProbeOutput;
  } catch (error) {
    if (error instanceof ConversionError && error.code !== 'INPUT_ERROR') throw error;
    throw new ConversionError('INPUT_ERROR', 'Input could not be read as MP4', {
      reason: 'UNREADABLE_MEDIA',
      detail: error instanceof ConversionError ? error.detail : String(error),
    });
  }

  const format = probe.format ?? {};
  const container = format.format_name ?? '';
  const majorBrand = format.tags?.major_brand?.trim() ?? null;
  if (!/\bmp4\b/.test(container) || majorBrand === 'qt') {
    throw new ConversionError('INPUT_ERROR', 'Input is not an MP4 container', { reason: 'NOT_MP4' });
  }
  const streams = probe.streams ?? [];
  const v = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  if (!v) throw new ConversionError('INPUT_ERROR', 'Input has no video stream', { reason: 'NO_VIDEO' });
  if (!v.width || !v.height) throw new ConversionError('INPUT_ERROR', 'Video size is unknown', { reason: 'NO_VIDEO_SIZE' });

  const audioStreams = streams.filter((s) => s.codec_type === 'audio');
  const audioTracks: AudioTrack[] = audioStreams.map((s) => ({
    index: s.index,
    codec: s.codec_name ?? 'unknown',
    sampleRate: Number(s.sample_rate ?? 0),
    channels: s.channels ?? 0,
    channelLayout: s.channel_layout ?? null,
    default: Boolean(s.disposition?.default),
    startTime: numberOrNull(s.start_time),
    duration: numberOrNull(s.duration),
  }));
  const defaultIndex = audioTracks.findIndex((t) => t.default);
  const selectedAudio = audioTracks.length === 0 ? null : defaultIndex >= 0 ? defaultIndex : 0;

  // Truncated MP4s with the moov atom first still probe fine: compare declared and readable samples.
  const selectedAudioStream = selectedAudio === null ? undefined : audioStreams[selectedAudio];
  for (const s of [v, selectedAudioStream]) {
    if (!s) continue;
    const declared = Number(s.nb_frames ?? 0);
    const read = Number(s.nb_read_packets ?? 0);
    if (declared > 0 && read < declared) {
      throw new ConversionError('INPUT_ERROR', 'Input MP4 is incomplete', {
        reason: 'TRUNCATED',
        detail: `${s.codec_type} has ${read} of ${declared} samples`,
      });
    }
  }

  const duration = numberOrNull(v.duration) ?? numberOrNull(format.duration);
  if (duration === null || duration <= 0) throw new ConversionError('INPUT_ERROR', 'Input duration is unknown', { reason: 'NO_DURATION' });

  const rotationData = v.side_data_list?.find((d) => typeof d.rotation === 'number');
  const rotation = typeof rotationData?.rotation === 'number' ? rotationData.rotation : 0;
  const sar = parseRational(v.sample_aspect_ratio, { num: 1, den: 1 });
  const sarValue = sar.num > 0 ? sar.num / sar.den : 1;
  const rotated = Math.abs(rotation) % 180 === 90;
  // ffmpeg's autorotate transposes the frame; sample aspect follows the frame axes.
  const displayAspectRatio = rotated ? v.height / (v.width * sarValue) : (v.width * sarValue) / v.height;

  const rFrameRate = parseRational(v.r_frame_rate);
  const avgFrameRate = parseRational(v.avg_frame_rate);
  const packets = await runTool(toolchain.ffprobe, ['-v', 'error', '-select_streams', `${v.index}`, '-show_entries', 'packet=pts', '-of', 'csv=p=0', absolute], run);
  const pts = packets.stdout.split('\n').map((l) => l.trim()).filter((l) => l !== '' && l !== 'N/A').map(Number);
  const isVariableFrameRate = detectVariableFrameRate(rFrameRate, avgFrameRate, pts);
  const frameRate = rationalValue(avgFrameRate) || rationalValue(rFrameRate);

  // Basic decodability of the first seconds (full decode is not needed to plan).
  await runTool(toolchain.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-xerror', '-t', '2', '-i', absolute, '-map', `0:${v.index}`, '-f', 'null', '-'], run)
    .catch((error: unknown) => {
      if (error instanceof ConversionError && error.code === 'CANCELLED') throw error;
      throw new ConversionError('INPUT_ERROR', 'Input video could not be decoded', {
        reason: 'UNDECODABLE',
        detail: error instanceof ConversionError ? error.detail : String(error),
      });
    });

  const flags = await runTool(toolchain.ffprobe, ['-v', 'error', '-select_streams', `${v.index}`, '-read_intervals', '%+#30',
    '-show_entries', 'frame=interlaced_frame,top_field_first', '-of', 'csv=p=0', absolute], run)
    .then((r) => r.stdout.split('\n').map((l) => l.split(',')).filter((c) => c.length >= 2).map((c) => ({ interlaced: c[0] === '1', topFirst: c[1] === '1' })))
    .catch((error: unknown) => {
      if (error instanceof ConversionError && error.code === 'CANCELLED') throw error;
      return [];
    });

  const startTimes = [v, ...audioStreams].map((s) => numberOrNull(s.start_time)).filter((n): n is number => n !== null);
  return {
    path: absolute,
    fileSize: stat.size,
    modifiedMs: stat.mtimeMs,
    container,
    majorBrand,
    duration,
    startTime: numberOrNull(format.start_time) ?? (startTimes.length ? Math.min(...startTimes) : 0),
    video: {
      index: v.index,
      codec: v.codec_name ?? 'unknown',
      profile: v.profile ?? null,
      width: v.width,
      height: v.height,
      sampleAspectRatio: sar,
      displayAspectRatio,
      frameRate,
      rFrameRate,
      avgFrameRate,
      isVariableFrameRate,
      frameCount: numberOrNull(v.nb_read_packets) ?? numberOrNull(v.nb_frames),
      pixelFormat: v.pix_fmt ?? null,
      fieldOrder: v.field_order ?? null,
      scan: scanOf(flags, v.field_order),
      color: {
        space: v.color_space ?? null,
        transfer: v.color_transfer ?? null,
        primaries: v.color_primaries ?? null,
        range: v.color_range ?? null,
      },
      rotation,
      hdr: classifyHdr(v),
      startTime: numberOrNull(v.start_time),
      duration,
    },
    audioTracks,
    subtitleTracks: streams
      .filter((s) => s.codec_type === 'subtitle')
      .map((s) => ({ index: s.index, codec: s.codec_name ?? 'unknown', language: s.tags?.language ?? null })),
    selectedAudio,
  };
}
