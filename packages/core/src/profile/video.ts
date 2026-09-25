// Video plan: NTSC MPEG-2 720x480 DVD 16:9, aspect kept with scale + pad (no crop, no stretch).

import type { HdrInfo, VideoInfo } from '../analyze.ts';
import { VIDEO_MAXRATE_KBPS } from '../capacity.ts';
import type { FrameRateDecision } from './frame-rate.ts';

export const DVD_WIDTH = 720;
export const DVD_HEIGHT = 480;
const DVD_ASPECT = 16 / 9;

export interface ActiveArea {
  width: number;
  height: number;
  x: number;
  y: number;
}

/** Fit a display aspect into the 16:9 DVD frame (720x480 with SAR 32:27). Even sizes and offsets. */
export function fitActiveArea(displayAspectRatio: number): ActiveArea {
  const even = (n: number) => 2 * Math.trunc(n / 2);
  let width = DVD_WIDTH;
  let height = DVD_HEIGHT;
  if (displayAspectRatio >= DVD_ASPECT - 0.001) height = even(DVD_HEIGHT * DVD_ASPECT / displayAspectRatio);
  else width = even(DVD_WIDTH * displayAspectRatio / DVD_ASPECT);
  width = Math.max(2, width);
  height = Math.max(2, height);
  return { width, height, x: even((DVD_WIDTH - width) / 2), y: even((DVD_HEIGHT - height) / 2) };
}

export type HdrStrategy = 'none' | 'tonemap-experimental' | 'unsupported';

export interface HdrPlan {
  kind: HdrInfo['kind'];
  strategy: HdrStrategy;
  note: string | null;
}

export function planHdr(hdr: HdrInfo): HdrPlan {
  switch (hdr.kind) {
    case 'sdr':
      return { kind: hdr.kind, strategy: 'none', note: null };
    case 'hdr10':
    case 'hlg':
      return { kind: hdr.kind, strategy: 'tonemap-experimental', note: `${hdr.kind} to SDR tone mapping has not been validated with real footage` };
    case 'dolby-vision': {
      const base = hdr.dolbyVision?.baseLayer ?? 'none';
      if (base === 'sdr') return { kind: hdr.kind, strategy: 'none', note: 'Dolby Vision: SDR base layer used' };
      if (base === 'hdr10' || base === 'hlg') {
        return { kind: hdr.kind, strategy: 'tonemap-experimental', note: `Dolby Vision: ${base} base layer tone mapped (not validated)` };
      }
      return { kind: hdr.kind, strategy: 'unsupported', note: 'Dolby Vision without a compatible base layer' };
    }
    case 'bt2020-sdr':
      return { kind: hdr.kind, strategy: 'unsupported', note: 'BT.2020 SDR input is not handled' };
    case 'unknown':
      return { kind: hdr.kind, strategy: 'unsupported', note: 'Unrecognised transfer characteristics' };
  }
}

/** Experimental HDR -> SDR BT.709 (docs/poc.md §9.10). zscale needs libzimg; tonemap is LGPL. */
export const TONEMAP_FILTER =
  'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p';

export interface VideoPlan {
  /** ffprobe stream index of the source video. */
  sourceIndex: number;
  width: typeof DVD_WIDTH;
  height: typeof DVD_HEIGHT;
  displayAspect: '16:9';
  sampleAspect: '32:27';
  active: ActiveArea;
  inputColorMatrix: 'bt709' | 'bt601';
  hdr: HdrPlan;
  frameRate: FrameRateDecision;
  bitrateKbps: number;
  maxrateKbps: number;
  bufsizeBits: number;
  gopFrames: number;
  bFrames: number;
  /** Complete ffmpeg -vf chain. */
  filter: string;
}

export function inputColorMatrix(video: VideoInfo): 'bt709' | 'bt601' {
  const space = video.color.space;
  if (space === 'bt709') return 'bt709';
  if (space === 'smpte170m' || space === 'bt470bg') return 'bt601';
  return video.height >= 720 || video.width >= 1280 ? 'bt709' : 'bt601'; // untagged: assume by size
}

function lastFrameHold(video: VideoInfo): number {
  const r = video.isVariableFrameRate ? video.rFrameRate.num / (video.rFrameRate.den || 1) : video.frameRate;
  return 1 / (r > 0 ? r : 30000 / 1001);
}

export function planVideo(video: VideoInfo, frameRate: FrameRateDecision, bitrateKbps: number): VideoPlan {
  const active = fitActiveArea(video.displayAspectRatio);
  const hdr = planHdr(video.hdr);
  const tonemapped = hdr.strategy === 'tonemap-experimental';
  const matrix = tonemapped ? 'bt709' : inputColorMatrix(video);
  // Interlaced input (M-5): the two fields of a frame are different moments. The 29.97/30 strategies
  // pass whole frames, so they keep the fields: each field is scaled on its own and the first one goes
  // on top (the DVD is top field first). The others build their output from moments, so the fields
  // become frames first, one per field. Progressive and unknown input are unchanged.
  const interlaced = video.scan === 'tff' || video.scan === 'bff';
  const keepsFields = interlaced && (frameRate.strategy === 'passthrough-29.97' || frameRate.strategy === 'decimate-30');
  const filter = [
    interlaced && !keepsFields ? 'estdif=mode=field:parity=auto:deint=all' : null,
    tonemapped ? TONEMAP_FILTER : null,
    // Moving the first field to the top shifts the picture by one line: at the source's resolution.
    keepsFields && video.scan === 'bff' ? 'fieldorder=tff' : null,
    `scale=${active.width}:${active.height}:in_color_matrix=${matrix}:out_color_matrix=bt601:out_range=tv:flags=lanczos${keepsFields ? ':interl=1' : ''}`,
    `pad=${DVD_WIDTH}:${DVD_HEIGHT}:${active.x}:${active.y}:black`,
    // The fps filter ends the stream at the last frame's start and drops that frame; holding the
    // last frame for one source frame duration keeps it (verified for every strategy).
    `tpad=stop_mode=clone:stop_duration=${lastFrameHold(video).toFixed(6)}`,
    frameRate.filter,
    'setsar=32/27',
    'format=yuv420p',
  ].filter(Boolean).join(',');
  return {
    sourceIndex: video.index,
    width: DVD_WIDTH,
    height: DVD_HEIGHT,
    displayAspect: '16:9',
    sampleAspect: '32:27',
    active,
    inputColorMatrix: matrix,
    hdr,
    frameRate,
    bitrateKbps,
    maxrateKbps: VIDEO_MAXRATE_KBPS,
    bufsizeBits: 1_835_008,
    gopFrames: 18,
    bFrames: 2,
    filter,
  };
}
