// Analysis -> ConversionPlan. The plan is plain serializable data a GUI can show before converting.

import crypto from 'node:crypto';
import path from 'node:path';
import type { InputAnalysis } from './analyze.ts';
import { LOW_VIDEO_KBPS, MIN_VIDEO_KBPS, diskRequirement, expectedStreamBytes, type DiskRequirement, videoBitrateKbps } from './capacity.ts';
import { outputBaseName, volumeLabel } from './naming.ts';
import { planAudio, type AudioPlan } from './profile/audio.ts';
import { INTERLACED_POLICY, classifyFrameRate, type FrameRatePolicy } from './profile/frame-rate.ts';
import { planVideo, type VideoPlan } from './profile/video.ts';

export type PlanIssueCode =
  // warnings (conversion may proceed after the user accepts)
  | 'LOW_BITRATE'
  | 'NO_AUDIO'
  | 'SUBTITLES_NOT_INCLUDED'
  | 'MULTIPLE_AUDIO_TRACKS'
  | 'DOWNMIX_TO_STEREO'
  | 'VARIABLE_FRAME_RATE'
  | 'HDR_TONEMAP_EXPERIMENTAL'
  | 'DOLBY_VISION_BASE_LAYER'
  // errors (conversion refused)
  | 'TOO_LONG'
  | 'UNSUPPORTED_AUDIO_LAYOUT'
  | 'UNSUPPORTED_HDR'
  | 'HDR_DISABLED';

export interface PlanIssue {
  code: PlanIssueCode;
  data?: Record<string, string | number>;
}

export interface ConversionPlan {
  schema: 1;
  input: {
    path: string;
    fileSize: number;
    modifiedMs: number;
    /** Video stream duration, seconds. */
    duration: number;
    /** Container origin (every stream is rebased to it). */
    origin: number;
    /** End of the video / selected audio on the origin-relative timeline; the DVD streams start at 0. */
    videoEnd: number;
    audioEnd: number | null;
  };
  output: {
    /**
     * Parent directory, symlinks resolved (what the user is shown is where the files go); the final
     * folder is `<directory>/<name>` or `<name>-N` if taken.
     */
    directory: string;
    /**
     * device:inode of `directory` when planned (null if it did not exist yet). Part of the plan digest,
     * so a folder replaced or re-pointed after the user saw the plan stops the conversion.
     */
    directoryId: string | null;
    name: string;
    isoFileName: string;
    volumeLabel: string;
  };
  video: VideoPlan;
  audio: AudioPlan | null;
  expected: { streamBytes: number; disk: DiskRequirement };
  warnings: PlanIssue[];
  errors: PlanIssue[];
}

export interface PlanOptions {
  /** Defaults to the input's directory. */
  outputDirectory?: string;
  frameRatePolicy?: FrameRatePolicy;
  /** 'experimental' (default) tone maps HDR10/HLG with a warning; 'reject' refuses HDR input. */
  hdr?: 'experimental' | 'reject';
}

/** `directoryId`: see ConversionPlan.output (the job resolves the folder; see job.ts planFor). */
export function planConversion(analysis: InputAnalysis, options: PlanOptions = {}, directoryId: string | null = null): ConversionPlan {
  const warnings: PlanIssue[] = [];
  const errors: PlanIssue[] = [];
  const policy = options.frameRatePolicy ?? INTERLACED_POLICY;

  const video = analysis.video;
  const frameRate = policy.decide(classifyFrameRate(video.frameRate, video.isVariableFrameRate));
  if (video.isVariableFrameRate) warnings.push({ code: 'VARIABLE_FRAME_RATE', data: { averageFps: round(video.frameRate, 3) } });

  const videoKbps = videoBitrateKbps(analysis.duration);
  if (videoKbps < MIN_VIDEO_KBPS) errors.push({ code: 'TOO_LONG', data: { videoKbps, minimumKbps: MIN_VIDEO_KBPS } });
  else if (videoKbps < LOW_VIDEO_KBPS) warnings.push({ code: 'LOW_BITRATE', data: { videoKbps, thresholdKbps: LOW_VIDEO_KBPS } });

  const videoPlan = planVideo(video, frameRate, Math.max(videoKbps, 0));
  const hdr = videoPlan.hdr;
  if (hdr.strategy === 'unsupported') errors.push({ code: 'UNSUPPORTED_HDR', data: { kind: hdr.kind } });
  else if (hdr.strategy === 'tonemap-experimental') {
    if (options.hdr === 'reject') errors.push({ code: 'HDR_DISABLED', data: { kind: hdr.kind } });
    else warnings.push({ code: 'HDR_TONEMAP_EXPERIMENTAL', data: { kind: hdr.kind } });
  }
  if (hdr.kind === 'dolby-vision' && hdr.strategy !== 'unsupported') {
    warnings.push({ code: 'DOLBY_VISION_BASE_LAYER', data: { baseLayer: video.hdr.dolbyVision?.baseLayer ?? 'none' } });
  }

  const track = analysis.selectedAudio === null ? null : (analysis.audioTracks[analysis.selectedAudio] ?? null);
  const audioResult = planAudio(track);
  let audio: AudioPlan | null = null;
  if (audioResult.ok) {
    audio = audioResult.plan;
    if (audio.strategy === 'silence') warnings.push({ code: 'NO_AUDIO' });
    if (audio.strategy === 'downmix-5.1') warnings.push({ code: 'DOWNMIX_TO_STEREO', data: { channels: audio.source?.channels ?? 0 } });
  } else {
    errors.push({ code: 'UNSUPPORTED_AUDIO_LAYOUT', data: { detail: audioResult.detail } });
  }
  if (analysis.audioTracks.length > 1) warnings.push({ code: 'MULTIPLE_AUDIO_TRACKS', data: { tracks: analysis.audioTracks.length, selected: analysis.selectedAudio ?? 0 } });
  if (analysis.subtitleTracks.length > 0) warnings.push({ code: 'SUBTITLES_NOT_INCLUDED', data: { tracks: analysis.subtitleTracks.length } });

  const streamBytes = expectedStreamBytes(Math.max(videoKbps, 0), analysis.duration);
  const frames = Math.ceil(analysis.duration * 30000 / 1001);
  const name = outputBaseName(analysis.path);
  return {
    schema: 1,
    input: {
      path: analysis.path,
      fileSize: analysis.fileSize,
      modifiedMs: analysis.modifiedMs,
      duration: analysis.duration,
      origin: analysis.startTime,
      videoEnd: (video.startTime ?? analysis.startTime) - analysis.startTime + analysis.duration,
      audioEnd: track?.duration != null ? (track.startTime ?? analysis.startTime) - analysis.startTime + track.duration : null,
    },
    output: {
      directory: path.resolve(options.outputDirectory ?? path.dirname(analysis.path)),
      directoryId,
      name,
      isoFileName: `${name}.iso`,
      volumeLabel: volumeLabel(analysis.path),
    },
    video: videoPlan,
    audio,
    expected: { streamBytes, disk: diskRequirement(streamBytes, frames) },
    warnings,
    errors,
  };
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/**
 * Identifies a plan the user accepted. convert() never takes a plan from its caller: it plans again
 * from its own analysis and refuses to start when that plan's digest differs (the input or the output
 * folder changed, or the caller sent something else).
 */
export function planDigest(plan: ConversionPlan): string {
  return crypto.createHash('sha256').update(JSON.stringify(plan)).digest('hex');
}
