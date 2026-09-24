// Terminal text: plan summary, warnings, errors, progress and results. Presentation only; every
// decision comes from the core's plan, errors and events.

import path from 'node:path';
import type {
  ConversionError, ConversionPhase, ConversionPlan, ConversionResult, InputAnalysis, PlanIssue, ProgressEvent, ToolchainReport,
} from '@mp4-to-ifo/core';

export interface Output {
  write(text: string): void;
  isTTY?: boolean;
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}

export function formatFps(fps: number): string {
  if (Math.abs(fps - Math.round(fps)) < 0.005) return String(Math.round(fps));
  return fps.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

function formatBytes(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

const kbps = (n: number) => `${n.toLocaleString('en-US')} kbps`;

function channels(n: number, layout: string | null): string {
  if (n === 1) return 'Mono';
  if (n === 2) return 'Stereo';
  if (n === 6 && layout?.startsWith('5.1')) return '5.1';
  if (layout && /^\d/.test(layout)) return `${layout} (${n} channels)`;
  return `${n} channels${layout ? ` (${layout})` : ''}`;
}

const FRAME_RATE: Record<string, string> = {
  'passthrough-29.97': '29.97 fps',
  'decimate-30': '29.97 fps (from 30 fps)',
  'telecine-3-2': '29.97 fps, 3:2 pulldown',
  'interlace-60i': '59.94i (interlaced)',
  'progressive-29.97': '29.97 fps (progressive)',
};

const AUDIO: Record<string, string> = {
  stereo: 'Stereo → AC-3 Stereo',
  'mono-to-stereo': 'Mono → AC-3 Stereo',
  'downmix-5.1': '5.1 → AC-3 Stereo',
  silence: 'None → Silent AC-3 Stereo',
};

export function summary(analysis: InputAnalysis, plan: ConversionPlan, outputFolder: string, verbose: boolean): string {
  const v = analysis.video;
  const track = analysis.selectedAudio === null ? null : analysis.audioTracks[analysis.selectedAudio];
  const fps = v.isVariableFrameRate ? `variable frame rate (average ${formatFps(v.frameRate)} fps)` : `${formatFps(v.frameRate)} fps`;
  const displayed = Math.abs(v.rotation) % 180 === 90 ? `${v.height}×${v.width}` : `${v.width}×${v.height}`;
  const inputAudio = track ? `${channels(track.channels, track.channelLayout)} (${track.codec.toUpperCase()})` : 'No audio';
  const hdr = plan.video.hdr.kind === 'sdr' ? '' : ` · ${hdrName(plan.video.hdr.kind)}`;
  const lines = [
    'Input',
    `  ${path.basename(analysis.path)}`,
    `  ${displayed} · ${fps} · ${formatDuration(analysis.duration)}${hdr}`,
    `  Audio: ${inputAudio}`,
    '',
    'DVD',
    `  NTSC 16:9 · 720×480 · MPEG-2 · ${FRAME_RATE[plan.video.frameRate.strategy] ?? plan.video.frameRate.strategy}`,
    `  Audio: ${plan.audio ? `${AUDIO[plan.audio.strategy] ?? plan.audio.strategy} · ${plan.audio.bitrateKbps} kbps` : 'not supported'}`,
    '',
    'Estimated size',
    `  Up to ${formatBytes(plan.expected.streamBytes)} each for VIDEO_TS, VIDEO_TS.zip and the ISO`,
    '',
    'Output',
    `  ${outputFolder}${path.sep}`,
  ];
  if (verbose) {
    lines.push(
      '',
      'Details',
      `  Frame rate strategy: ${plan.video.frameRate.strategy} (input class ${plan.video.frameRate.inputClass})`,
      `  Video bitrate: ${kbps(plan.video.bitrateKbps)} average, ${kbps(plan.video.maxrateKbps)} maximum, 2-pass`,
      `  Picture: ${plan.video.active.width}×${plan.video.active.height} at ${plan.video.active.x},${plan.video.active.y} in 720×480 · input colour ${plan.video.inputColorMatrix}`,
      `  HDR: ${plan.video.hdr.kind} → ${plan.video.hdr.strategy}`,
      `  Audio strategy: ${plan.audio?.strategy ?? 'none'}${plan.audio?.matrix ? ` · ${plan.audio.matrix}` : ''}${plan.audio?.clipGuardCeilingDbfs != null ? ` · peak limit ${plan.audio.clipGuardCeilingDbfs} dBFS` : ''}`,
      `  Disk space needed: ${formatBytes(plan.expected.disk.temp)} temporary, ${formatBytes(plan.expected.disk.output)} in the output folder`,
      `  Volume label: ${plan.output.volumeLabel}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

function hdrName(kind: string): string {
  return ({ hdr10: 'HDR10', hlg: 'HLG', 'dolby-vision': 'Dolby Vision', 'bt2020-sdr': 'BT.2020', unknown: 'unrecognised colour format' } as Record<string, string>)[kind] ?? kind;
}

export function warningText(issue: PlanIssue): string {
  const d = issue.data ?? {};
  switch (issue.code) {
    case 'LOW_BITRATE':
      return `The calculated video bitrate is ${kbps(Number(d.videoKbps))}.\nVideo quality may be reduced. Shorter videos give higher quality on a single-layer DVD.`;
    case 'NO_AUDIO':
      return 'The MP4 has no audio. The DVD will have a silent audio track.';
    case 'SUBTITLES_NOT_INCLUDED':
      return 'Subtitle tracks are not included in the DVD output.\nSubtitles that are part of the picture are kept.';
    case 'MULTIPLE_AUDIO_TRACKS':
      return `The MP4 has ${d.tracks} audio tracks. Only audio track ${Number(d.selected) + 1} is used.`;
    case 'DOWNMIX_TO_STEREO':
      return '5.1 audio will be mixed down to stereo.';
    case 'VARIABLE_FRAME_RATE':
      return `The video has a variable frame rate (average ${d.averageFps} fps).\nIt will be converted to the constant DVD frame rate.`;
    case 'HDR_TONEMAP_EXPERIMENTAL':
      return `HDR video detected (${hdrName(String(d.kind))}).\nMP4 to IFO will convert HDR to SDR. HDR conversion is experimental.`;
    case 'DOLBY_VISION_BASE_LAYER':
      return `Dolby Vision detected. Only its ${d.baseLayer === 'sdr' ? 'SDR' : hdrName(String(d.baseLayer))} base layer is used.`;
    default:
      return issue.code;
  }
}

/** Plan errors (the conversion cannot start). */
export function planErrorText(issue: PlanIssue): string {
  const d = issue.data ?? {};
  switch (issue.code) {
    case 'TOO_LONG':
      return 'The video is too long to fit on a single-layer DVD in usable quality.';
    case 'UNSUPPORTED_AUDIO_LAYOUT': {
      const m = /^(\d+) channels, layout (.+)$/.exec(String(d.detail ?? ''));
      const layout = m?.[2] && m[2] !== 'unknown' ? m[2] : null;
      const name = layout && /^\d/.test(layout) ? `${layout}-channel` : `${m?.[1] ?? 'multi'}-channel${layout ? ` (${layout})` : ''}`;
      return `${name} audio is not supported in this version.\nSupported audio: stereo, mono, 5.1, or no audio.`;
    }
    case 'UNSUPPORTED_HDR':
      if (d.kind === 'dolby-vision') return 'Dolby Vision video without a compatible base layer (such as Profile 5) is not supported.';
      if (d.kind === 'bt2020-sdr') return 'BT.2020 SDR video is not supported in this version.';
      return 'The video uses an unrecognised colour format and is not supported.';
    case 'HDR_DISABLED':
      return 'HDR video is not accepted.';
    default:
      return issue.code;
  }
}

/** Human-readable message for a core error. */
export function errorText(error: ConversionError | Error, plan: ConversionPlan | null): string {
  const e = error as ConversionError;
  const reason = e.reason ?? '';
  switch (e.code) {
    case 'INPUT_ERROR': {
      const planIssue = plan?.errors.find((i) => reason.split(',').includes(i.code));
      if (planIssue) return planErrorText(planIssue);
      return ({
        TRUNCATED: 'The MP4 file appears to be incomplete or damaged.',
        UNREADABLE_MEDIA: 'The file could not be read as an MP4 video. It may be damaged.',
        UNDECODABLE: 'The video in the MP4 file could not be decoded. It may be damaged.',
        NOT_MP4: 'The input must be an MP4 file (.mp4).',
        UNREADABLE: 'The input file cannot be read. Check that it exists and that you have permission to read it.',
        NOT_A_FILE: 'The input is not a file.',
        NO_VIDEO: 'The MP4 file has no video.',
        NO_VIDEO_SIZE: 'The video size could not be determined.',
        NO_DURATION: 'The video length could not be determined.',
        PLAN_CHANGED: 'The input file changed after it was analyzed. Run the command again.',
      } as Record<string, string>)[reason] ?? 'The input cannot be converted.';
    }
    case 'PREFLIGHT_ERROR':
      switch (reason) {
        case 'LOCKED':
          return 'Another MP4 to IFO conversion is already running for this user.\nWait for it to finish, then try again.';
        case 'TOOL_MISSING':
          return `${e.message}.\n\nMP4 to IFO requires ffmpeg, ffprobe, and dvdauthor. Make sure they are installed and on your PATH.`;
        case 'TOOL_FEATURES':
          return `The installed ffmpeg lacks features MP4 to IFO needs (${e.detail ?? ''}).`;
        case 'DISK_SPACE':
          return `Not enough disk space (${e.detail ?? ''}).`;
        case 'OUTPUT_NOT_WRITABLE':
          return 'The output folder cannot be written to.';
        default:
          return 'The conversion could not start.';
      }
    case 'ENCODE_ERROR':
      return 'Encoding the video failed.';
    case 'AUTHOR_ERROR':
      return 'Creating the DVD structure failed.';
    case 'ZIP_ERROR':
      return 'Creating VIDEO_TS.zip failed.';
    case 'ISO_ERROR':
      return 'Creating the ISO failed.';
    case 'OUTPUT_ERROR':
      return 'Writing the output failed. Check that the output drive is connected and has free space.';
    case 'VERIFY_ERROR':
      return 'The generated DVD did not pass verification, so no output was kept.';
    case 'CANCELLED':
      return 'Cancelled. No output was kept.';
    default:
      return 'An unexpected error occurred.';
  }
}

export function success(result: ConversionResult, verbose: boolean): string {
  const v = result.verification;
  const lines = [
    '',
    'DVD-Video created and verified.',
    '',
    'Output:',
    `  ${result.outputDir}${path.sep}`,
    '',
    'Files:',
    '  VIDEO_TS/',
    '  VIDEO_TS.zip',
    `  ${path.basename(result.isoPath)}`,
    '',
    (() => {
      const applicable = v.checks.filter((c) => c.status !== 'not_applicable').length;
      const passed = v.checks.filter((c) => c.status === 'passed').length;
      const unmeasured = v.checks.filter((c) => c.status === 'unmeasurable').length;
      return `Verification: passed (${passed} of ${applicable} checks${unmeasured ? `; ${unmeasured} could not be measured for this video` : ''})`;
    })(),
  ];
  if (verbose) {
    const unmeasured = v.checks.filter((c) => c.status === 'unmeasurable');
    if (unmeasured.length) lines.push(`  Not measured: ${unmeasured.map((c) => `${c.id} (${c.detail})`).join('; ')}`);
    const d = v.durations;
    const ms = (x: number | null) => (x === null ? '—' : `${x} ms`);
    lines.push(
      `  Duration: video ${d.video.toFixed(3)} s, audio ${d.audio.toFixed(3)} s (source ${d.expectedVideo.toFixed(3)} s)`,
      `  Timing: picture ${ms(v.videoTiming.errorMs)}, sound ${ms(v.audioTiming.errorMs)}, picture vs sound ${ms(v.relativeAvTiming.offsetMs)}` +
        ` · field motion ${v.fieldTemporal.coverage ?? '—'}`,
      `  Audio: ${result.audio.gainDb < 0 ? `attenuated ${result.audio.gainDb} dB to avoid clipping` : 'level unchanged'}`,
      `  Time: ${Object.entries(result.timingsMs).map(([k, ms]) => `${k} ${(ms / 1000).toFixed(1)} s`).join(', ')}`,
    );
  }
  lines.push(
    '',
    'Before submitting the DVD, burn the ISO to a disc and test it on a DVD player.',
    'Software verification cannot confirm that every DVD player will play the disc.',
  );
  return `${lines.join('\n')}\n`;
}

export function toolchainText(report: ToolchainReport): string {
  return [
    'Tools',
    `  ffmpeg ${report.ffmpeg.version} (${report.ffmpeg.license}) ${report.ffmpeg.path}`,
    `  ffprobe ${report.ffprobe.version} ${report.ffprobe.path}`,
    `  dvdauthor ${report.dvdauthor.version} ${report.dvdauthor.path}`,
    '',
  ].join('\n');
}

const LABELS: Record<ConversionPhase, string> = {
  ANALYZING: 'Preparing',
  PREFLIGHT: 'Checking',
  ENCODING_PASS_1: 'Encoding pass 1/2',
  ENCODING_PASS_2: 'Encoding pass 2/2',
  AUTHORING: 'Authoring DVD',
  CREATING_ZIP: 'Creating ZIP',
  CREATING_ISO: 'Creating ISO',
  VERIFYING: 'Verifying',
  FINALIZING: 'Finalizing',
  COMPLETED: 'Done.',
};

/**
 * Progress lines. TTY: one line per phase, updated in place (at most every 200 ms). Not a TTY:
 * plain lines at phase start and at 25/50/75% of long phases, no escape codes or carriage returns.
 */
export class ProgressView {
  private phase: ConversionPhase | null = null;
  private lastDraw = 0;
  private milestone = 0;
  private open = false;
  private readonly out: Output;
  private readonly now: () => number;

  constructor(out: Output, now: () => number = Date.now) {
    this.out = out;
    this.now = now;
  }

  update(e: ProgressEvent): void {
    const tty = Boolean(this.out.isTTY);
    if (e.phase !== this.phase) {
      this.endLine();
      this.phase = e.phase;
      this.milestone = 0;
      if (e.phase === 'COMPLETED') {
        this.out.write('Done.\n');
        return;
      }
      this.draw(e, tty);
      return;
    }
    if (tty) {
      if (this.now() - this.lastDraw >= 200) this.draw(e, true);
      return;
    }
    const pct = Math.floor((e.phaseProgress ?? 0) * 100);
    const next = [25, 50, 75].find((m) => m > this.milestone && pct >= m);
    if (next && (e.phase.startsWith('ENCODING') || e.phase === 'VERIFYING')) {
      this.milestone = next;
      this.out.write(`${this.text(e)}\n`);
    }
  }

  private text(e: ProgressEvent): string {
    const pct = e.phaseProgress !== null && e.phaseProgress > 0 ? ` ${Math.floor(e.phaseProgress * 100)}%` : '';
    const media = e.mediaTime !== undefined ? ` · ${formatDuration(e.mediaTime)}` : '';
    return `${LABELS[e.phase]}...${pct}${media}`;
  }

  private draw(e: ProgressEvent, tty: boolean): void {
    this.lastDraw = this.now();
    if (tty) {
      this.out.write(`\r\x1b[2K${this.text(e)}`);
      this.open = true;
    } else this.out.write(`${this.text(e)}\n`);
  }

  /** Finish an in-place line before other output. */
  endLine(): void {
    if (this.open) this.out.write('\n');
    this.open = false;
  }
}
